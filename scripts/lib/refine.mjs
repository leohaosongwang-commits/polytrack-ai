// 压圈速(参考轨迹 + 窗口重规划):给一圈已经跑通的完整路线(例如探索式规划出的、慢而粗糙的一圈),把它的轨迹当势场,
// 沿弧长切成一个个窗口,逐个窗口用滚动时域规划器重新规划;窗口结束后接回原路线的剩余部分,整圈重新评估,更快才接受。
//
// 为什么按窗口而不是整圈重规划:整圈重规划(--refine)在 slalom_mini 上很有效(8.9 -> 7.2 s),但在 summer3 上会停滞在长跳前 ——
// 规划器自己跑出来的入跳速度不够。窗口版保证:前缀逐帧就是原路线(状态完全一致),窗口之后接回原路线的尾巴,不比原来快就整个丢弃,所以**不会变差**,
// 规划失败 / 停滞的窗口只是被跳过。
//
// 一个窗口:
//   1. 前缀 = 当前这圈的前 fa 帧(fa = 路线第一次越过弧长 sa 的帧)-> 提交为规划器的前缀;
//   2. 规划器在"轨迹势场 + 速度门槛"下继续规划,到达弧长 sb 就停(stopS);最后一个窗口一直跑到冲线;
//   3. 尾巴 = 原路线在"弧长 >= 停下时进度"的那一帧起的逐帧按键(按路线上的位置对齐,而不是按时间);
//   4. 候选整圈 = 规划出的 + 尾巴,从起点整圈评估;完成帧更小才接受。
import { buildTrajectoryProgress } from './refpath.mjs';

/** 一圈逐帧掩码 -> 轨迹采样状态(每 20 帧一个,外加冲线时的终态) */
export async function lapPath(g, masks, every = 20) {
  const [r] = await g.evalBatch([Array.from(masks)], { seg: 1, tail: 1, maxFrames: masks.length + 200, sampleEvery: every });
  const pts = r.smp.slice(); if (r.last && (!pts.length || pts[pts.length - 1][0] < r.last[0])) pts.push(r.last);
  return pts;
}

const expand = (committed, durs) => { const out = []; for (let i = 0; i < committed.length; i++) for (let j = 0; j < durs[i]; j++) out.push(committed[i]); return Uint8Array.from(out); };

/**
 * @param S      已经 init() 过的 Solver(potential 随意,这里会把它的势场换成当前这圈的轨迹)
 * @param masks  当前最好的一圈(逐帧掩码),fin = 它的完成帧
 * 返回 { masks, fin, log: [{pass, window, from, to, result}] }
 */
export async function refineWindows(g, S, masks0, fin0, { windowM = 250, passes = 2, log = () => {}, cancel = null, maxWindows = Infinity } = {}) {
  let masks = Uint8Array.from(masks0), fin = fin0; const history = []; let tried = 0;
  S.o.stallRetries = 1; S.o.stallTotalMax = 1;
  for (let pass = 1; pass <= passes; pass++) {
    let sa = pass % 2 ? 0 : windowM / 2; // 第二遍错开半个窗口
    for (let w = 1; ; w++) {
      if (cancel?.() || tried >= maxWindows) return { masks, fin, log: history };
      const P = buildTrajectoryProgress(await lapPath(g, masks));
      if (sa >= P.length - 30) break;
      const lastWin = sa + windowM >= P.length - windowM * 0.4, sb = lastWin ? Infinity : sa + windowM;
      const idxAt = (s) => { let i = 0; while (i < P.arc.length - 1 && P.arc[i] < s) i++; return i; };
      const fa = P.frameAt[idxAt(sa)];
      S.prog = P; S.minY = P.minY; S.resetRun();
      S.o.prefix = { committed: Array.from(masks.slice(0, fa)), durs: Array(fa).fill(1) }; S.o.stopS = lastWin ? null : sb;
      const t0 = Date.now(); let res = null, note = '';
      tried++;
      try {
        const A = await S.plan();
        let cand;
        if (A.stopped) { // 窗口结束:接回原路线的尾巴
          const planned = expand(A.committed, A.durs), fb = P.frameAt[idxAt(A.stopped.s)];
          cand = new Uint8Array(planned.length + Math.max(0, masks.length - fb)); cand.set(planned, 0); cand.set(masks.subarray(fb), planned.length);
        } else cand = A.masks; // 最后一个窗口:规划器自己冲线
        const f2 = await S.finishOf(cand);
        if (f2 > 0 && f2 < fin) { note = `${fin} -> ${f2}`; res = f2; masks = cand.slice(0, f2); fin = f2; }
        else note = f2 > 0 ? `${f2} 帧,不比 ${fin} 快` : '接回尾巴后没能冲线';
      } catch (e) { note = '规划失败:' + String(e.message).slice(0, 60); }
      log(`  [压圈速] 第 ${pass} 遍 窗口 ${w}(弧长 ${sa.toFixed(0)}~${lastWin ? '终点' : sb.toFixed(0)} m / ${P.length.toFixed(0)}):${note},${((Date.now() - t0) / 1000).toFixed(0)}s`);
      history.push({ pass, window: w, from: sa, to: lastWin ? null : sb, result: res, note });
      if (lastWin) break;
      sa += windowM;
    }
  }
  S.o.prefix = null; S.o.stopS = null;
  return { masks, fin, log: history };
}
