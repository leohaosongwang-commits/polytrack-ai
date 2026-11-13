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
//   * 跳跃边:水平距离 <= jumpMax 格、向上不超过 jumpRise 层、向下不超过 jumpUp 层,代价 = 实际水平距离 x jumpCost(略大于 1,只用来"没路时才跳")。
// 车在第 k 段、位于某格 c 时,进度 s = 前 k 段累计长度 + (第 k 段长度 - dist_k(c))。段与段之间连续。
// 位置 -> 格子:在水平 3x3 范围内找 3D 加权最近的格子;找不到(在空中跨缺口 / 已掉出)就扩大搜索;再用到邻格梯度做亚格插值。
export function buildProgressField(track, { cats = [0, 1, 2, 3, 4, 5], solidCats = [5], jumpMax = 6, jumpUp = 5, jumpRise = 1, rampJumpMax = 16, jumpCost = 1.5, blocked = null, strict = false } = {}) {
  // blocked:不参与势场的格子("x,y,z" 集合)—— 规划器发现势场认为"能走"但物理上走不通的路线后,把那段路线上的零件整块屏蔽再重建(见 solver.repairPotential)。strict:某段不连通就抛错。
  const allowed = new Set(cats); const SZ = SIZE;
  const idxOf = new Map(); const cellList = [];
  // 实心方块(category 5,4x4x1 的立方体,设计者把它们叠起来当桥墩 / 墙):正上方还有别的格子,就是被压在下面的实心体,不能行驶 —— 否则势场会"穿墙"规划路线
  const solid = new Set(solidCats); const occ = new Set();
  for (const p of track.parts) if (allowed.has(p.category)) for (const c of p.cells) occ.add(key(...c));
  for (const p of track.parts) if (allowed.has(p.category)) for (const c of p.cells) { if (solid.has(p.category) && !(track.info[p.partId]?.detector || p.startOrder != null) && occ.has(key(c[0], c[1] + 1, c[2]))) continue; /* 起点 / 检查点 / 终点不删 */ const k = key(...c); if (blocked?.has(k) && !(track.info[p.partId]?.detector || p.startOrder != null)) continue; if (!idxOf.has(k)) { idxOf.set(k, cellList.length); cellList.push(c); } }
  const n = cellList.length;
  const cellParts = new Map(); // "x,y,z" -> [零件下标](一个格子可能被多个零件占用)
  track.parts.forEach((p, pi) => { if (allowed.has(p.category)) for (const c of p.cells) { const k = key(...c); (cellParts.get(k) ?? cellParts.set(k, []).get(k)).push(pi); } });
  // 坡道顶端:有多个高度层的非实心部件(斜坡)里最高那层的格子。只有从这里起跳才允许跨很远的缺口(设计好的大跳跃)。
  const rampTop = [];
  for (const p of track.parts) { if (solid.has(p.category) || !allowed.has(p.category)) continue; const ys = p.cells.map((c) => c[1]); const lo = Math.min(...ys), hi = Math.max(...ys); if (hi - lo < 1 || hi - lo > 2) continue; for (const c of p.cells) if (c[1] === hi) { const j = idxOf.get(key(...c)); if (j !== undefined) rampTop.push(j); } }
  const col = new Map(); // "x,z" -> [[y, idx]]
  cellList.forEach((c, i) => { const k = c[0] + ',' + c[2]; (col.get(k) ?? col.set(k, []).get(k)).push([c[1], i]); });
  const dist1 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

  function dijkstra(sources, jmp) {
    const d = new Float64Array(n).fill(Infinity); const heap = [];
    const push = (dd, i) => { heap.push([dd, i]); let j = heap.length - 1; while (j > 0) { const p = (j - 1) >> 1; if (heap[p][0] <= heap[j][0]) break; [heap[p], heap[j]] = [heap[j], heap[p]]; j = p; } };
    const pop = () => { const t = heap[0]; const l = heap.pop(); if (heap.length) { heap[0] = l; let j = 0; for (;;) { let m = j; const a = 2 * j + 1, b = a + 1; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === j) break; [heap[m], heap[j]] = [heap[j], heap[m]]; j = m; } } return t; };
    for (const i of sources) { d[i] = 0; push(0, i); }
    while (heap.length) {
      const [dd, i] = pop(); if (dd > d[i]) continue;
      const [x, y, z] = cellList[i];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
        const j = idxOf.get(key(x + dx, y + dy, z + dz)); if (j === undefined) continue;
        const nd = dd + SZ; if (nd < d[j]) { d[j] = nd; jmp[j] = -1; push(nd, j); }
      }
      for (let dx = -jumpMax; dx <= jumpMax; dx++) for (let dz = -jumpMax; dz <= jumpMax; dz++) {
        const h = Math.hypot(dx, dz); if (h <= 1.5 || h > jumpMax) continue;
        const ys = col.get((x + dx) + ',' + (z + dz)); if (!ys) continue;
        for (const [yy, j] of ys) { const rise = y - yy; /* 正向行驶是 j -> i:向上最多 jumpRise 层(凭水平间隙跳不上高台),向下最多 jumpUp 层 */ if (rise > jumpRise || -rise > jumpUp) continue; const nd = dd + h * SZ * jumpCost; if (nd < d[j]) { d[j] = nd; jmp[j] = -1; push(nd, j); } }
      }
      for (const j of rampTop) { // 坡道顶端起跳的长跳:落点 i 在 rampJumpMax 格内、向上最多 jumpRise 层
        const [jx, jy, jz] = cellList[j]; const h = Math.hypot(x - jx, z - jz); if (h <= jumpMax || h > rampJumpMax) continue;
        const rise = y - jy; if (rise > jumpRise || -rise > jumpUp) continue;
        const nd = dd + h * SZ * jumpCost; if (nd < d[j]) { d[j] = nd; jmp[j] = i; push(nd, j); } // jmp[j] = 长跳的落点
      }
    }
    return d;
  }

  // 有序锚点:起点 -> 检查点(按 cpOrder)-> 终点
  const sel = (pred) => track.parts.filter(pred);
  const startPart = sel((p) => p.startOrder != null)[0];
  // 检查点按 cpOrder 分组:一个检查点可以由并排的多个零件拼成(宽路),车穿过其中任何一个就算过。游戏状态里的 cp 是"已过的检查点个数",
  // 所以势场的目标也必须是"一组零件的并集",否则车过了半个检查点后,势场会让它去 20 m 外的另一半(summer3:进度钉死、规划停滞)。
  const cpMap = new Map(); for (const p of sel((q) => track.info[q.partId]?.detector?.type === 0 && q.cpOrder != null)) (cpMap.get(p.cpOrder) ?? cpMap.set(p.cpOrder, []).get(p.cpOrder)).push(p);
  const cps = [...cpMap.keys()].sort((a, b) => a - b).map((k) => cpMap.get(k));
  const fin = sel((p) => track.info[p.partId]?.detector?.type === 1);
  if (!startPart || !fin.length) throw new Error('赛道缺少起点或终点');
  const srcOf = (parts) => parts.flatMap((p) => p.cells.map((c) => idxOf.get(key(...c)))).filter((i) => i !== undefined);
  const targets = [...cps, fin];
  const jumps = targets.map(() => new Int32Array(n).fill(-1));
  const fields = targets.map((t, k) => dijkstra(srcOf(t), jumps[k]));
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
  if (strict) for (let k = 0; k < targets.length; k++) { const fromIdxs = k === 0 ? startIdxs : srcOf(targets[k - 1]); if (!fromIdxs.length || !fromIdxs.some((i) => Number.isFinite(fields[k][i]))) throw new Error(`第 ${k} 段不连通(屏蔽后)`); }

  // 空中走廊:每条被选中的长跳,沿"起跳格 -> 落点格"的连线(两侧各 2.5 格)登记 (值 = 落点值 + 到落点的剩余水平距离 x jumpCost x 格长, 最低高度)。
  // 飞行中的车高于下方地面,按普通方式会被映射到脚下平台的格子(那里的剩余距离很大),进度就会"起飞即下降";有了走廊,飞行过程中进度单调增加。
  const air = targets.map((_, k) => { const m = new Map(); for (const j of rampTop) { const i = jumps[k][j]; if (i < 0) continue; const [jx, jy, jz] = cellList[j], [ix, iy, iz] = cellList[i]; const hh = Math.hypot(ix - jx, iz - jz); if (hh < 1) continue;
      const ux = (ix - jx) / hh, uz = (iz - jz) / hh; const minY = Math.min(jy, iy) * SZ - 4;
      for (let t = 0; t <= hh; t += 0.25) { const px = jx + 0.5 + ux * t, pz = jz + 0.5 + uz * t; const val = fields[k][i] + (hh - t) * SZ * jumpCost;
        for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) { const cx = Math.floor(px) + a, cz = Math.floor(pz) + b; if (Math.hypot(cx + 0.5 - px, cz + 0.5 - pz) > 2.5) continue; const key2 = cx + ',' + cz; const old = m.get(key2); if (!old || val < old.v) m.set(key2, { v: val, minY }); } } }
    return m; });
  function locate(x, y, z) { // -> 最近格子下标 + 水平偏离
    const cx = Math.floor(x / SZ), cz = Math.floor(z / SZ), cy = y / SZ;
    for (const R of [1, 3, 8, 20]) {
      let best = -1, bs = Infinity, bd = 0, bv = 0;
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const ys = col.get((cx + dx) + ',' + (cz + dz)); if (!ys) continue;
        for (const [yy, i] of ys) {
          const hx = (cx + dx + 0.5) * SZ - x, hz = (cz + dz + 0.5) * SZ - z; const h = Math.hypot(hx, hz);
          const v = (yy + 0.5 - cy) * SZ; const vs = v > 0 ? v * 3 : -v * 1; // 车下方的格子更合理:在其上方的格子加重惩罚
          const s = h + vs; if (s < bs) { bs = s; best = i; bd = h; bv = v; }
        }
      }
      if (best >= 0) return { i: best, h: bd, v: bv };
    }
    return { i: -1, h: Infinity, v: 0 };
  }
  function query(x, z, y = null, cp = 0) {
    const k = Math.max(0, Math.min(targets.length - 1, cp | 0));
    const yy = y ?? track.start?.position?.y ?? 0;
    if (y != null) { const ak = air[k].get(Math.floor(x / SZ) + ',' + Math.floor(z / SZ)); if (ak && y > ak.minY) return { s: offset[k] + Math.max(0, Math.min(segLen[k], segLen[k] - ak.v)), d: 0, above: 0 }; }
    const { i, h, v } = locate(x, yy, z);
    if (i < 0) return { s: offset[k], d: 99, above: 0 };
    // 亚格插值:朝梯度(邻格中距离最小者)方向的投影修正
    const c = cellList[i]; const f = fields[k]; let g = null, gd = f[i];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) { const j = idxOf.get(key(c[0] + dx, c[1] + dy, c[2] + dz)); if (j !== undefined && f[j] < gd) { gd = f[j]; g = [dx, dz]; } }
    let corr = 0; if (g) corr = Math.max(-SZ / 2, Math.min(SZ / 2, ((x - (c[0] + 0.5) * SZ) * g[0] + (z - (c[2] + 0.5) * SZ) * g[1]))); // 沿 g 方向前进 corr 米 => 距离减少
    const dk = Math.max(0, f[i] - corr);
    const s = offset[k] + Math.max(0, Math.min(segLen[k], segLen[k] - dk));
    // above:车比它映射到的路面格子低多少(米)。从高架路面掉到地面后,最近的格子在头顶上方,above 很大 => 回不去了
    return { s, d: Math.max(0, h - SZ / 2), above: Math.max(0, v) };
  }
  /** 调试用:从 (x,y,z) 出发,按第 cp 段的距离场逐步走到目标,返回经过的格子(含跳跃边),用来看"势场认为的最短路线"长什么样 */
  const idxByAll = (cx, cy, cz) => { const out = []; for (let dx = -rampJumpMax; dx <= rampJumpMax; dx++) for (let dz = -rampJumpMax; dz <= rampJumpMax; dz++) { const ys = col.get((cx + dx) + ',' + (cz + dz)); if (ys) for (const [, j] of ys) out.push(j); } return out; };
  function route(x, y, z, cp) {
    const f = fields[cp]; let { i } = locate(x, y, z); const out = []; let guard = 0;
    while (i >= 0 && f[i] > 0 && guard++ < 4000) {
      const [cx, cy, cz] = cellList[i]; out.push([cx, cy, cz, +f[i].toFixed(0)]); let nb = -1, nd = f[i];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) { const j = idxOf.get(key(cx + dx, cy + dy, cz + dz)); if (j !== undefined && f[j] + SZ <= f[i] + 1e-6 && f[j] < nd) { nd = f[j]; nb = j; } }
      for (let dx = -jumpMax; dx <= jumpMax; dx++) for (let dz = -jumpMax; dz <= jumpMax; dz++) { const h = Math.hypot(dx, dz); if (h <= 1.5 || h > jumpMax) continue; const ys = col.get((cx + dx) + ',' + (cz + dz)); if (!ys) continue; for (const [yy, j] of ys) { const rise = yy - cy; if (rise > jumpRise || -rise > jumpUp) continue; if (f[j] + h * SZ * jumpCost <= f[i] + 1e-6 && f[j] < nd) { nd = f[j]; nb = j; } } }
      if (cellList[i] && !(nb >= 0)) { /* 没有普通边时试试从坡道顶端起跳的长跳(route 只在 i 是坡道顶端时走长跳) */ }
      if (rampTop.includes(i)) for (const jj of idxByAll(cx, cy, cz)) { const [lx, ly, lz] = cellList[jj]; const h = Math.hypot(lx - cx, lz - cz); if (h <= jumpMax || h > rampJumpMax) continue; const rise = ly - cy; if (rise > jumpRise || -rise > jumpUp) continue; if (f[jj] + h * SZ * jumpCost <= f[i] + 1e-6 && f[jj] < nd) { nd = f[jj]; nb = jj; } }
      if (nb < 0) break; i = nb;
    }
    return out;
  }
  const startY = track.start?.position?.y ?? 0;
  const minY = Math.min(...cellList.map((c) => c[1])) * SZ - 15;
  /** 一串格子(route 的返回值)涉及的零件下标(去重;起点 / 检查点 / 终点零件不算) */
  const partsOnRoute = (cells) => { const out = new Set(); for (const c of cells) for (const pi of cellParts.get(key(c[0], c[1], c[2])) ?? []) { const p = track.parts[pi]; if (track.info[p.partId]?.detector || p.startOrder != null) continue; out.add(pi); } return [...out]; };
  return { route, partsOnRoute, kind: 'field', length: total, segLen, offset, query, startY, minY, nCells: n, nLevels: targets.length, checkpoints: cps.length, waypoints: [] };
}
