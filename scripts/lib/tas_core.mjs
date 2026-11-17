// 帧级局部搜索(TAS 式打磨)的核心:不碰文件、不启动浏览器,只依赖一个"游戏"适配对象 g(makePool / evalBatch / commit),
// 所以 Node 脚本(scripts/tas_polish.mjs,Playwright 里的 g)和页面里的扩展(extension/src/core.js,makeG 返回的 g)共用同一份代码。
//
// 在一份已有的逐帧按键方案上反复做小改动(平移翻转帧、平移/删除短脉冲、替换一小段、时间扭曲……),
// 每个候选从"窗口起点的快照"出发,窗口之后沿用原方案的按键一直模拟到冲线,直接用真实完成帧做目标。
// 只接受完成帧更小(或相同且翻转次数不增)的候选,所以结果单调不变差;游戏自带 Verify 由调用方做。
// 与 solver.polish 的区别:不用势能做代理评分,目标就是完成帧本身。
// "闸门对齐"(默认开):窗口较早时,改动会让车比原来早/晚到达后面的地形,后半段按绝对帧号发出的按键就对不上了,
//   所以在窗口之后 300~1500 帧处取原方案轨迹上的一个"闸门"(过该点、法向=该处速度方向的平面),
//   候选越过闸门的那一刻起,后半段按键改按"越过时刻"对齐(并随机试 ±5 帧偏移)。这样早期的结构性改动(起飞速度、落点、漂移时机)也能被真实完成帧公平地评价。
// 先做 1-opt 穷举扫描(每个键的每个翻转帧平移若干固定量、每个脉冲整体平移,带/不带闸门各评一遍),到局部最优后再做结构性扫描和随机多点变异。
// 扫描顺序:forward = 从前往后(默认,离线长跑用);backward = 从后往前。候选的代价 ≈ 事件到终点的剩余帧数,
//   所以后段事件很便宜;预算只有几分钟时,从后往前能在同样时间里覆盖多得多的事件,而且后段的改进不会让前段的候选失效。
import { masksToToggles, togglesToMasks, mulberry32 } from './solver.mjs';

const POOL_ACTIONS = [1, 3, 9, 5, 4, 7, 13, 12, 6, 2, 8, 0]; // W WR WL WS S WSR WSL SL SR R L ·
export const nToggles = (m) => { let c = 0; for (let f = 1; f < m.length; f++) if (m[f] !== m[f - 1]) c++; return c; };

/** 对窗口(逐帧掩码)做 1~2 个随机改动;时间扭曲会改变窗口长度 */
export function mutateWin(win, rng) {
  const out = Array.from(win); let L = out.length; const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const nm = rng() < 0.3 ? 2 : 1;
  const dAbs = () => { const u = rng(); return u < 0.7 ? 1 + Math.floor(rng() * rng() * 12) : u < 0.95 ? ri(10, 60) : ri(60, 200); }; // 重尾:偶尔做大幅平移
  const dSgn = () => (rng() < 0.5 ? -1 : 1) * dAbs();
  for (let t = 0; t < nm; t++) {
    L = out.length; const edges = []; for (let f = 1; f < L; f++) if (out[f] !== out[f - 1]) edges.push(f);
    const kind = rng();
    if (kind < 0.45 && edges.length) { // 平移一个翻转边界
      const e = edges[ri(0, edges.length - 1)]; const d = dSgn();
      if (d > 0) { for (let f = e; f < Math.min(L, e + d); f++) out[f] = out[e - 1]; } else { for (let f = Math.max(0, e + d); f < e; f++) out[f] = out[e]; }
    } else if (kind < 0.62 && edges.length >= 2) { // 整体平移一个短脉冲
      const i = ri(0, edges.length - 2); const e1 = edges[i], e2 = edges[i + 1]; if (e2 - e1 <= 160) { const pm = out[e1], bg = out[e1 - 1]; const d = dSgn(); for (let f = e1; f < e2; f++) out[f] = bg; for (let f = Math.max(0, e1 + d); f < Math.min(L, e2 + d); f++) out[f] = pm; }
    } else if (kind < 0.70 && edges.length >= 2) { // 删掉一个短脉冲
      const i = ri(0, edges.length - 2); const e1 = edges[i], e2 = edges[i + 1]; if (e2 - e1 <= 120) for (let f = e1; f < e2; f++) out[f] = out[e1 - 1];
    } else if (kind < 0.80) { // 把一小段换成别的动作
      const a = ri(0, L - 1), len = ri(2, Math.min(L, 80)), act = POOL_ACTIONS[ri(0, POOL_ACTIONS.length - 1)]; for (let f = a; f < Math.min(L, a + len); f++) out[f] = act;
    } else if (kind < 0.88) { // 在一段里加一个短脉冲(刹车 / 转向 / 刹车+转向),长度重尾
      const a = ri(0, L - 1), len = rng() < 0.8 ? ri(3, 40) : ri(40, 200); const add = [2, 8, 4, 6, 12][ri(0, 4)];
      for (let f = a; f < Math.min(L, a + len); f++) { let x = out[f] | add; if (add & 2) x &= ~8; if (add & 8) x &= ~2; out[f] = x; }
    } else if (kind < 0.94) { // 时间扭曲:删掉或复制几帧,使窗口之后的原按键整体提前/推后 d 帧
      const d = 1 + Math.floor(rng() * rng() * 8); const a = ri(0, Math.max(0, out.length - 1));
      if (rng() < 0.5 && out.length > d + 20) out.splice(a, d); else out.splice(a, 0, ...Array(d).fill(out[a]));
    } else { // 去掉一段里的转向
      const a = ri(0, L - 1), len = ri(4, Math.min(L, 60)); for (let f = a; f < Math.min(L, a + len); f++) out[f] &= ~(2 | 8);
    }
  }
  return out;
}

/** 某个键(位掩码 bit)在逐帧掩码里的翻转帧(第 f 帧与第 f-1 帧不同;f>=1) */
export function keyEdges(m, bit) { const e = []; for (let f = 1; f < m.length; f++) if ((m[f] & bit) !== (m[f - 1] & bit)) e.push(f); return e; }

/** 单键单翻转帧平移候选:把第 tau 帧处 bit 的翻转挪到 tau+d(不越过相邻的同键翻转)。返回 {W, L, plans}(plans[0] 是原窗口) */
export function singleShiftCandidates(best, bit, tau, ds, prev, next) {
  const W = Math.max(0, tau - 14), L = 48, win = best.slice(W, W + L); const plans = [win];
  for (const d of ds) {
    const out = win.slice(); const lo = Math.max(W, prev ?? 0), hi = Math.min(W + L, next ?? 1e9);
    if (d > 0) { const v = best[tau - 1] & bit; for (let f = tau; f < Math.min(hi, tau + d); f++) out[f - W] = (out[f - W] & ~bit) | v; }
    else { const v = best[tau] & bit; for (let f = Math.max(lo, tau + d); f < tau; f++) out[f - W] = (out[f - W] & ~bit) | v; }
    plans.push(out);
  }
  return { W, L, plans };
}

/** 短脉冲整体平移候选:同键相邻两个翻转 e1<e2 之间的脉冲,整体平移 d 帧 */
export function pulseShiftCandidates(best, bit, e1, e2, ds, prev, next) {
  const W = Math.max(0, e1 - 14), L = (e2 - e1) + 48, win = best.slice(W, W + L); const plans = [win]; const bg = best[e1 - 1] & bit, pm = best[e1] & bit;
  for (const d of ds) {
    const out = win.slice(); for (let f = e1; f < e2; f++) out[f - W] = (out[f - W] & ~bit) | bg;
    const a = Math.max(W, prev ?? 0, e1 + d), b = Math.min(W + L, next ?? 1e9, e2 + d); for (let f = a; f < b; f++) out[f - W] = (out[f - W] & ~bit) | pm;
    plans.push(out);
  }
  return { W, L, plans };
}

/** 大幅平移候选:窗口按 ds 的范围自适应 */
export function bigShiftCandidates(best, bit, tau, ds, prev, next) {
  const W = Math.max(0, tau + Math.min(...ds) - 6), L = Math.max(...ds) - Math.min(...ds) + 24; const win = best.slice(W, W + L); const plans = [win];
  for (const d of ds) {
    const out = win.slice(); const lo = Math.max(W, prev ?? 0), hi = Math.min(W + L, next ?? 1e9);
    if (d > 0) { const v = best[tau - 1] & bit; for (let f = tau; f < Math.min(hi, tau + d); f++) out[f - W] = (out[f - W] & ~bit) | v; }
    else { const v = best[tau] & bit; for (let f = Math.max(lo, tau + d); f < tau; f++) out[f - W] = (out[f - W] & ~bit) | v; }
    plans.push(out);
  }
  return { W, L, plans };
}

const applyKeys = (m, add) => { let x = m | add; if (add & 2) x &= ~8; if (add & 8) x &= ~2; return x; };
/** 插入候选:在 p 处插入一个短脉冲(刹车 / 转向 / 刹车+转向 / 松油门)长度各取几档 */
export function insertCandidates(best, p) {
  const W = Math.max(0, p - 6), L = 110, win = best.slice(W, W + L); const plans = [win];
  for (const add of [4, 2, 8, 6, 12, 'coast']) for (const len of [8, 20, 50]) {
    const out = win.slice(); for (let f = p; f < Math.min(W + L, p + len); f++) out[f - W] = add === 'coast' ? out[f - W] & ~1 : applyKeys(out[f - W], add);
    plans.push(out);
  }
  return { W, L, plans };
}

/** 脉冲缩放/删除候选:e1<e2 是同键相邻翻转,脉冲长 dur = e2-e1:删掉、缩到一半、拉长 1.5 倍和 2 倍(只动后沿) */
export function scalePulseCandidates(best, bit, e1, e2, prev, next) {
  const dur = e2 - e1, W = Math.max(0, e1 - 8), L = dur * 2 + 30, win = best.slice(W, W + L); const plans = [win]; const bg = best[e1 - 1] & bit, pm = best[e1] & bit;
  for (const ne of [e1, e1 + Math.round(dur / 2), e1 + Math.round(dur * 1.5), e1 + dur * 2]) {
    if (ne === e2) continue; const out = win.slice(); for (let f = e1; f < Math.min(W + L, Math.max(e2, ne)); f++) out[f - W] = (out[f - W] & ~bit) | (f < ne ? pm : bg);
    if (ne > e2 && next != null && ne >= next) continue; plans.push(out);
  }
  return { W, L, plans };
}

/** 按 eval 的规则重建候选的完整逐帧按键:窗口 -> tailArr(直到越过闸门)-> post(按越过时刻对齐 + shift) */
export function rebuild(best, W, cand, tailArr, post, fc, sh, fin) {
  const out = best.slice(0, W).concat(cand); const base = W + cand.length;
  for (let f = base; f < fin; f++) {
    if (fc > 0 && f >= fc) { const pi = f - fc + sh; out.push(pi >= 0 && pi < post.length ? post[pi] : 1); } else out.push(tailArr[f - base] ?? 1);
  }
  return out;
}

/** 游标之后(forward)或之前(backward)最近的一个(键, 翻转帧);pairMax = 把"下一个翻转"当作同一脉冲的最大间距 */
export function pickEvent(best, bestFin, cursor, dir, pairMax) {
  let ev = null;
  for (const bit of [1, 2, 4, 8]) {
    const ed = keyEdges(best, bit); let i;
    if (dir > 0) i = ed.findIndex((f) => f >= cursor);
    else { i = -1; for (let k = ed.length - 1; k >= 0; k--) if (ed[k] <= cursor) { i = k; break; } }
    if (i < 0) continue;
    const better = !ev || (dir > 0 ? ed[i] < ev.tau : ed[i] > ev.tau);
    if (better) ev = { bit, tau: ed[i], prev: i > 0 ? ed[i - 1] : 0, next: ed[i + 1] ?? bestFin, next2: ed[i + 2] ?? bestFin, pair: ed[i + 1] && ed[i + 1] - ed[i] <= pairMax ? ed[i + 1] : null };
  }
  return ev;
}

/**
 * 打磨一份方案。
 * @param g           游戏适配:makePool(n) / evalBatch(plans, opts) / commit(actions, seg, segs, reset)(Node:Playwright 里的 Game;页面:core.js 的 makeG)
 * @param toggles     起点方案:5 个键的翻转帧列表(up,right,down,left,reset)
 * @param finishFrames 起点的完成帧
 * @param opts        {seconds, workers, batch, seed, from, late, rounds, gate, sweep, structural, random, order, log, shouldStop, onImprove}
 *                    onImprove({ finishFrames, toggles }):每次接受改进后调用;shouldStop():返回 true 就在当前一步结束后收尾
 * @returns { finishFrames, startFrames, toggles, iterations, improvements }(结果还没过游戏 Verify,调用方必须自己校验)
 */
export async function polishPlan(g, toggles, finishFrames, { seconds = 60, workers = 4, batch = 64, seed = 1, from = 0, late = 0.25, rounds = 2, gate = true, sweep = true, structural = true, random = true, order = 'forward', log = () => {}, shouldStop = () => false, onImprove = () => {} } = {}) {
  let best = Array.from(togglesToMasks(toggles, finishFrames)); let bestFin = finishFrames; const fin0 = bestFin;
  const rng = mulberry32(seed); const t0 = Date.now();
  const live = () => (Date.now() - t0) / 1000 < seconds && !shouldStop();
  await g.makePool(workers);
  const finishOf = async (m) => (await g.evalBatch([Array.from(m)], { seg: 1, tail: 1, maxFrames: m.length + 300 }))[0].fin;
  const chk = await finishOf(best); if (chk !== bestFin) throw new Error(`起点复核不一致:方案声称 ${bestFin},引擎算得 ${chk}`);
  log(`起点 ${bestFin} 帧 (${(bestFin / 1000).toFixed(3)} s),翻转 ${nToggles(best)} 次;${workers} 个评估线程,每批 ${batch} 个候选;闸门对齐 ${gate ? '开' : '关'};扫描顺序 ${order === 'backward' ? '从后往前' : '从前往后'}`);
  // 当前最佳轨迹每 25 帧的位置(用来取闸门)
  let pos = null;
  const refreshPos = async () => { const at = []; for (let f = 25; f <= bestFin; f += 25) at.push(f); const [r] = await g.evalBatch([Array.from(best)], { seg: 1, tail: 1, maxFrames: bestFin + 300, sampleAt: at }); pos = new Map(r.smp.map((x) => [x[0], [x[5], x[6], x[7]]])); };
  const gateAt = (G0) => { const a = pos.get(G0 - 25), b = pos.get(G0 + 25), p = pos.get(G0); if (!a || !b || !p) return null; const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const n = Math.hypot(...d); if (n < 1e-6) return null; return { p, d: d.map((x) => x / n) }; };
  if (gate) await refreshPos();
  let it = 0, acc = 0, ties = 0, framesSim = 0, gated = 0, gatedAcc = 0, rebuildFail = 0, sweepAcc = 0;
  const emit = () => onImprove({ finishFrames: bestFin, toggles: masksToToggles(best) });
  // ---- 1-opt 穷举扫描:每个键的每个翻转帧各平移若干个固定量,每个脉冲整体平移;先不带闸门、再带闸门各评一遍,有改进立刻接受 ----
  const evalPlans = async (W, L, plans, useGate) => {
    let gt = null, G0 = 0; if (useGate && gate) { G0 = Math.ceil((W + L + 600) / 25) * 25; if (G0 + 500 < bestFin) gt = gateAt(G0); }
    await g.commit(best.slice(0, W), 1, null, true);
    const tailArr = best.slice(W + L, gt ? G0 + 500 : bestFin); const post = gt ? best.slice(G0, bestFin) : null;
    const res = await g.evalBatch(plans, { seg: 1, tail: 1, tailArr, maxFrames: bestFin - W + 300, fromCommit: true, ...(gt ? { gate: { p: gt.p, d: gt.d, post, shifts: plans.map(() => 0) } } : {}) });
    framesSim += plans.length * (bestFin - W);
    return { res, tailArr, post, gt, G0 };
  };
  const tryBatch = async (W, L, plans, what) => {
    for (const useGate of [false, true]) {
      if (useGate && (!gate || W + L + 1100 >= bestFin)) continue;
      const { res, tailArr, post, gt, G0 } = await evalPlans(W, L, plans, useGate);
      if (res[0].fin !== bestFin) { log(`  警告:扫描基线 ${res[0].fin} != ${bestFin}(${what} W=${W} gate=${useGate})`); continue; }
      let bi = -1, bf = bestFin; for (let i = 1; i < res.length; i++) { const f = res[i].fin; if (f >= 0 && !res[i].dead && f < bf) { bi = i; bf = f; } }
      if (bi < 0) continue;
      const cand = rebuild(best, W, plans[bi], tailArr, post, res[bi].fc, 0, bf); const chk2 = await finishOf(cand);
      if (chk2 !== bf) { rebuildFail++; continue; }
      best = cand; bestFin = bf; acc++; sweepAcc++; if (gt) gatedAcc++;
      log(`  [${((Date.now() - t0) / 1000) | 0}s] 扫描 ${what}: ${bestFin} 帧 (${(bestFin / 1000).toFixed(3)} s,比起点 -${fin0 - bestFin} 帧)${gt ? ` 闸门 ${G0} 越过 ${res[bi].fc}` : ''}`); emit(); if (gate) await refreshPos(); return true;
    }
    return false;
  };
  const back = order === 'backward';
  if (sweep) {
    const DS = [-12, -8, -6, -4, -3, -2, -1, 1, 2, 3, 4, 6, 8, 12], PDS = [-8, -4, -2, 2, 4, 8];
    for (let sw = 1; live(); sw++) {
      sweepAcc = 0; let cursor = back ? bestFin - 41 : Math.max(1, from); const tS = Date.now(); let nb = 0;
      while (live() && (back ? cursor >= Math.max(1, from) : cursor < bestFin - 40)) {
        const ev = pickEvent(best, bestFin, cursor, back ? -1 : 1, 150); if (!ev) break;
        if (back && ev.tau >= bestFin - 40) { cursor = ev.tau - 1; continue; } // 终点附近的事件改了也不会更快,且越过终点会让候选无效
        cursor = back ? ev.tau - 1 : ev.tau + 1; nb++;
        let c = singleShiftCandidates(best, ev.bit, ev.tau, DS, ev.prev, ev.next); let ok = await tryBatch(c.W, c.L, c.plans, `键${ev.bit}@${ev.tau}`);
        if (!ok && ev.pair) { c = pulseShiftCandidates(best, ev.bit, ev.tau, ev.pair, PDS, ev.prev, ev.next2); ok = await tryBatch(c.W, c.L, c.plans, `脉冲${ev.bit}@${ev.tau}`); }
        if (ok) cursor = back ? Math.min(bestFin - 41, ev.tau + 20) : Math.max(1, ev.tau - 20); // 状态变了,往回退一点重扫
      }
      log(`  扫描第 ${sw} 遍:${nb} 个事件,${sweepAcc} 次改进,用时 ${((Date.now() - tS) / 1000) | 0}s;当前 ${bestFin} 帧`);
      if (sweepAcc === 0) break; // 1-opt 局部最优
    }
  }

  // ---- 结构性扫描:大幅平移 / 脉冲缩放删除 / 插入短脉冲 ----
  const BIG = [-100, -60, -40, -25, -18, 18, 25, 40, 60, 100];
  const runEvents = async (label, gen) => {
    let cursor = back ? bestFin - 41 : 1; const tS = Date.now(); let nb = 0; sweepAcc = 0;
    while (live() && (back ? cursor >= 1 : cursor < bestFin - 40)) {
      const ev = pickEvent(best, bestFin, cursor, back ? -1 : 1, 200); if (!ev) break;
      if (back && ev.tau >= bestFin - 40) { cursor = ev.tau - 1; continue; }
      cursor = back ? ev.tau - 1 : ev.tau + 1; const c = gen(ev); if (!c) continue; nb++;
      if (await tryBatch(c.W, c.L, c.plans, `${label}${ev.bit}@${ev.tau}`)) cursor = back ? Math.min(bestFin - 41, ev.tau + 20) : Math.max(1, ev.tau - 20);
    }
    log(`  ${label}扫描:${nb} 个事件,${sweepAcc} 次改进,用时 ${((Date.now() - tS) / 1000) | 0}s;当前 ${bestFin} 帧`);
  };
  if (structural) {
    await runEvents('大幅平移', (ev) => bigShiftCandidates(best, ev.bit, ev.tau, BIG, ev.prev, ev.next));
    await runEvents('脉冲缩放', (ev) => (ev.pair ? scalePulseCandidates(best, ev.bit, ev.tau, ev.pair, ev.prev, ev.next) : null));
    { const tS = Date.now(); let nb = 0; sweepAcc = 0; for (let p = 120; p < bestFin - 300 && live(); p += 40) { nb++; const c = insertCandidates(best, p); if (await tryBatch(c.W, c.L, c.plans, `插入@${p}`)) p -= 40; } log(`  插入扫描:${nb} 个位置,${sweepAcc} 次改进,用时 ${((Date.now() - tS) / 1000) | 0}s;当前 ${bestFin} 帧`); }
  }
  while (random && live()) {
    it++;
    const span = bestFin - 80 - from; const W = from + (rng() < late ? Math.floor(span * (1 - rng() * rng())) : Math.floor(rng() * span)); const L = [60, 120, 200, 300, 500][Math.floor(rng() * 5)];
    // 闸门:窗口之后 300~1500 帧处,且离终点至少 500 帧
    let gt = null, G0 = 0; if (gate) { G0 = Math.ceil((W + L + 300 + Math.floor(rng() * 1200)) / 25) * 25; if (G0 + 500 < bestFin) gt = gateAt(G0); }
    await g.commit(best.slice(0, W), 1, null, true);
    for (let r = 0; r < rounds; r++) {
      const win = best.slice(W, W + L); const plans = [win]; for (let b = 1; b < batch; b++) plans.push(mutateWin(win, rng));
      const tailArr = best.slice(W + L, gt ? G0 + 500 : bestFin); const post = gt ? best.slice(G0, bestFin) : null;
      const shifts = plans.map((_, i) => (gt && i > 0 && rng() < 0.5 ? Math.floor(rng() * 11) - 5 : 0));
      const maxFrames = bestFin - W + 300;
      // 注意:tailArr 与计划长度无关地接在每个计划后面(时间扭曲改变了窗口长度,恰好让它整体提前/推后)
      const res = await g.evalBatch(plans, { seg: 1, tail: 1, tailArr, maxFrames, fromCommit: true, ...(gt ? { gate: { p: gt.p, d: gt.d, post, shifts } } : {}) });
      framesSim += plans.length * (bestFin - W); if (gt) gated++;
      if (res[0].fin !== bestFin) { log(`  警告:基线候选完成帧 ${res[0].fin} != ${bestFin}(W=${W} G0=${gt ? G0 : '-'});跳过本轮`); break; }
      let bi = -1, bf = bestFin, bt = Infinity;
      for (let i = 1; i < res.length; i++) { const f = res[i].fin; if (f < 0 || res[i].dead) continue; const tcount = nToggles(plans[i]); if (f < bf || (f === bf && bi >= 0 && tcount < bt)) { bi = i; bf = f; bt = tcount; } else if (bi < 0 && f === bestFin && tcount <= nToggles(win) && rng() < 0.1) { bi = i; bf = f; bt = tcount; } }
      if (bi < 0) continue;
      const cand = rebuild(best, W, plans[bi], tailArr, post, res[bi].fc, shifts[bi], bf);
      const chk2 = await finishOf(cand); // 重建后整圈复核:必须与候选在 eval 里的完成帧一致
      if (chk2 !== bf) { rebuildFail++; if (rebuildFail <= 5) log(`  警告:重建复核 ${chk2} != ${bf}(W=${W} fc=${res[bi].fc} sh=${shifts[bi]}),丢弃`); break; }
      const improved = bf < bestFin; best = cand; bestFin = bf; if (improved) { acc++; if (gt) gatedAcc++; } else ties++;
      if (improved) { log(`  [${((Date.now() - t0) / 1000) | 0}s] 轮 ${it}: ${bestFin} 帧 (${(bestFin / 1000).toFixed(3)} s,比起点 -${fin0 - bestFin} 帧),窗口 W=${W} L=${L}${gt ? ` 闸门 ${G0} 越过 ${res[bi].fc} 偏移 ${shifts[bi]}` : ''}`); emit(); if (gate) await refreshPos(); }
      else if (gate) await refreshPos();
      break; // 状态已变,重新取快照
    }
    if (it % 20 === 0) log(`  [${((Date.now() - t0) / 1000) | 0}s] 已做 ${it} 轮(带闸门 ${gated} 批),改进 ${acc} 次(带闸门 ${gatedAcc}),持平接受 ${ties},重建失败 ${rebuildFail};当前 ${bestFin} 帧;约 ${(framesSim / Math.max(1, (Date.now() - t0) / 1000) / 1000).toFixed(0)}k 帧/s`);
  }
  const chk3 = await finishOf(best); if (chk3 !== bestFin) log(`警告:整圈复核 ${chk3} != ${bestFin}`);
  return { finishFrames: bestFin, startFrames: fin0, toggles: masksToToggles(best), iterations: it, improvements: acc, recheck: chk3 };
}
