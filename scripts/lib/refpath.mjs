// 参考轨迹势场:把"一圈已经跑通的完整路线"当中线。
// 动机(report 6.13):格子势场表达不了墙 / 环 / 长跳,但探索式规划能给出一圈能冲线的路线(慢、粗糙)。
// 把这圈的逐帧轨迹(3D 折线)当势场,滚动时域规划器就能沿着它优化速度:进度 s = 投影点沿折线的弧长,偏离 d = 到折线的 3D 距离
// (3D:环 / 多层立交里上下两层的路线在水平面上重叠,必须带高度)。折线上每个点还带着当时的车速,规划器可以用它当"入墙 / 起跳要保持的速度"。
//
// samples:[[帧, 车速km/h, flags, 完成帧, 已过检查点数, x, y, z, ...], ...](eval 的采样状态,按帧序)。
// 返回值与 buildProgressField 的接口兼容:query(x, z, y, cp) -> { s, d, above, vref };另有 length / startY / minY / nLevels / checkpoints。
// 检查点分段:cp = k 的车只和路线里"已过 k 个检查点"的那一段(前后各多留 pad 个采样,容忍刚过检查点时的错位)比较,
// 这样同一处 xz 位置上不同阶段的路线不会互相串。
export function buildTrajectoryProgress(samples, { pad = 15 } = {}) {
  const n = samples.length;
  if (n < 2) throw new Error('参考轨迹太短');
  const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n), V = new Float64Array(n), S = new Float64Array(n), CP = new Int32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i]; X[i] = s[5]; Y[i] = s[6]; Z[i] = s[7]; V[i] = s[1]; CP[i] = s[4];
    if (i) { acc += Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1], Z[i] - Z[i - 1]); } S[i] = acc;
  }
  const maxCp = CP[n - 1];
  const lo = new Int32Array(maxCp + 2).fill(n), hi = new Int32Array(maxCp + 2).fill(-1);
  for (let i = 0; i < n; i++) { const k = CP[i]; if (i < lo[k]) lo[k] = i; if (i > hi[k]) hi[k] = i; }
  for (let k = 0; k <= maxCp; k++) if (hi[k] < 0) { lo[k] = k ? lo[k - 1] : 0; hi[k] = k ? hi[k - 1] : 0; } // 没有出现过的阶段(不该发生):借用前一段
  let minY = Infinity; for (let i = 0; i < n; i++) if (Y[i] < minY) minY = Y[i];
  function query(x, z, y = null, cp = 0, flat = false) { // flat:四轮离地的状态只比水平位置(飞行中的高度本来就和参考不一样,只有落点 / 方向要对准)
    const k = Math.max(0, Math.min(maxCp, cp | 0)), yy = flat ? 0 : (y ?? Y[0]), fy = flat ? 0 : 1;
    const a = Math.max(0, lo[k] - pad), b = Math.min(n - 1, hi[k] + pad);
    let best = Infinity, bi = a, bt = 0;
    for (let i = a; i < b; i++) {
      const ax = X[i], ay = fy * Y[i], az = Z[i], bx = X[i + 1] - ax, by = fy * (Y[i + 1] - Y[i]), bz = Z[i + 1] - az;
      const len2 = bx * bx + by * by + bz * bz; let t = len2 > 0 ? ((x - ax) * bx + (yy - ay) * by + (z - az) * bz) / len2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + t * bx), dy = yy - (ay + t * by), dz = z - (az + t * bz), d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    const j = Math.min(n - 1, bi + 1);
    return { s: S[bi] + bt * (S[j] - S[bi]), d: Math.sqrt(best), above: 0, vref: V[bi] * (1 - bt) + V[j] * bt };
  }
  const FR = Int32Array.from(samples, (q) => q[0]);
  return { kind: 'trajectory', length: acc, arc: S, frameAt: FR, query, startY: Y[0], minY: minY - 25, nCells: n, nLevels: maxCp + 1, checkpoints: maxCp, waypoints: [] };
}
