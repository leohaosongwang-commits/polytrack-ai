// 引导线(自动驾驶时画在车前面的"赛车线"):纯数学部分,不碰 DOM / WebGL,所以能在 Node 里单测。
//
// 思路:方案是确定性的,把它在评估引擎里整圈跑一遍(每 GUIDE_STEP 帧采一个状态),得到"车接下来要走的轨迹";
// 再用游戏自己的 three.js 相机矩阵(projectionMatrix * viewMatrix)把这条轨迹投影到屏幕上,画成一条贴地的发光缎带:
//   · 颜色 = 那一刻方案按的键(油门 薄荷绿 / 刹车 红 / 滑行 琥珀),所以能提前看出哪里要刹车;
//   · 离车越远越淡,起点在车头前面几米(不盖住车),缎带上有向前流动的箭头;
//   · 2D 叠加画不出遮挡,所以用"地平线裁剪"补一点:沿路线从近到远,某个点投影后比前面所有点的最高屏幕位置还低,就说明被前面的坡顶挡住了,淡出。
// 矩阵是列主序(WebGL / three.js 惯例);世界坐标与物理侧坐标一致(渲染里车的 modelMatrix 平移 == 物理侧位置,已实测)。
export const GUIDE_STEP = 10; // 采样间隔(帧;1 帧 = 1 ms),30 m/s 时点距 0.3 m
const popcount4 = (v) => (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1);
const norm3 = (x, y, z) => { const l = Math.hypot(x, y, z); return l > 1e-9 ? [x / l, y / l, z / l] : [0, 0, 0]; };

/** 键位掩码 -> 缎带颜色(0..1)。1 = W 油门,4 = S 刹车 */
export function actColor(mask) {
  if (mask & 4) return [1.0, 0.34, 0.26];
  if (mask & 1) return [0.22, 0.98, 0.76];
  return [1.0, 0.82, 0.32];
}

/**
 * samples:评估引擎的采样状态 [[帧, 车速, flags, 完成帧, cp, x, y, z, qx, qy, qz, qw], ...](按帧序,间隔 GUIDE_STEP)
 * masks:逐帧键位掩码(可选,用来给缎带上色)
 * 返回:贴地缎带的中心线 + 横向单位向量 + 弧长,供 projectGuide 使用
 */
export function buildGuidePath(samples, masks = null, { drop = 0.62, smooth = 2 } = {}) {
  const n = samples.length; if (n < 4) throw new Error('轨迹太短,画不了引导线');
  const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n), ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n);
  const frames = new Int32Array(n), speed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i]; frames[i] = s[0]; speed[i] = s[1]; px[i] = s[5]; py[i] = s[6]; pz[i] = s[7];
    if (popcount4((s[2] >> 3) & 15) >= 2) { // 至少两个轮子着地:车身朝上的方向可信(坡道 / 倾斜路面);腾空时用世界的上
      const x = s[8], y = s[9], z = s[10], w = s[11];
      ux[i] = 2 * (x * y - w * z); uy[i] = 1 - 2 * (x * x + z * z); uz[i] = 2 * (y * z + w * x);
    } else { ux[i] = 0; uy[i] = 1; uz[i] = 0; }
  }
  const box = (a) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) { let t = 0, c = 0; for (let k = Math.max(0, i - smooth); k <= Math.min(n - 1, i + smooth); k++) { t += a[k]; c++; } o[i] = t / c; } return o; };
  const sx = box(px), sy = box(py), sz = box(pz), sux = box(ux), suy = box(uy), suz = box(uz);
  const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n), rx = new Float64Array(n), ry = new Float64Array(n), rz = new Float64Array(n), arc = new Float64Array(n);
  let prev = [1, 0, 0];
  for (let i = 0; i < n; i++) {
    const u = norm3(sux[i], suy[i], suz[i]); const uu = u[0] || u[1] || u[2] ? u : [0, 1, 0];
    cx[i] = sx[i] - drop * uu[0]; cy[i] = sy[i] - drop * uu[1]; cz[i] = sz[i] - drop * uu[2];
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    const d = norm3(sx[b] - sx[a], sy[b] - sy[a], sz[b] - sz[a]);
    // 右向量 = 行进方向 x 车身上方向(停着不动时 d 为 0,沿用上一个)
    let r = norm3(d[1] * uu[2] - d[2] * uu[1], d[2] * uu[0] - d[0] * uu[2], d[0] * uu[1] - d[1] * uu[0]);
    if (!(r[0] || r[1] || r[2])) r = prev; else prev = r;
    rx[i] = r[0]; ry[i] = r[1]; rz[i] = r[2];
    if (i) arc[i] = arc[i - 1] + Math.hypot(cx[i] - cx[i - 1], cy[i] - cy[i - 1], cz[i] - cz[i - 1]);
  }
  // 颜色:每个采样点取附近几个采样点按键的平均,避免短促的点按让颜色闪
  const col = new Float32Array(3 * n);
  if (masks) {
    for (let i = 0; i < n; i++) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) { const m = masks[Math.min(masks.length - 1, frames[k])] | 0; const [cr, cg, cb] = actColor(m); r += cr; g += cg; b += cb; c++; }
      col[3 * i] = r / c; col[3 * i + 1] = g / c; col[3 * i + 2] = b / c;
    }
  } else for (let i = 0; i < n; i++) { col[3 * i] = 0.22; col[3 * i + 1] = 0.98; col[3 * i + 2] = 0.76; }
  return { n, step: n > 1 ? frames[1] - frames[0] : GUIDE_STEP, frames, speed, cx, cy, cz, rx, ry, rz, arc, col, length: arc[n - 1] };
}

/** 世界坐标点 -> 裁剪坐标(VP 是列主序 4x4:projection * view) */
export function clipOf(VP, x, y, z, out = [0, 0, 0, 0]) {
  out[0] = VP[0] * x + VP[4] * y + VP[8] * z + VP[12]; out[1] = VP[1] * x + VP[5] * y + VP[9] * z + VP[13];
  out[2] = VP[2] * x + VP[6] * y + VP[10] * z + VP[14]; out[3] = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
  return out;
}
export function mulMat4(a, b) { // a * b,列主序
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let t = 0; for (let k = 0; k < 4; k++) t += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = t; }
  return o;
}
const smooth01 = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

export const GUIDE_DEFAULTS = { ahead: 6, range: 170, hCore: 0.55, hOut: 1.4, baseAlpha: 0.9, rowSpacing: 0.6, chevSpacing: 7, chevHalf: 0.62, minHalfNdc: 0.004, maxWiden: 14 };

/**
 * 把"车当前所在帧 f 往前 range 米"的缎带投影到屏幕(NDC),顶点格式 [x, y, r, g, b, a] x 4 个/行(外左 0、内左 a、内右 a、外右 0:边缘羽化)。
 * 返回 { verts: Float32Array, idx: Uint32Array, nVerts, nIdx, rows },箭头的三角形接在同一个数组后面。
 * VP:projection * view;time:秒(箭头流动动画用);opts 见 GUIDE_DEFAULTS。
 */
export function projectGuide(path, f, VP, time = 0, opts = {}) {
  const o = { ...GUIDE_DEFAULTS, ...opts };
  const { n, frames, arc, cx, cy, cz, rx, ry, rz, col } = path;
  const t = (f - frames[0]) / path.step; const i0 = Math.max(0, Math.min(n - 2, Math.floor(t))); const fr = Math.max(0, Math.min(1, t - i0));
  const sCar = arc[i0] + fr * (arc[i0 + 1] - arc[i0]), sStart = sCar + o.ahead, sEnd = sCar + o.range;
  let j = i0; while (j < n - 1 && arc[j] < sStart) j++;
  const maxRows = Math.ceil(o.range / o.rowSpacing) + 10, maxChev = Math.ceil(o.range / o.chevSpacing) + 4;
  const verts = new Float32Array((maxRows * 4 + maxChev * 6) * 6), idx = new Uint32Array(maxRows * 18 + maxChev * 12); let nv = 0, ni = 0, rows = 0;
  const rowS = [], rowA = [], rowR = [];
  const c4 = [0, 0, 0, 0]; let hMax = -Infinity, lastArc = -1e9;
  const pushV = (x, y, r, g, b, a) => { const k = nv * 6; verts[k] = x; verts[k + 1] = y; verts[k + 2] = r; verts[k + 3] = g; verts[k + 4] = b; verts[k + 5] = a; return nv++; };
  for (; j < n; j++) {
    const s = arc[j]; if (s > sEnd) break;
    if (s - lastArc < o.rowSpacing && j < n - 1) continue; lastArc = s;
    clipOf(VP, cx[j], cy[j], cz[j], c4); if (!(c4[3] > 0.2)) { if (rows) break; else continue; } // 在相机后面 / 太近:缎带到此为止
    const ndcX = c4[0] / c4[3], ndcY = c4[1] / c4[3];
    const vis = hMax === -Infinity ? 1 : Math.max(0, Math.min(1, 1 + (ndcY - hMax) / 0.03)); // 地平线裁剪:低于前面最高点就淡出
    if (ndcY > hMax) hMax = ndcY;
    // 远处缎带在屏幕上会细成一根线:保证核心至少 minHalfNdc 宽(横向放宽,最多 maxWiden 倍),远处也看得见
    clipOf(VP, cx[j] + rx[j] * o.hCore, cy[j] + ry[j] * o.hCore, cz[j] + rz[j] * o.hCore, c4);
    const half = c4[3] > 0.05 ? Math.abs(c4[0] / c4[3] - ndcX) : 0; const k = half > 1e-9 ? Math.min(o.maxWiden, Math.max(1, o.minHalfNdc / half)) : 1;
    const d = s - sCar; const alpha = o.baseAlpha * smooth01((d - o.ahead) / 8) * Math.pow(Math.max(0, 1 - d / o.range), 0.9) * vis;
    const r = col[3 * j], g = col[3 * j + 1], b = col[3 * j + 2];
    const pts = [[-o.hOut * k, 0], [-o.hCore * k, 1], [o.hCore * k, 1], [o.hOut * k, 0]]; const base = nv; let ok = true;
    for (const [off, solid] of pts) {
      clipOf(VP, cx[j] + rx[j] * off, cy[j] + ry[j] * off, cz[j] + rz[j] * off, c4);
      if (!(c4[3] > 0.05)) { ok = false; break; }
      pushV(c4[0] / c4[3], c4[1] / c4[3], r, g, b, solid ? alpha : 0);
    }
    if (!ok) { nv = base; break; }
    if (rows) { const p = base - 4; for (let q = 0; q < 3; q++) { idx[ni++] = p + q; idx[ni++] = p + q + 1; idx[ni++] = base + q; idx[ni++] = p + q + 1; idx[ni++] = base + q + 1; idx[ni++] = base + q; } }
    rowS.push(s); rowA.push(alpha); rowR.push(j); rows++;
  }
  // 箭头:每 chevSpacing 米一个,整体随时间向前流动
  const phase = (time * 9) % o.chevSpacing;
  if (rows > 1) {
    let k = 0; const first = rowS[0];
    for (let s = Math.ceil((first - phase) / o.chevSpacing) * o.chevSpacing + phase; s <= rowS[rowS.length - 1]; s += o.chevSpacing) {
      while (k < rowS.length - 2 && rowS[k + 1] < s) k++;
      const j0 = rowR[k], j1 = rowR[Math.min(rowR.length - 1, k + 1)], sp = rowS[k + 1] - rowS[k]; const u = sp > 1e-6 ? Math.max(0, Math.min(1, (s - rowS[k]) / sp)) : 0;
      const a = (rowA[k] + (rowA[Math.min(rowA.length - 1, k + 1)] - rowA[k]) * u) * 0.95; if (a < 0.02) continue;
      const mx = cx[j0] + (cx[j1] - cx[j0]) * u, my = cy[j0] + (cy[j1] - cy[j0]) * u, mz = cz[j0] + (cz[j1] - cz[j0]) * u;
      const dx = cx[j1] - cx[j0], dy = cy[j1] - cy[j0], dz = cz[j1] - cz[j0]; const dl = Math.hypot(dx, dy, dz); if (dl < 1e-6) continue;
      const fx = dx / dl, fy = dy / dl, fz = dz / dl, qx = rx[j0], qy = ry[j0], qz = rz[j0];
      const H = o.chevHalf; const shape = [[0, 0.62], [H, -0.1], [H, -0.46], [0, 0.04], [-H, -0.46], [-H, -0.1]]; const bv = nv; let ok = true;
      for (const [lx, lf] of shape) { clipOf(VP, mx + qx * lx + fx * lf, my + qy * lx + fy * lf + 0.02, mz + qz * lx + fz * lf, c4); if (!(c4[3] > 0.05)) { ok = false; break; } pushV(c4[0] / c4[3], c4[1] / c4[3], 1, 1, 1, a); }
      if (!ok) { nv = bv; continue; }
      for (const t3 of [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]]) { idx[ni++] = bv + t3[0]; idx[ni++] = bv + t3[1]; idx[ni++] = bv + t3[2]; }
    }
  }
  return { verts, idx, nVerts: nv, nIdx: ni, rows };
}
