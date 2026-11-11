// 赛道进度势能:由游戏自己的解析器给出的部件表(trackInfo)重建"起点 -> 终点"的中线折线,
// 然后把任意世界坐标投影到折线上得到 (s = 沿中线的弧长, d = 水平偏离中线的距离)。
// 做法:从终点格子对道路格子(类别 Special/Road/RoadTurns/RoadWide)做 BFS(4 邻接,允许相邻层高差 1),
// 同一 BFS 层的格子取质心 => 一个路点。原型限制:假设赛道是"一条主路",不处理分叉/重叠的多层立交。
const SIZE = 5; // 游戏 partSize:格子边长 5 m;格子 c 覆盖世界区间 [5c, 5c+5)
const ROAD_CATS = new Set([0, 1, 2, 3]);
const key = (x, y, z) => `${x},${y},${z}`;

export function buildProgress(track) {
  const cells = new Map(); let startPart = null; const finishCells = []; const cpParts = [];
  for (const p of track.parts) {
    if (!ROAD_CATS.has(p.category)) continue;
    for (const c of p.cells) cells.set(key(...c), c);
    if (p.startOrder != null) startPart = p;
    if (track.info[p.partId]?.detector?.type === 1) for (const c of p.cells) finishCells.push(c);
    if (track.info[p.partId]?.detector?.type === 0) cpParts.push(p);
  }
  if (!startPart || !finishCells.length) throw new Error('赛道缺少起点或终点');
  const dist = new Map(); const q = [];
  for (const c of finishCells) { dist.set(key(...c), 0); q.push(c); }
  for (let h = 0; h < q.length; h++) {
    const [x, y, z] = q[h]; const d = dist.get(key(x, y, z));
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
      const k = key(x + dx, y + dy, z + dz);
      if (cells.has(k) && !dist.has(k)) { dist.set(k, d + 1); q.push(cells.get(k)); }
    }
  }
  const startCell = startPart.cells[0];
  const D = Math.max(...startPart.cells.map((c) => dist.get(key(...c)) ?? -1));
  if (D < 0) throw new Error('起点与终点在道路格子上不连通');
  const byLevel = new Map();
  for (const [k, v] of dist) { if (v > D) continue; (byLevel.get(v) ?? byLevel.set(v, []).get(v)).push(cells.get(k)); }
  const wp = [];
  for (let k = D; k >= 0; k--) {
    const w = byLevel.get(k); if (!w) continue;
    const n = w.length;
    wp.push({ x: (w.reduce((a, c) => a + c[0], 0) / n) * SIZE + SIZE / 2, y: (w.reduce((a, c) => a + c[1], 0) / n) * SIZE, z: (w.reduce((a, c) => a + c[2], 0) / n) * SIZE + SIZE / 2 });
  }
  let s = 0; wp[0].s = 0;
  for (let i = 1; i < wp.length; i++) { s += Math.hypot(wp[i].x - wp[i - 1].x, wp[i].z - wp[i - 1].z); wp[i].s = s; }
  const L = s;
  const xs = Float64Array.from(wp, (w) => w.x), zs = Float64Array.from(wp, (w) => w.z), ss = Float64Array.from(wp, (w) => w.s);
  /** 投影到折线:返回 {s, d};s 在 [0, L] */
  function query(x, z) {
    let best = Infinity, bs = 0;
    for (let i = 0; i + 1 < xs.length; i++) {
      const ax = xs[i], az = zs[i], bx = xs[i + 1] - ax, bz = zs[i + 1] - az;
      const len2 = bx * bx + bz * bz; let t = len2 > 0 ? ((x - ax) * bx + (z - az) * bz) / len2 : 0; t = Math.max(0, Math.min(1, t));
      const dx = x - (ax + t * bx), dz = z - (az + t * bz); const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bs = ss[i] + t * Math.sqrt(len2); }
    }
    return { s: bs, d: Math.sqrt(best) };
  }
  const startY = track.start?.position?.y ?? wp[0].y;
  return { length: L, waypoints: wp, query, startY, nCells: cells.size, nLevels: wp.length, checkpoints: cpParts.length };
}

// ======================================================================================
// 分段距离场版本(用于多层 / 带跳跃的赛道,例如官方 Summer 1)
// ---------------------------------------------------------------------------------------
// 把赛道看成"起点 -> 检查点 0 -> 检查点 1 -> ... -> 终点"的有序分段(游戏要求按序通过检查点,状态里的 nextCheckpointIndex 就是当前段号)。
// 对每一段,以该段的目标(检查点 / 终点)为源,在"可行驶格子"图上做 Dijkstra:
//   * 连续邻接(4 邻接,层差 <= 1):代价 5 m/格;
//   * 跳跃边:水平距离 <= jumpMax 格、层差在 [-jumpUp, +jumpUp] 内,代价 = 实际水平距离 x jumpCost(略大于 1,只用来"没路时才跳")。
// 车在第 k 段、位于某格 c 时,进度 s = 前 k 段累计长度 + (第 k 段长度 - dist_k(c))。段与段之间连续。
// 位置 -> 格子:在水平 3x3 范围内找 3D 加权最近的格子;找不到(在空中跨缺口 / 已掉出)就扩大搜索;再用到邻格梯度做亚格插值。
export function buildProgressField(track, { cats = [0, 1, 2, 3, 4, 5], jumpMax = 6, jumpUp = 5, jumpCost = 1.5 } = {}) {
  const allowed = new Set(cats); const SZ = SIZE;
  const idxOf = new Map(); const cellList = [];
  for (const p of track.parts) if (allowed.has(p.category)) for (const c of p.cells) { const k = key(...c); if (!idxOf.has(k)) { idxOf.set(k, cellList.length); cellList.push(c); } }
  const n = cellList.length;
  const col = new Map(); // "x,z" -> [[y, idx]]
  cellList.forEach((c, i) => { const k = c[0] + ',' + c[2]; (col.get(k) ?? col.set(k, []).get(k)).push([c[1], i]); });
  const dist1 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

  function dijkstra(sources) {
    const d = new Float64Array(n).fill(Infinity); const heap = [];
    const push = (dd, i) => { heap.push([dd, i]); let j = heap.length - 1; while (j > 0) { const p = (j - 1) >> 1; if (heap[p][0] <= heap[j][0]) break; [heap[p], heap[j]] = [heap[j], heap[p]]; j = p; } };
    const pop = () => { const t = heap[0]; const l = heap.pop(); if (heap.length) { heap[0] = l; let j = 0; for (;;) { let m = j; const a = 2 * j + 1, b = a + 1; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === j) break; [heap[m], heap[j]] = [heap[j], heap[m]]; j = m; } } return t; };
    for (const i of sources) { d[i] = 0; push(0, i); }
    while (heap.length) {
      const [dd, i] = pop(); if (dd > d[i]) continue;
      const [x, y, z] = cellList[i];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
        const j = idxOf.get(key(x + dx, y + dy, z + dz)); if (j === undefined) continue;
        const nd = dd + SZ; if (nd < d[j]) { d[j] = nd; push(nd, j); }
      }
      for (let dx = -jumpMax; dx <= jumpMax; dx++) for (let dz = -jumpMax; dz <= jumpMax; dz++) {
        const h = Math.hypot(dx, dz); if (h <= 1.5 || h > jumpMax) continue;
        const ys = col.get((x + dx) + ',' + (z + dz)); if (!ys) continue;
        for (const [yy, j] of ys) { if (Math.abs(yy - y) > jumpUp) continue; const nd = dd + h * SZ * jumpCost; if (nd < d[j]) { d[j] = nd; push(nd, j); } }
      }
    }
    return d;
  }

  // 有序锚点:起点 -> 检查点(按 cpOrder)-> 终点
  const sel = (pred) => track.parts.filter(pred);
  const startPart = sel((p) => p.startOrder != null)[0];
  const cps = sel((p) => track.info[p.partId]?.detector?.type === 0 && p.cpOrder != null).sort((a, b) => a.cpOrder - b.cpOrder);
  const fin = sel((p) => track.info[p.partId]?.detector?.type === 1);
  if (!startPart || !fin.length) throw new Error('赛道缺少起点或终点');
  const srcOf = (parts) => parts.flatMap((p) => p.cells.map((c) => idxOf.get(key(...c)))).filter((i) => i !== undefined);
  const targets = [...cps.map((p) => [p]), fin];
  const fields = targets.map((t) => dijkstra(srcOf(t)));
  const startIdx = Math.min(...startPart.cells.map((c) => idxOf.get(key(...c))).filter((i) => i !== undefined));
  const startIdxs = startPart.cells.map((c) => idxOf.get(key(...c))).filter((i) => i !== undefined);
  // 各段长度 = 该段起点(上一个检查点 / 起点)到该段目标的距离
  const segLen = []; const offset = []; let acc = 0;
  for (let k = 0; k < targets.length; k++) {
    const fromIdxs = k === 0 ? startIdxs : srcOf(targets[k - 1]);
    const L = Math.max(...fromIdxs.map((i) => fields[k][i]).filter(Number.isFinite), 0);
    if (!Number.isFinite(L) || L === 0 && k === 0) throw new Error(`第 ${k} 段不连通`);
    segLen.push(L); offset.push(acc); acc += L;
  }
  const total = acc;

  function locate(x, y, z) { // -> 最近格子下标 + 水平偏离
    const cx = Math.floor(x / SZ), cz = Math.floor(z / SZ), cy = y / SZ;
    for (const R of [1, 3, 8, 20]) {
      let best = -1, bs = Infinity, bd = 0;
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const ys = col.get((cx + dx) + ',' + (cz + dz)); if (!ys) continue;
        for (const [yy, i] of ys) {
          const hx = (cx + dx + 0.5) * SZ - x, hz = (cz + dz + 0.5) * SZ - z; const h = Math.hypot(hx, hz);
          const v = (yy + 0.5 - cy) * SZ; const vs = v > 0 ? v * 3 : -v * 1; // 车下方的格子更合理:在其上方的格子加重惩罚
          const s = h + vs; if (s < bs) { bs = s; best = i; bd = h; }
        }
      }
      if (best >= 0) return { i: best, h: bd };
    }
    return { i: -1, h: Infinity };
  }
  function query(x, z, y = null, cp = 0) {
    const k = Math.max(0, Math.min(targets.length - 1, cp | 0));
    const yy = y ?? track.start?.position?.y ?? 0;
    const { i, h } = locate(x, yy, z);
    if (i < 0) return { s: offset[k], d: 99 };
    // 亚格插值:朝梯度(邻格中距离最小者)方向的投影修正
    const c = cellList[i]; const f = fields[k]; let g = null, gd = f[i];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) { const j = idxOf.get(key(c[0] + dx, c[1] + dy, c[2] + dz)); if (j !== undefined && f[j] < gd) { gd = f[j]; g = [dx, dz]; } }
    let corr = 0; if (g) corr = Math.max(-SZ / 2, Math.min(SZ / 2, ((x - (c[0] + 0.5) * SZ) * g[0] + (z - (c[2] + 0.5) * SZ) * g[1]))); // 沿 g 方向前进 corr 米 => 距离减少
    const dk = Math.max(0, f[i] - corr);
    const s = offset[k] + Math.max(0, Math.min(segLen[k], segLen[k] - dk));
    return { s, d: Math.max(0, h - SZ / 2) };
  }
  const startY = track.start?.position?.y ?? 0;
  const minY = Math.min(...cellList.map((c) => c[1])) * SZ - 15;
  return { kind: 'field', length: total, segLen, offset, query, startY, minY, nCells: n, nLevels: targets.length, checkpoints: cps.length, waypoints: [] };
}
