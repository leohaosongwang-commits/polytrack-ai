// 名次 <-> 完成时间:在"按完成帧升序、可按下标取"的榜单上做二分查找,以及"目标定了以后该用哪条方案"的选择规则。
// 纯函数,不碰网络 / 页面:扩展(extension/src/core.js)把 lbAt(skip) 接到榜单的只读 GET 上,单元测试接到一份假榜单上。
//
// lbAt(i) -> Promise<{ total, entry: { frames, id } | null }>:榜单(已验证、完成帧升序)的第 i 条(0 起);total = 榜单总条数。
// 目标有两种:{ mode: 'rank', value: 名次 }(要多少名)或 { mode: 'sec', value: 秒数 }(要多少秒),value 都是 >= 1 的整数。

/** 方案的完成帧和目标相差不超过这么多帧,就算"就在目标附近",直接用自己的方案(1 帧 = 1 ms) */
export const TARGET_TOL_FRAMES = 15;
const MAX_PROBES = 40; // 榜单再大,二分也不该超过这个次数(2^40 ≈ 10^12);超了说明榜单数据不是升序的

/** 榜单里有多少条的完成帧严格小于 frames(= 第一个 >= frames 的下标)。要比这条更快的人数 + 1 = 这个成绩在榜单上的名次(同帧并列的排在后面) */
export async function countFaster(lbAt, total, frames) {
  let lo = 0, hi = total, probes = 0;
  while (lo < hi) {
    if (++probes > MAX_PROBES) throw new Error('二分查找次数超限(榜单不是按完成帧升序的?)');
    const mid = Math.floor((lo + hi) / 2); const { entry } = await lbAt(mid);
    if (!entry || !Number.isFinite(entry.frames)) throw new Error('榜单数据不完整');
    if (entry.frames < frames) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * 把目标换成"榜单上的哪一条":
 *  - rank:取第 value 名那一条(value 超过总人数就取最后一名,clamped = true);frames = 它的完成帧;
 *  - sec:目标时间 = value × 1000 帧;二分出它在榜单上的名次,再取完成帧最接近它的那一条(并列取不更快的那条)。
 * 返回 { mode, total, rank(名次;sec 时可能是 total + 1 = 比最后一名还慢), frames(目标完成帧), entry(最接近的那一条), idx(entry 的下标), clamped }
 */
export async function resolveTarget(lbAt, { mode, value }) {
  const v = Math.floor(Number(value)); if (!(v >= 1)) throw new Error('目标要填 >= 1 的整数');
  const first = await lbAt(0); const total = first.total;
  if (!(total >= 1) || !first.entry) throw new Error('榜单是空的');
  if (mode === 'rank') {
    const idx = Math.min(v, total) - 1; const { entry } = idx === 0 ? first : await lbAt(idx);
    if (!entry || !Number.isFinite(entry.frames)) throw new Error('榜单数据不完整');
    return { mode, total, rank: idx + 1, frames: entry.frames, entry, idx, clamped: v > total };
  }
  if (mode === 'sec') {
    const want = v * 1000; const lo = await countFaster(lbAt, total, want);
    const cand = []; if (lo > 0) cand.push(lo - 1); if (lo < total) cand.push(lo); // lo - 1 比目标快,lo 不比目标快
    const got = await Promise.all(cand.map((i) => (i === 0 ? first : lbAt(i))));
    let bi = -1, be = null, bd = Infinity;
    cand.forEach((i, k) => { const e = got[k].entry; if (!e || !Number.isFinite(e.frames)) return; const d = Math.abs(e.frames - want); if (d < bd || (d === bd && e.frames >= want)) { bi = i; be = e; bd = d; } });
    if (!be) throw new Error('榜单数据不完整');
    return { mode, total, rank: lo + 1, frames: want, entry: be, idx: bi, clamped: false };
  }
  throw new Error('未知的目标类型');
}

/**
 * 目标定了以后用哪条方案:
 *  'own'     自己的现成方案就在目标附近(相差 <= tol 帧),直接用;
 *  'replay'  自己的方案比目标快得多(或根本没有方案):逐帧打磨过的方案没法调慢(整体后移 / 插入刹车 / 松油门,实测几乎都跑不到终点),
 *            所以用榜单上那一名的回放(过游戏 Verify 后照着开),成绩就是那一名的成绩;
 *  'improve' 自己的方案比目标慢:先走"最快"流程想办法提速,到不了就按能到的开。
 * 要第 1 名(或更快)时越快越好:有方案且不慢于第 1 名(+ tol)就用自己的。
 */
export function chooseForTarget(haveFrames, t, tol = TARGET_TOL_FRAMES) {
  if (haveFrames == null) return 'replay';
  if (t.mode === 'rank' && t.rank <= 1) return haveFrames <= t.frames + tol ? 'own' : 'improve';
  if (haveFrames > t.frames + tol) return 'improve';
  if (haveFrames >= t.frames - tol) return 'own';
  return 'replay';
}
