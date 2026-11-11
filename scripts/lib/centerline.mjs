// 由 trackInfo()(游戏自己的解析器给出的部件表)粗略重建赛道中线,仅用于生成"参考跑法"的测试夹具。
// 注意:这不是阶段 1 的优化器,只是一个够用的路径点生成器。
const SIZE = 5; // 游戏的 partSize:世界坐标 = 格子坐标 x 5
const ROAD_CATS = new Set([0, 1, 2, 3]); // Special / Road / RoadTurns / RoadWide

export function buildCenterline(track) {
  const cells = new Map(); // "x,y,z" -> [x,y,z]
  let startPart = null; const finishCells = []; const cps = [];
  for (const p of track.parts) {
    if (!ROAD_CATS.has(p.category)) continue;
    for (const c of p.cells) cells.set(c.join(','), c);
    if (p.startOrder != null) startPart = p;
    if (track.info[p.partId]?.detector?.type === 1) for (const c of p.cells) finishCells.push(c);
    if (p.cpOrder != null) cps.push({ order: p.cpOrder, part: p });
  }
  if (!startPart || finishCells.length === 0) throw new Error('no start/finish found');
  // 从终点做 BFS(4 邻接,允许相差 1 层高度)
  const dist = new Map(); const q = [];
  for (const c of finishCells) { dist.set(c.join(','), 0); q.push(c); }
  for (let h = 0; h < q.length; h++) {
    const [x, y, z] = q[h]; const d = dist.get([x, y, z].join(','));
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
      const k = [x + dx, y + dy, z + dz].join(',');
      if (cells.has(k) && !dist.has(k)) { dist.set(k, d + 1); q.push(cells.get(k)); }
    }
  }
  const startCell = [startPart.x, startPart.y, startPart.z];
  const D = dist.get(startCell.join(','));
  if (D === undefined) throw new Error('start not connected to finish');
  const waypoints = [];
  for (let k = D; k >= 0; k--) {
    const wave = [...dist].filter(([, v]) => v === k).map(([key]) => cells.get(key));
    if (!wave.length) continue;
    const cx = wave.reduce((a, c) => a + c[0], 0) / wave.length, cy = wave.reduce((a, c) => a + c[1], 0) / wave.length, cz = wave.reduce((a, c) => a + c[2], 0) / wave.length;
    waypoints.push({ x: cx * SIZE, y: cy * SIZE, z: cz * SIZE, k });
  }
  const cpWorld = cps.sort((a, b) => a.order - b.order).map((c) => ({ order: c.order, x: c.part.x * SIZE, y: c.part.y * SIZE, z: c.part.z * SIZE }));
  return { waypoints, cpWorld, start: track.start, distStartToFinishCells: D };
}
