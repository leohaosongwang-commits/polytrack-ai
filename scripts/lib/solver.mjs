// 离线搜索器(原型):在游戏自己的确定性物理上,用"滚动时域 + 交叉熵(CEM)"规划 + "全程爬山打磨"找更快的圈速。
//
// 阶段 A(规划,mpc):从已提交快照出发,对未来 H 个动作(每个动作持续 seg 帧)做 CEM 随机射击,
//        取评分最高的计划,提交其前 commitN 个动作(WASM 线性内存快照),重复直到冲线。
// 阶段 B(打磨,polish):对整圈逐帧控制做局部变异(替换窗口 / 平移翻转边界),
//        每代并行评估一批候选,只要完成帧更小就接受。目标函数就是真正的圈速(完成帧数,1 帧 = 1 ms)。
//
// 评分(阶段 A,越大越好):
//   完成  : 1e6 - 完成帧
//   掉出  : -1e6 + 存活帧
//   其他  : 沿中线弧长 s + 速度项(速度 m/s x lookAhead 秒)- 偏离中线惩罚
import { buildProgress, buildProgressField } from './progress.mjs';

export const ACTIONS = [1, 9, 3, 4]; // W, W+左, W+右, 刹车(滑行/单独转向在原型里省略以缩小搜索空间)
export const ACTION_NAMES = { 0: '·', 1: 'W', 2: 'R', 3: 'WR', 4: 'S', 8: 'L', 9: 'WL' };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 把逐帧动作掩码转成游戏回放串需要的"翻转帧"列表(5 个键:up,right,down,left,reset) */
export function masksToToggles(masks) {
  const lists = [[], [], [], [], []]; const cur = [0, 0, 0, 0, 0];
  for (let f = 0; f < masks.length; f++) for (let k = 0; k < 5; k++) { const v = (masks[f] >> k) & 1; if (v !== cur[k]) { lists[k].push(f); cur[k] = v; } }
  return lists;
}

/** 翻转帧列表(5 键) -> 逐帧掩码,长度 n */
export function togglesToMasks(lists, n) {
  const m = new Uint8Array(n);
  lists.forEach((l, k) => { let on = 0, j = 0; for (let f = 0; f < n; f++) { while (j < l.length && l[j] <= f) { on ^= 1; j++; } if (on) m[f] |= 1 << k; } });
  return m;
}

/** 每 seg 帧一个动作 -> 逐帧掩码 */
export function expandActions(actions, seg, totalFrames) {
  const m = new Uint8Array(totalFrames);
  for (let f = 0; f < totalFrames; f++) m[f] = actions[Math.min(actions.length - 1, (f / seg) | 0)] ?? 0;
  return m;
}

export class Solver {
  /**
   * @param g        已启动的 Game(需 exposeTrack:true,customTrack 为目标赛道)
   * @param opts     {workers, seg, horizon, pop, iters, commitN, lookAhead, halfWidth, seed, log}
   */
  constructor(g, opts = {}) {
    this.g = g;
    this.o = { workers: 4, seg: 40, horizon: 20, segs: null, pop: 112, iters: 2, commitN: 8, lookAhead: 0.6, halfWidth: 8.5, offPenalty: 15, switchPenalty: 0.4, crashRate: 220, crashPenalty: 0, seed: 1, maxFrames: 45000, potential: 'polyline', stallFrames: 4000, stallMeters: 4, log: () => {}, ...opts };
    this.rng = mulberry32(this.o.seed);
  }
  async init() {
    const ti = await this.g.trackInfo();
    this.prog = this.o.potential === 'field' ? buildProgressField(ti) : buildProgress(ti);
    this.minY = this.prog.minY ?? this.prog.startY - 12;
    if (this.o.potential === 'field' && this.o.halfWidth === 8.5) this.o.halfWidth = 1.0; // 距离场的偏离量 = 离开可行驶格子的水平距离
    await this.g.makePool(this.o.workers);
    this.o.log(`赛道: 中线长度 ${this.prog.length.toFixed(0)} m, ${this.prog.nLevels} 个路点, 检查点 ${this.prog.checkpoints} 个; 评估 Worker ${this.o.workers} 个`);
  }

  /** 单个候选的评分 */
  score(r, plan) {
    const { lookAhead, halfWidth, offPenalty, switchPenalty } = this.o;
    let sw = 0; if (plan) for (let i = 1; i < plan.length; i++) if (plan[i] !== plan[i - 1]) sw++;
    if (r.fin >= 0) return 1e6 - r.fin;
    if (r.dead) return -1e6 + r.frames;
    let off = 0, crash = 0;
    if (this.v0 != null) { // 速度骤降(撞击)惩罚:相邻采样间的平均减速度 > crashRate km/h/s
      let pv = this.v0, pf = this.f0;
      for (const s of r.smp) { const dt = (s[0] - pf) / 1000; if (dt > 0 && (pv - s[1]) / dt > this.o.crashRate) crash++; pv = s[1]; pf = s[0]; }
    }
    for (const s of r.smp) { const q = this.prog.query(s[5], s[7], s[6], s[4]); if (q.d > halfWidth) off += q.d - halfWidth; }
    const e = r.last; const q = this.prog.query(e[5], e[7], e[6], e[4]);
    return q.s + (e[1] / 3.6) * lookAhead - offPenalty * off - (q.d > halfWidth ? offPenalty * (q.d - halfWidth) : 0) - switchPenalty * sw - this.o.crashPenalty * crash;
  }

  // ---------- 阶段 A:CEM 滚动时域规划 ----------
  async plan() {
    const { pop, iters, commitN, maxFrames } = this.o; const A = ACTIONS.length;
    const segs = this.o.segs ?? Array.from({ length: this.o.horizon }, () => this.o.seg); const horizon = segs.length; const total = segs.reduce((a, b) => a + b, 0);
    const smpAt = []; { let c = 0; for (const x of segs) { c += x; smpAt.push(c); } }
    let lastV = null; let rollbacks = 0; const committed = []; const durs = []; let frames = 0; let carry = null; let fin = -1; let step = 0;
    const t0 = Date.now();
    while (fin < 0 && frames < maxFrames) {
      // 初始分布:有上一轮计划就在其(平移后的)动作上放较大概率
      const probs = Array.from({ length: horizon }, (_, h) => {
        const p = new Float64Array(A).fill(1 / A);
        const want = carry && h < carry.length ? ACTIONS.indexOf(carry[h]) : -1;
        if (want >= 0) { for (let a = 0; a < A; a++) p[a] = a === want ? 0.55 : 0.45 / (A - 1); } else p[ACTIONS.indexOf(1)] = 0.4; // 默认偏向油门
        if (want < 0) { const rest = 0.6 / (A - 1); for (let a = 0; a < A; a++) if (ACTIONS[a] !== 1) p[a] = rest; }
        return p;
      });
      let best = null; this.v0 = lastV; this.f0 = frames;
      for (let it = 0; it < iters; it++) {
        const plans = []; const idx = [];
        if (carry && it === 0) { const p = carry.slice(0, horizon); while (p.length < horizon) p.push(1); plans.push(p); idx.push(p.map((a) => ACTIONS.indexOf(a))); }
        while (plans.length < pop) {
          const ix = probs.map((p) => { let u = this.rng(), a = 0; for (; a < A - 1; a++) { u -= p[a]; if (u <= 0) break; } return a; });
          idx.push(ix); plans.push(ix.map((a) => ACTIONS[a]));
        }
        const res = await this.g.evalBatch(plans, { segs, maxFrames: total, fromCommit: true, sampleAt: smpAt, minY: this.minY });
        const sc = res.map((r, i) => this.score(r, plans[i]));
        const order = sc.map((s, i) => i).sort((a, b) => sc[b] - sc[a]);
        if (!best || sc[order[0]] > best.score) best = { score: sc[order[0]], plan: plans[order[0]], res: res[order[0]] };
        const elite = order.slice(0, Math.max(4, Math.round(pop * 0.12)));
        for (let h = 0; h < horizon; h++) {
          const cnt = new Float64Array(A); for (const e of elite) cnt[idx[e][h]]++;
          for (let a = 0; a < A; a++) probs[h][a] = 0.65 * (cnt[a] / elite.length) + 0.35 * probs[h][a];
          const smooth = 0.02; let z = 0; for (let a = 0; a < A; a++) { probs[h][a] += smooth; z += probs[h][a]; } for (let a = 0; a < A; a++) probs[h][a] /= z;
        }
      }
      if (best.score < -5e5) { // 所有候选都掉出赛道:回退若干步(回退幅度逐次加大)并换一批随机数重新规划
        rollbacks++; if (rollbacks > 12 || !committed.length) throw new Error(`规划失败:帧 ${frames} 附近所有候选都掉出赛道(已回退 ${rollbacks - 1} 次)`);
        const back = Math.min(committed.length, commitN * 2 * rollbacks); // 回退 2*rollbacks 个提交步
        committed.length -= back; durs.length -= back;
        const c0 = committed.length ? await this.g.commit(committed, 1, durs, true) : await this.g.commit([], 1, null, true);
        frames = c0.frames; lastV = c0.last ? c0.last[1] : null; carry = null; fin = -1;
        this.o.log(`  [规划] 回退 ${back} 个动作(第 ${rollbacks} 次),回到帧 ${frames}`);
        continue;
      }
      const take = best.res.fin >= 0 ? best.plan.length : Math.min(commitN, best.plan.length);
      const acts = best.plan.slice(0, take);
      const c = await this.g.commit(acts, segs[0], segs.slice(0, acts.length));
      committed.push(...acts); durs.push(...segs.slice(0, acts.length)); frames = c.frames; fin = c.fin; lastV = c.last ? c.last[1] : lastV; carry = best.plan.slice(take);
      step++;
      this.partial = { committed: committed.slice(), durs: durs.slice(), frames, last: c.last };
      if (c.last && this.o.stallFrames) { // 停滞看门狗:最近 stallFrames 帧内进度增长不足 stallMeters => 快速失败(并保留现场供诊断)
        const q = this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]); (this.sHist ??= []).push([frames, q.s]);
        const old = this.sHist.find((h) => h[0] >= frames - this.o.stallFrames);
        if (old && frames >= this.o.stallFrames && q.s - old[1] < this.o.stallMeters && this.sHist[0][0] <= frames - this.o.stallFrames) throw Object.assign(new Error(`规划停滞:帧 ${frames} 前 ${this.o.stallFrames} 帧内进度只增加 ${(q.s - old[1]).toFixed(1)} m(s=${q.s.toFixed(0)}/${this.prog.length.toFixed(0)},位置 x=${c.last[5].toFixed(1)} y=${c.last[6].toFixed(1)} z=${c.last[7].toFixed(1)},车速 ${c.last[1].toFixed(0)} km/h)`), { partial: this.partial });
      }
      if (this.o.trace && c.last) { const q = this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]); this.o.log(`    t=${frames} v=${c.last[1].toFixed(0)} s=${q.s.toFixed(0)} d=${q.d.toFixed(1)} y=${c.last[6].toFixed(1)} flags=${c.last[2]} acts=${acts.map((a) => ACTION_NAMES[a]).join('')}`); }
      if (step % 5 === 0 || fin >= 0) this.o.log(`  [规划] 步 ${step}: 已提交 ${frames} 帧, 速度 ${c.last ? c.last[1].toFixed(0) : '-'} km/h, 评分 ${best.score.toFixed(1)}, 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    this.v0 = null; // 打磨阶段的局部评分只有一个采样点,不做撞击判断
    if (fin < 0) throw new Error('规划未能在 maxFrames 内冲线');
    // 提交时可能因整段动作多走了几帧;真实完成帧以 fin 为准
    const masks = new Uint8Array(fin); { let f = 0; for (let i = 0; i < committed.length && f < fin; i++) for (let j = 0; j < durs[i] && f < fin; j++) masks[f++] = committed[i]; }
    return { masks, finishFrames: fin, committed };
  }

  // ---------- 阶段 B:窗口爬山打磨(带快照的局部搜索,最终以整圈完成帧验收) ----------
  // 每轮:随机选窗口起点 W 与长度 Lw;把前缀 [0,W) 提交为快照;对窗口做一批变异,各自模拟 "窗口 + K 帧原计划尾部",
  //       用局部评分(同一时刻的中线进度 + 速度项)比较;最优候选若局部更好,再做一次整圈完整评估,完成帧不变差才接受。
  mutateWindow(win) {
    const r = this.rng; const n = win.length; const out = Array.from(win); const ri = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    const kind = r();
    if (kind < 0.35) { const a = ri(0, n - 1), len = ri(2, Math.min(n, 120)), act = ACTIONS[ri(0, ACTIONS.length - 1)]; for (let f = a; f < Math.min(n, a + len); f++) out[f] = act; }
    else if (kind < 0.75) { // 平移一个翻转边界
      const edges = []; for (let f = 1; f < n; f++) if (out[f] !== out[f - 1]) edges.push(f);
      if (edges.length) { const e = edges[ri(0, edges.length - 1)]; const d = ri(-25, 25) || 1; if (d > 0) { for (let f = e; f < Math.min(n, e + d); f++) out[f] = out[e - 1]; } else { for (let f = Math.max(0, e + d); f < e; f++) out[f] = out[e]; } }
    } else if (kind < 0.9) { // 把窗口整体换成一个恒定动作(清除抖动)
      const act = ACTIONS[ri(0, 2)]; const a = ri(0, n - 1), len = ri(10, Math.min(n, 200)); for (let f = a; f < Math.min(n, a + len); f++) out[f] = act;
    } else { const a = ri(0, n - 1), len = ri(1, 12); for (let f = a; f < Math.min(n, a + len); f++) out[f] = 4; } // 短促刹车
    return out;
  }

  async polish(masks0, fin0, { seconds = 60, batch = 96, K = 1000, maxIters = Infinity } = {}) {
    let best = Array.from(masks0), bestFin = fin0; const t0 = Date.now(); let it = 0, accepted = 0; const history = [{ it: 0, fin: bestFin, t: 0 }];
    while ((Date.now() - t0) / 1000 < seconds && it < maxIters) { // maxIters 给定时按迭代数停止(可复现);否则按时间
      it++;
      const n = best.length; const Lw = [30, 60, 120, 240][Math.floor(this.rng() * 4)];
      const W = Math.floor(this.rng() * Math.max(1, n - 50));
      const win = best.slice(W, W + Lw); const tail = best.slice(W + Lw, W + Lw + K);
      const span = win.length + tail.length;
      await this.g.commit(best.slice(0, W), 1, null, true);
      const plans = [win.concat(tail)];
      for (let b = 1; b < batch; b++) plans.push(this.mutateWindow(win).concat(tail));
      const res = await this.g.evalBatch(plans, { seg: 1, tail: 1, maxFrames: span, fromCommit: true, sampleAt: [span], minY: this.minY });
      const sc = res.map((r) => this.score(r, null));
      let bi = 0; for (let i = 1; i < sc.length; i++) if (sc[i] > sc[bi]) bi = i;
      if (bi === 0 || sc[bi] <= sc[0] + 1e-6) continue;
      const cand = best.slice(0, W).concat(plans[bi].slice(0, win.length), best.slice(W + Lw));
      const fin = await this.finishOf(cand);
      if (fin >= 0 && fin <= bestFin) {
        const improved = fin < bestFin; best = cand.slice(0, fin); bestFin = fin; accepted++;
        if (improved) { history.push({ it, fin: bestFin, t: (Date.now() - t0) / 1000 }); this.o.log(`  [打磨] 轮 ${it}: 完成帧 ${bestFin} (${((Date.now() - t0) / 1000) | 0}s, 已接受 ${accepted})`); }
      }
    }
    return { masks: Uint8Array.from(best), finishFrames: bestFin, generations: it, accepted, history };
  }

  /** 对整圈逐帧掩码做一次完整评估(从起点出发),返回完成帧(未完成为 -1) */
  async finishOf(masks) {
    const [r] = await this.g.evalBatch([Array.from(masks)], { seg: 1, tail: 1, maxFrames: masks.length + 200, minY: this.minY });
    return r.fin;
  }
}
