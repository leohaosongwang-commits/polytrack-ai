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
import { buildTrajectoryProgress } from './refpath.mjs';

export const ACTIONS = [1, 9, 3, 4]; // 默认动作集:W, W+左, W+右, 刹车。可用 opts.actions 扩展(漂移 SL=12 / SR=6,滑行转向 L=8 / R=2,滑行 0)
export const ACTION_NAMES = { 0: '·', 1: 'W', 2: 'R', 3: 'WR', 4: 'S', 6: 'SR', 8: 'L', 9: 'WL', 12: 'SL', 5: 'WS', 13: 'WSL', 7: 'WSR' };

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
    // crashStop = {w, drop, minV}(默认开):候选在 w 帧内掉速超过 drop km/h(撞击)就在引擎里提前结束并按"撞了"扣 crashStopPenalty 米;
    //   slalom 实测约 77% 的随机候选会撞,提前结束让模拟帧数少约 40%。carryMass = 初始分布里留给"上一步剩余计划"的概率质量(默认 0.8,旧版 0.55)。
    this.o = { refPath: null, refFlatAir: false, speedPen: 0, speedSlack: 0.9, carryMass: 0.8, localRollback: 0, repairMax: 0, repairCells: 14, repairNear: 15, repairBack: 700, crashStop: { w: 50, drop: 25, minV: 60 }, crashStopPenalty: 30, workers: 4, seg: 40, horizon: 20, segs: null, pop: 112, iters: 2, commitN: 8, lookAhead: 0.6, halfWidth: 8.5, offPenalty: 15, switchPenalty: 0.4, crashRate: 220, crashPenalty: 0, seed: 1, maxFrames: 45000, potential: 'polyline', actions: ACTIONS, extraRel: 1, airMax: 0, airTail: 4, airSettle: 100, stallFrames: 2500, stallMeters: 5, stallRetries: 6, stallBackFrames: 8000, stallRecoverFrames: 4000, stallClearMeters: 40, stallTotalMax: 12, slowKmh: 40, tumblePenalty: 30, fallAbove: 10, tumbleDeg: 50, recoverFrames: 2500, recoverExtra: [], maxRollbacks: 12, slowSegs: [...Array(12).fill(60), ...Array(12).fill(120), ...Array(6).fill(250)], log: () => {}, ...opts };
    this.rng = mulberry32(this.o.seed);
  }
  async init() {
    const ti = await this.g.trackInfo(); this.ti = ti; this.blocked = new Set(); this.repairs = 0;
    // refPath(eval 采样状态数组)给定时:用"一圈已有路线"的轨迹当势场(6.13:探索式规划给出的粗糙一圈 -> 沿它压圈速);偏离 = 到轨迹的 3D 距离
    this.prog = this.o.refPath ? buildTrajectoryProgress(this.o.refPath) : this.o.potential === 'field' ? buildProgressField(ti) : buildProgress(ti);
    this.minY = this.prog.minY ?? this.prog.startY - 12;
    if (this.o.refPath) { if (this.o.halfWidth === 8.5) this.o.halfWidth = 6; } else if (this.o.potential === 'field' && this.o.halfWidth === 8.5) this.o.halfWidth = 1.0; // 距离场的偏离量 = 离开可行驶格子的水平距离
    await this.g.makePool(this.o.workers);
    this.o.log(`赛道: 中线长度 ${this.prog.length.toFixed(0)} m, ${this.prog.nLevels} 个路点, 检查点 ${this.prog.checkpoints} 个; 评估 Worker ${this.o.workers} 个`);
  }

  /** 清掉一次 plan() 留下的运行状态(停滞计数、历史),让同一个 Solver(同一批评估 Worker)可以接着规划别的窗口 */
  resetRun() { this.sHist = []; this.posHist = []; this.stallRetry = 0; this.stallS = null; this.stallTotal = 0; this.stopped = null; this.partial = null; this.stats = null; }

  /** 单个候选的评分 */
  score(r, plan) {
    const { lookAhead, halfWidth, offPenalty, switchPenalty } = this.o;
    let sw = 0; if (plan) for (let i = 1; i < plan.length; i++) if (plan[i] !== plan[i - 1]) sw++;
    if (r.fin >= 0) return 1e6 - r.fin;
    if (r.dead) return -1e6 + r.frames;
    const crashedPen = r.crashed ? this.o.crashStopPenalty : 0; // 引擎因撞击提前结束的候选:照常按终态评分(进度少了自然排后),再扣一笔固定罚分
    let off = 0, crash = 0;
    if (this.v0 != null) { // 速度骤降(撞击)惩罚:相邻采样间的平均减速度 > crashRate km/h/s
      let pv = this.v0, pf = this.f0;
      for (const s of r.smp) { const dt = (s[0] - pf) / 1000; if (dt > 0 && (pv - s[1]) / dt > this.o.crashRate) crash++; pv = s[1]; pf = s[0]; }
    }
    let tumble = 0, fell = false, vdef = 0; const cosT = Math.cos((this.o.tumbleDeg * Math.PI) / 180);
    for (const s of r.smp) {
      const q = this.prog.query(s[5], s[7], s[6], s[4], this.o.refFlatAir && ((s[2] >> 3) & 15) === 0); if (q.d > halfWidth) off += q.d - halfWidth; // 轨迹势场 + refFlatAir:飞行中只比水平位置(实验开关,默认关:summer3 上开了反而更容易停滞)
      if (this.o.speedPen && q.vref != null) { const dv = q.vref * this.o.speedSlack - s[1]; if (dv > vdef) vdef = dv; } // 速度门槛:参考路线在这里的车速(入墙 / 起跳靠它)的 speedSlack 倍,低于它按缺口扣分
      if (q.above > this.o.fallAbove) fell = true; // 掉下高架:回不去 => 按死亡处理
      // 翻滚:四轮都离地、且车身相对竖直方向倾斜超过 tumbleDeg(撞击被弹飞后乱转)。正常的坡道起跳姿态平稳,不会触发。
      if (this.o.tumblePenalty && ((s[2] >> 3) & 15) === 0 && 1 - 2 * (s[8] * s[8] + s[10] * s[10]) < cosT) tumble++;
    }
    const e = r.last; const q = this.prog.query(e[5], e[7], e[6], e[4], this.o.refFlatAir && ((e[2] >> 3) & 15) === 0);
    if (fell || q.above > this.o.fallAbove) return -1e6 + r.frames;
    // 落地预判:计划结束时还在空中的候选,引擎会用 airTail(默认刹车)继续模拟到落地后 airSettle 帧;这里把进度按多花的时间折回,使各候选可比(落地冲击掉速会体现出来)
    const shift = (e[1] / 3.6) * ((r.extra || 0) / 1000);
    return q.s - shift + (e[1] / 3.6) * lookAhead - offPenalty * off - (q.d > halfWidth ? offPenalty * (q.d - halfWidth) : 0) - switchPenalty * sw - this.o.crashPenalty * crash - this.o.tumblePenalty * tumble - crashedPen - this.o.speedPen * vdef;
  }

  /**
   * 势场修复(失败驱动):规划停滞 = 势场认为"往前有路",车却怎么也上不去(例如把一摞实心方块的侧面当成了坡)。
   * 做法:取停滞位置出发、势场认为的最短路线前方 repairCells 个格子,把这些格子所属的零件整块从势场里屏蔽,重建势场;
   * 屏蔽后起点 -> 终点不连通(这条路线是唯一的路,只是需要助跑等)就放弃修复、原样保留。
   * 返回 { rollbackTo: 建议回退到的帧(车最近一次"连续进入"被屏蔽区域之前 repairBack 帧), parts, cells },或 null。
   */
  repairPotential(last, frames) {
    if (this.o.potential !== 'field' || this.repairs >= this.o.repairMax || !this.prog.route || !last) return null;
    const route = this.prog.route(last[5], last[6], last[7], last[4]);
    const parts = this.prog.partsOnRoute(route.slice(1, 1 + this.o.repairCells));
    if (!parts.length) return null;
    const add = []; for (const pi of parts) for (const c of this.ti.parts[pi].cells) add.push(c);
    const nb = new Set(this.blocked); for (const c of add) nb.add(`${c[0]},${c[1]},${c[2]}`);
    let np; try { np = buildProgressField(this.ti, { blocked: nb, strict: true }); } catch { return null; }
    this.blocked = nb; this.prog = np; this.repairs++;
    const R = this.o.repairNear, ctr = add.map((c) => [(c[0] + 0.5) * 5, (c[2] + 0.5) * 5]);
    const near = (h) => ctr.some((q) => Math.hypot(q[0] - h[1], q[1] - h[3]) < R);
    const hist = this.posHist ?? []; let i = hist.length - 1; while (i >= 0 && near(hist[i])) i--;
    const enter = hist[i + 1] ? hist[i + 1][0] : frames; // 最近一次连续进入该区域的帧
    return { rollbackTo: Math.max(0, enter - this.o.repairBack), parts: parts.length, cells: add.length, total: this.repairs };
  }

  /** 评估一批候选并累计统计(候选数、模拟帧数、墙钟),用来看时间花在哪 */
  async evalTimed(plans, opts, f0) {
    const t = Date.now(); const res = await this.g.evalBatch(plans, opts); const st = (this.stats ??= { steps: 0, evalCalls: 0, cands: 0, simFrames: 0, evalMs: 0, commitMs: 0, crashed: 0, itersUsed: 0, committedActions: 0 });
    st.evalMs += Date.now() - t; st.evalCalls++; st.cands += plans.length; for (const r of res) { st.simFrames += Math.max(0, r.frames - f0) + (r.extra || 0); if (r.crashed) st.crashed++; }
    return res;
  }
  statsLine() {
    const s = this.stats; if (!s) return '';
    return `统计: ${s.steps} 步, ${s.cands} 个候选(平均每步 ${(s.cands / Math.max(1, s.steps)).toFixed(0)}、${(s.itersUsed / Math.max(1, s.steps)).toFixed(2)} 轮), 模拟 ${(s.simFrames / 1e6).toFixed(1)}M 帧(平均每候选 ${(s.simFrames / Math.max(1, s.cands)).toFixed(0)} 帧${s.crashed ? `, 撞击提前结束 ${(100 * s.crashed / s.cands).toFixed(0)}%` : ''}), 评估 ${(s.evalMs / 1000).toFixed(1)}s(${(s.simFrames / Math.max(1, s.evalMs)).toFixed(0)}k 帧/s), 提交 ${(s.commitMs / 1000).toFixed(1)}s, 平均每步提交 ${(s.committedActions / Math.max(1, s.steps)).toFixed(1)} 个动作`;
  }

  // ---------- 阶段 A:CEM 滚动时域规划 ----------
  async plan() {
    const { pop, iters, commitN, maxFrames } = this.o; const AC = this.o.actions; const A = AC.length; const rel = AC.map((a) => (ACTIONS.includes(a) ? 1 : this.o.extraRel));
    const baseSegs = this.o.segs ?? Array.from({ length: this.o.horizon }, () => this.o.seg);
    const recoverSegs = [...baseSegs, ...this.o.recoverExtra]; // 失败后的"恢复窗口"用更长的视野(多看 1.2 s),才看得到高速弯里的死胡同
    let segs = baseSegs, horizon = segs.length, total = 0, smpAt = [], slowMode = false, mode = 'base', recoverUntil = -1;
    const setSegs = (sg) => { segs = sg; horizon = sg.length; total = sg.reduce((a, b) => a + b, 0); smpAt = []; let c = 0; for (const x of sg) { c += x; smpAt.push(c); } };
    setSegs(baseSegs);
    let lastV = null; let rollbacks = 0; const committed = []; const durs = []; let frames = 0; let carry = null; let fin = -1; let step = 0;
    if (this.o.prefix) { // 从已有的提交序列(前缀)继续规划:只重算后面的部分,用来快速验证"某个卡点之后能不能过"
      committed.push(...this.o.prefix.committed); durs.push(...this.o.prefix.durs);
      const c0 = await this.g.commit(committed, 1, durs, true); frames = c0.frames; lastV = c0.last ? c0.last[1] : null;
      this.o.log(`  [规划] 从前缀继续:已有 ${committed.length} 个动作 / ${frames} 帧,车速 ${lastV != null ? lastV.toFixed(0) : '-'} km/h`);
    }
    const t0 = Date.now();
    this.stopped = null;
    while (fin < 0 && frames < maxFrames && !this.stopped) {
      if (this.o.cancel?.()) throw new Error('已取消');
      // 长视野两种触发:① 低速机动(起步后车速低于 slowKmh,默认关);② 回退后的恢复窗口(recoverUntil 之前)
      { const slow = !!this.o.slowSegs && frames > 2000 && lastV != null && lastV < this.o.slowKmh; slowMode = slow;
        const want = slow ? 'slow' : this.o.recoverExtra.length && frames < recoverUntil ? 'recover' : 'base';
        if (want !== mode) { mode = want; setSegs(want === 'slow' ? this.o.slowSegs : want === 'recover' ? recoverSegs : baseSegs); carry = null; if (this.o.trace || want !== 'base') this.o.log(`  [规划] 帧 ${frames}: 切换视野 -> ${want === 'slow' ? '低速长时域' : want === 'recover' ? '恢复窗口(长时域)' : '常规'}`); } }
      // 初始分布:有上一轮计划就在其(平移后的)动作上放较大概率
      const probs = Array.from({ length: horizon }, (_, h) => {
        const p = new Float64Array(A);
        const want = carry && h < carry.length ? AC.indexOf(carry[h]) : -1; const base = want >= 0 ? want : AC.indexOf(1);
        let z = 0; for (let a = 0; a < A; a++) if (a !== base) z += rel[a];
        const pBase = want >= 0 ? this.o.carryMass : 0.4; const mass = 1 - pBase; // 其余动作共享的先验质量;extraRel < 1 时漂移等"额外动作"先验更小(搜索空间变大但不稀释常用动作)。carryMass 越大,候选越贴近上一步剩下的计划(局部搜索),越小越发散
        for (let a = 0; a < A; a++) p[a] = a === base ? pBase : (mass * rel[a]) / z;
        return p;
      });
      let best = null; this.v0 = lastV; this.f0 = frames; let itersRun = 0;
      for (let it = 0; it < iters; it++) {
        const plans = []; const idx = []; itersRun++;
                if (carry && it === 0) { const p = carry.slice(0, horizon); while (p.length < horizon) p.push(1); plans.push(p); idx.push(p.map((a) => AC.indexOf(a))); }
        while (plans.length < pop) {
          const ix = probs.map((p) => { let u = this.rng(), a = 0; for (; a < A - 1; a++) { u -= p[a]; if (u <= 0) break; } return a; });
          idx.push(ix); plans.push(ix.map((a) => AC[a]));
        }
        const res = await this.evalTimed(plans, { segs, maxFrames: total, fromCommit: true, sampleAt: smpAt, minY: this.minY, ...(this.o.crashStop ? { crashStop: this.o.crashStop } : {}), ...(this.o.airMax ? { airMax: this.o.airMax, airTail: this.o.airTail, airSettle: this.o.airSettle } : {}) }, frames);
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
      (this.stats ??= { steps: 0, evalCalls: 0, cands: 0, simFrames: 0, evalMs: 0, commitMs: 0, crashed: 0, itersUsed: 0, committedActions: 0 }).itersUsed += itersRun;
      if (best.score < -5e5) { // 所有候选都掉出赛道:回退若干步(回退幅度逐次加大)并换一批随机数重新规划
        rollbacks++; if (rollbacks > this.o.maxRollbacks || !committed.length) throw new Error(`规划失败:帧 ${frames} 附近所有候选都掉出赛道(已回退 ${rollbacks - 1} 次)`);
        recoverUntil = Math.max(recoverUntil, frames + this.o.recoverFrames); // 回退重来时在失败点之后 recoverFrames 帧内都用长视野
        const back = Math.min(committed.length, commitN * 2 * rollbacks); // 回退 2*rollbacks 个提交步
        committed.length -= back; durs.length -= back;
        const c0 = committed.length ? await this.g.commit(committed, 1, durs, true) : await this.g.commit([], 1, null, true);
        frames = c0.frames; lastV = c0.last ? c0.last[1] : null; carry = null; fin = -1; this.posHist = (this.posHist ?? []).filter((h) => h[0] <= frames);
        this.o.log(`  [规划] 回退 ${back} 个动作(第 ${rollbacks} 次),回到帧 ${frames}`);
        continue;
      }
      const take = best.res.fin >= 0 ? best.plan.length : Math.min(commitN, best.plan.length);
      const acts = best.plan.slice(0, take);
      const tCommit = Date.now();
      const c = await this.g.commit(acts, segs[0], segs.slice(0, acts.length));
      { const st = this.stats; st.commitMs += Date.now() - tCommit; st.steps++; st.committedActions += take; }
      if (c.last) (this.posHist ??= []).push([c.frames, c.last[5], c.last[6], c.last[7], this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]).s]);
      committed.push(...acts); durs.push(...segs.slice(0, acts.length)); frames = c.frames; fin = c.fin; lastV = c.last ? c.last[1] : lastV; carry = best.plan.slice(take);
      step++; if (rollbacks > 0 && frames > recoverUntil) rollbacks = 0; // 越过恢复窗口就清零,零星的几次失败不该耗光额度
      this.partial = { committed: committed.slice(), durs: durs.slice(), frames, last: c.last };
      if (this.o.stopS != null && c.last) { const qs = this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]).s; if (qs >= this.o.stopS) { this.stopped = { frames, v: c.last[1], pos: [c.last[5], c.last[6], c.last[7]], s: qs, cp: c.last[4] }; break; } } // 局部实验:到达指定中线进度就停(比较"谁先到")
      if (c.last && this.o.stallFrames) { // 停滞看门狗:最近 stallFrames 帧内进度增长不足 stallMeters => 快速失败(并保留现场供诊断)
        const q = this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]); (this.sHist ??= []).push([frames, q.s]);
        const old = this.sHist.find((h) => h[0] >= frames - this.o.stallFrames);
        const stalled = old && frames >= this.o.stallFrames && q.s - old[1] < this.o.stallMeters && this.sHist[0][0] <= frames - this.o.stallFrames;
        if ((this.stallRetry ?? 0) > 0 && this.stallS != null && q.s > this.stallS + this.o.stallClearMeters) { this.o.log(`  [规划] 越过卡点(进度 ${this.stallS.toFixed(0)} -> ${q.s.toFixed(0)} m):重试额度清零`); this.stallRetry = 0; this.stallS = null; } // 长赛道有好几个难点:额度按"卡点"计,不是整局共用
        if (stalled && this.o.repairMax > 0) { // 先试"势场修复":把势场认为的那条走不通的路线屏蔽掉,只回退到进入该区域之前一点点,而不是整段重来
          const rep = this.repairPotential(c.last, frames);
          if (rep) {
            let total = frames; while (committed.length > 1 && total > rep.rollbackTo) { total -= durs.pop(); committed.pop(); }
            const c0 = await this.g.commit(committed, 1, durs, true);
            this.posHist = (this.posHist ?? []).filter((h) => h[0] <= c0.frames);
            this.o.log(`  [规划] 停滞(帧 ${frames},位置 x=${c.last[5].toFixed(0)} y=${c.last[6].toFixed(0)} z=${c.last[7].toFixed(0)},车速 ${c.last[1].toFixed(0)} km/h):势场修复 #${rep.total}:屏蔽 ${rep.parts} 个零件(${rep.cells} 格)后势场仍连通,回退到帧 ${c0.frames}`);
            frames = c0.frames; lastV = c0.last ? c0.last[1] : null; carry = null; fin = -1; this.sHist = []; slowMode = false; mode = 'base'; setSegs(baseSegs);
            continue;
          }
        }
        if (stalled && (this.stallRetry ?? 0) < this.o.stallRetries && (this.stallTotal ?? 0) < this.o.stallTotalMax) { // 停滞:不立刻失败,回退一大段(逐次加大)后换一批随机数重规划(例如坡道前需要重新拉开助跑距离)
          this.stallRetry = (this.stallRetry ?? 0) + 1; this.stallTotal = (this.stallTotal ?? 0) + 1; this.stallS = Math.max(this.stallS ?? 0, q.s); let want = this.o.stallBackFrames * (1 + 0.5 * (this.stallRetry - 1)); let cut = 0;
          if (this.o.localRollback > 0) { // 局部回退:退到"进度比停滞时的最高进度低 localRollback 米(逐次加大)"的最近一帧,而不是固定退 8000 帧(短赛道会直接退回起点、整段重算)
            const hist = this.posHist ?? []; const sMax = Math.max(...hist.slice(-Math.ceil(this.o.stallFrames / 100) - 8).map((h) => h[4] ?? -Infinity)); const sTarget = sMax - this.o.localRollback * (1 + 0.75 * (this.stallRetry - 1));
            let i = hist.length - 1; while (i >= 0 && !(hist[i][4] <= sTarget)) i--;
            want = Math.max(1, frames - (i >= 0 ? hist[i][0] : 0));
          }
          while (committed.length > 1 && cut < want) { cut += durs.pop(); committed.pop(); }
          const c0 = await this.g.commit(committed, 1, durs, true);
          frames = c0.frames; lastV = c0.last ? c0.last[1] : null; carry = null; fin = -1; this.sHist = []; slowMode = false; mode = 'base'; setSegs(baseSegs); this.posHist = (this.posHist ?? []).filter((h) => h[0] <= frames);
          if (this.o.recoverExtra.length) recoverUntil = Math.max(recoverUntil, frames + this.o.stallRecoverFrames); // 停滞后重规划的这一段用长视野(recoverExtra):坡道 / 起跳的后果要几秒后才看得到
          this.o.log(`  [规划] 停滞(帧 ${frames + cut},位置 x=${c.last[5].toFixed(0)} z=${c.last[7].toFixed(0)},车速 ${c.last[1].toFixed(0)} km/h):回退 ${cut} 帧到 ${frames},第 ${this.stallRetry}/${this.o.stallRetries} 次重规划`);
          continue;
        }
        if (stalled) throw Object.assign(new Error(`规划停滞:帧 ${frames} 前 ${this.o.stallFrames} 帧内进度只增加 ${(q.s - old[1]).toFixed(1)} m(s=${q.s.toFixed(0)}/${this.prog.length.toFixed(0)},位置 x=${c.last[5].toFixed(1)} y=${c.last[6].toFixed(1)} z=${c.last[7].toFixed(1)},车速 ${c.last[1].toFixed(0)} km/h)`), { partial: this.partial });
      }
      if (this.o.trace && c.last) { const q = this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]); this.o.log(`    t=${frames} v=${c.last[1].toFixed(0)} s=${q.s.toFixed(0)} d=${q.d.toFixed(1)} y=${c.last[6].toFixed(1)} flags=${c.last[2]} acts=${acts.map((a) => ACTION_NAMES[a]).join('')}`); }
      if (step % 5 === 0 || fin >= 0) this.o.log(`  [规划] 步 ${step}: 已提交 ${frames} 帧, 速度 ${c.last ? c.last[1].toFixed(0) : '-'} km/h, 评分 ${best.score.toFixed(1)}, 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    this.v0 = null; // 打磨阶段的局部评分只有一个采样点,不做撞击判断
    this.o.log('  [规划] ' + this.statsLine());
    if (this.stopped) return { masks: null, finishFrames: -1, committed, durs, stopped: this.stopped };
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
    if (kind < 0.35) { const a = ri(0, n - 1), len = ri(2, Math.min(n, 120)), act = this.o.actions[ri(0, this.o.actions.length - 1)]; for (let f = a; f < Math.min(n, a + len); f++) out[f] = act; }
    else if (kind < 0.75) { // 平移一个翻转边界
      const edges = []; for (let f = 1; f < n; f++) if (out[f] !== out[f - 1]) edges.push(f);
      if (edges.length) { const e = edges[ri(0, edges.length - 1)]; const d = ri(-25, 25) || 1; if (d > 0) { for (let f = e; f < Math.min(n, e + d); f++) out[f] = out[e - 1]; } else { for (let f = Math.max(0, e + d); f < e; f++) out[f] = out[e]; } }
    } else if (kind < 0.9) { // 把窗口整体换成一个恒定动作(清除抖动)
      const act = this.o.actions[ri(0, this.o.actions.length - 1)]; const a = ri(0, n - 1), len = ri(10, Math.min(n, 200)); for (let f = a; f < Math.min(n, a + len); f++) out[f] = act;
    } else { const a = ri(0, n - 1), len = ri(1, 12); for (let f = a; f < Math.min(n, a + len); f++) out[f] = 4; } // 短促刹车
    return out;
  }

  async polish(masks0, fin0, { seconds = 60, batch = 96, K = 1000, maxIters = Infinity } = {}) {
    let best = Array.from(masks0), bestFin = fin0; const t0 = Date.now(); let it = 0, accepted = 0; const history = [{ it: 0, fin: bestFin, t: 0 }];
    while ((Date.now() - t0) / 1000 < seconds && it < maxIters && !this.o.cancel?.()) { // maxIters 给定时按迭代数停止(可复现);否则按时间
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
