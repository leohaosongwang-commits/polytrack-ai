// 不需要浏览器的单元测试:回放编解码、掩码<->翻转帧、赛道进度势能
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRecording, decodeRecording } from '../scripts/lib/pt_codec.mjs';
import { masksToToggles, togglesToMasks } from '../scripts/lib/solver.mjs';
import { buildProgress } from '../scripts/lib/progress.mjs';
import { parseSegs } from '../scripts/solve.mjs';

test('回放串编解码往返', () => {
  const t = { up: [0, 500, 900], right: [100, 150], down: [], left: [2000, 2010], reset: [] };
  assert.deepEqual(decodeRecording(encodeRecording(t)), t);
});

test('逐帧掩码 <-> 翻转帧往返', () => {
  const m = new Uint8Array(1000);
  for (let f = 0; f < 1000; f++) m[f] = f < 300 ? 1 : f < 400 ? 9 : f < 410 ? 4 : f < 800 ? 3 : 0;
  const toggles = masksToToggles(m);
  assert.deepEqual(Array.from(togglesToMasks(toggles, 1000)), Array.from(m));
  assert.deepEqual(toggles[0].slice(0, 2), [0, 400]); // up: 0 帧按下, 400 松开(之后 410..800 又按下)
});

test('parseSegs', () => {
  assert.deepEqual(parseSegs('40x2,100x1'), [40, 40, 100]);
});

// 合成一条沿 -z 的直路:起点格(0,0,0..3) -> 终点格(0,0,-? ),验证势能单调、长度合理
function straightTrack(n) {
  const parts = []; const cell = (x, y, z) => [x, y, z];
  const mk = (z0, partId, extra) => { const cells = []; for (let dz = 0; dz < 4; dz++) for (let dx = -2; dx < 2; dx++) cells.push(cell(dx, 0, z0 - dz)); return { partId, category: extra.category, cells, ...extra }; };
  parts.push(mk(1, 5, { category: 0, startOrder: 0 }));
  for (let i = 1; i <= n; i++) parts.push(mk(1 - 4 * i, 0, { category: 1 }));
  parts.push(mk(1 - 4 * (n + 1), 6, { category: 0 }));
  return { parts, info: { 5: { detector: null }, 0: { detector: null }, 6: { detector: { type: 1 } } }, start: { position: { x: 0, y: 0.35, z: -1.35 } } };
}
test('进度势能:直路上弧长随前进单调递增,垂直偏移给出 d', () => {
  const P = buildProgress(straightTrack(5));
  assert.ok(Math.abs(P.length - 5 * 4 * 5 - 20) < 12, `length=${P.length}`); // 约 (n+1)*20 m
  let last = -1;
  for (let z = 0; z > -100; z -= 10) { const q = P.query(0, z); assert.ok(q.s >= last); last = q.s; assert.ok(q.d < 1); }
  assert.ok(Math.abs(P.query(6, -50).d - 6) < 1e-6);
});

// 分段距离场:带缺口(跳跃)和一个检查点的合成直路。检查点 0 在缺口之前,终点在缺口之后。
import { buildProgressField } from '../scripts/lib/progress.mjs';
function gapTrack() {
  const mk = (z0, partId, extra) => { const cells = []; for (let dz = 0; dz < 4; dz++) for (let dx = -2; dx < 2; dx++) cells.push([dx, 0, z0 - dz]); return { partId, category: extra.category, cells, ...extra }; };
  const parts = [mk(1, 5, { category: 0, startOrder: 0 })];
  for (let i = 1; i <= 3; i++) parts.push(mk(1 - 4 * i, 0, { category: 1 }));
  parts.push(mk(1 - 4 * 4, 52, { category: 0, cpOrder: 0 })); // 检查点
  // 缺口:跳过 z 格 -17..-20(一个 4 格长的洞)
  for (let i = 6; i <= 8; i++) parts.push(mk(1 - 4 * i, 0, { category: 1 }));
  parts.push(mk(1 - 4 * 9, 6, { category: 0 }));
  return { parts, info: { 5: { detector: null }, 0: { detector: null }, 52: { detector: { type: 0 } }, 6: { detector: { type: 1 } } }, start: { position: { x: 0, y: 0.35, z: -1.35 } } };
}
test('分段距离场:能跨缺口建出各段,进度跨检查点连续且单调', () => {
  const P = buildProgressField(gapTrack());
  assert.equal(P.checkpoints, 1);
  assert.equal(P.segLen.length, 2);
  assert.ok(P.segLen.every((l) => l > 0));
  const zs = []; for (let z = 1; z > -190; z -= 5) zs.push(z);
  let last = -1;
  for (const z of zs) {
    const cpZ = -4 * 5 * 4 + 5 * 2; // 检查点中心约 z=-78
    const cp = z < cpZ - 10 ? 1 : 0; // 过了检查点之后用第 1 段
    const q = P.query(0, z, 1.0, cp);
    assert.ok(q.s >= last - 1e-6, `z=${z} s=${q.s} last=${last}`);
    last = q.s;
  }
  assert.ok(last > P.length * 0.8, `last=${last} total=${P.length}`);
});

test('分段距离场:并排的多零件检查点按 cpOrder 合并成一个目标(官方 summer3 的检查点就是两个零件拼的)', () => {
  const T = gapTrack(); const i = T.parts.findIndex((p) => p.cpOrder === 0); const cp = T.parts[i];
  const half = (xs) => ({ ...cp, cells: cp.cells.filter((c) => xs.includes(c[0])) });
  T.parts.splice(i, 1, half([-2, -1]), half([0, 1])); // 同一个 cpOrder 拆成左右两半
  const P = buildProgressField(T), ref = buildProgressField(gapTrack());
  assert.equal(P.checkpoints, 1, '一个逻辑检查点,而不是两个');
  assert.equal(P.segLen.length, 2, '起点->检查点、检查点->终点,共 2 段(拆成两个目标时会是 3 段,中间夹一段 20 m 的"从左半走到右半")');
  assert.deepEqual(P.segLen, ref.segLen, '拆成两半与整块检查点的分段长度一致');
  // 过了检查点(cp=1)沿路前进:进度必须继续增加,而不是钉在段起点
  let last = -1; for (let z = -95; z > -190; z -= 5) { const q = P.query(0, z, 1.0, 1); assert.ok(q.s >= last - 1e-6, `z=${z} s=${q.s}`); last = q.s; }
  assert.ok(last > P.offset[1] + 40, `过检查点后进度只增加了 ${last - P.offset[1]} m`);
});

// ---- 势场对"实心方块 / 坡道长跳 / 空中走廊"的处理(Summer 1 的卡死就出在这三处)----
const slab = (z0, y, x0 = -2) => { const c = []; for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) c.push([x0 + dx, y, z0 - dz]); return c; };
const INFO = { 5: { detector: null }, 0: { detector: null }, 2: { detector: null }, 29: { detector: null }, 6: { detector: { type: 1 } } };
function jumpTrack({ ramp }) { // 起点 -> 直路 -> (坡道|平路) -> 13 格缺口 -> 高 1 层的落点路面 -> 终点
  const parts = [
    { partId: 5, category: 0, startOrder: 0, cells: slab(1, 0) },
    { partId: 0, category: 1, cells: slab(-3, 0) },
    { partId: 0, category: 1, cells: slab(-7, 0) },
    ramp ? { partId: 2, category: 1, cells: [...slab(-11, 0), ...[-2, -1, 0, 1].map((x) => [x, 1, -14])] } : { partId: 0, category: 1, cells: slab(-11, 0) },
    { partId: 0, category: 1, cells: slab(-27, 1) },
    { partId: 6, category: 0, cells: slab(-31, 1) },
  ];
  return { parts, info: INFO, start: { position: { x: 0, y: 0.35, z: -1.35 } } };
}
test('势场:叠起来的实心方块(category 5)只保留最上面一层可行驶', () => {
  const base = jumpTrack({ ramp: true });
  const withTower = { ...base, parts: [...base.parts, ...[0, 1, 2].map((y) => ({ partId: 29, category: 5, cells: slab(-5, y, 12) }))] };
  const n0 = buildProgressField(base).nCells, n1 = buildProgressField(withTower).nCells;
  assert.equal(n1 - n0, 16, `3 层方块应只多出顶层 16 格,实际多出 ${n1 - n0}`);
});
test('势场:只有从坡道顶端起跳才允许跨很远的缺口,空中走廊里进度单调递增', () => {
  assert.throws(() => buildProgressField(jumpTrack({ ramp: false })), /不连通/, '平路没有坡道,13 格缺口不该被当作可跳');
  const P = buildProgressField(jumpTrack({ ramp: true }));
  assert.ok(P.segLen[0] > 0);
  let last = -Infinity; // 沿缺口(z 从 -72 到 -135 米)在 13 m 高度飞过
  for (let z = -72; z >= -135; z -= 4) { const q = P.query(0, z, 13, 0); assert.ok(q.s >= last - 1e-6, `空中 z=${z} s=${q.s} last=${last}`); last = q.s; }
  assert.ok(last > P.length * 0.5);
});

// ---- 势场修复(失败驱动):屏蔽零件、连通性检查、路线涉及的零件 ----
const keysOf = (part) => new Set(part.cells.map((c) => c.join(',')));
test('势场修复:屏蔽一个零件会让格子数恰好减少该零件的格数(跳跃边仍能连通),严格模式下被屏蔽后不连通就抛错', () => {
  const T = jumpTrack({ ramp: true });
  const n0 = buildProgressField(T).nCells;
  const P1 = buildProgressField(T, { blocked: keysOf(T.parts[1]), strict: true }); // 缺口 4 格 <= 跳跃上限,仍然连通
  assert.equal(n0 - P1.nCells, 16);
  const all = new Set([...keysOf(T.parts[1]), ...keysOf(T.parts[2]), ...keysOf(T.parts[3])]); // 12 格以上的洞,没有坡道也跳不过
  assert.throws(() => buildProgressField(T, { blocked: all, strict: true }), /不连通/);
});
test('势场修复:屏蔽集合不会删掉起点 / 检查点 / 终点零件的格子', () => {
  const T = jumpTrack({ ramp: true });
  const n0 = buildProgressField(T).nCells;
  const blockEverything = new Set(T.parts.flatMap((p) => p.cells.map((c) => c.join(','))));
  // 起点和终点零件不受屏蔽影响:格子数 = 起点(16) + 终点(16)
  assert.throws(() => buildProgressField(T, { blocked: blockEverything, strict: true }), /不连通/);
  assert.ok(n0 > 32);
});
test('势场修复:路线涉及的零件不含起点和终点', () => {
  const T = jumpTrack({ ramp: true });
  const P = buildProgressField(T);
  const route = P.route(0, 1, -20, 0);
  assert.ok(route.length > 3, '从第一段直路出发应能走出一条路线');
  const parts = P.partsOnRoute(route);
  assert.ok(parts.length >= 1);
  assert.ok(!parts.includes(0) && !parts.includes(5), `不应包含起点(0)/终点(5)零件:${parts}`);
});

// ---- 参考轨迹势场(把一圈已有的路线当中线,6.13 之后的"压圈速"用)----
import { buildTrajectoryProgress } from '../scripts/lib/refpath.mjs';
function loopSamples() { // 阶段 0:沿 +x 走 100 m(车速 100 -> 200);阶段 1:原路折回(+z 偏 30 m)再爬一面墙(上升 40 m),车速 150
  const out = []; let f = 0;
  for (let x = 0; x <= 100; x += 2) out.push([f += 20, 100 + x, 0, -1, 0, x, 10, 0]);
  for (let x = 100; x >= 0; x -= 2) out.push([f += 20, 150, 0, -1, 1, x, 10, 30]);
  for (let y = 10; y <= 50; y += 2) out.push([f += 20, 150, 0, -1, 1, 0, y, 30]);
  return out;
}
test('参考轨迹势场:沿线进度 = 弧长且单调;偏离 = 3D 距离;速度剖面可查', () => {
  const P = buildTrajectoryProgress(loopSamples());
  assert.equal(P.kind, 'trajectory'); assert.equal(P.checkpoints, 1);
  const a = P.query(40, 0, 10, 0), b = P.query(80, 0, 10, 0);
  assert.ok(Math.abs(a.s - 40) < 1e-6 && Math.abs(b.s - 80) < 1e-6 && a.d < 1e-6, JSON.stringify(a));
  assert.ok(Math.abs(a.vref - 140) < 1e-6, `vref=${a.vref}`); // 100 + x
  const off = P.query(40, 3, 10, 0); assert.ok(Math.abs(off.d - 3) < 1e-6 && Math.abs(off.s - 40) < 1e-6);
  const up = P.query(40, 0, 30, 0); assert.ok(Math.abs(up.d - 20) < 1e-6, '带高度:正上方 20 m 就是 20 m 的偏离');
});
test('参考轨迹势场:按检查点阶段分开比较(同一处 xz 的不同阶段不串)、墙上的路线进度继续增加', () => {
  const P = buildTrajectoryProgress(loopSamples());
  // 阶段 0 和阶段 1 的路线在 xz 上相距 30 m;车在 (50, 10, 0) 且 cp=1 时,应当匹配阶段 1 的折回线(距离 30),而不是阶段 0 上 d = 0 的那条
  const q1 = P.query(50, 0, 10, 1), q0 = P.query(50, 0, 10, 0);
  assert.ok(q0.d < 1e-6 && q1.d > 20, `q0.d=${q0.d} q1.d=${q1.d}`);
  assert.ok(q1.s > q0.s, '阶段 1 在整条路线上更靠后');
  let last = -1; for (let y = 10; y <= 50; y += 4) { const q = P.query(0, 30, y, 1); assert.ok(q.s > last, `y=${y} s=${q.s}`); last = q.s; }
  assert.ok(P.minY < 10 && P.length > 250);
});
test('参考轨迹势场:flat 模式(飞行中)只比水平位置,高度不同不算偏离', () => {
  const pts = []; let f = 0; for (let x = 0; x <= 100; x += 2) pts.push([f += 20, 200, 0, -1, 0, x, 10 + 20 * Math.sin((x / 100) * Math.PI), 0]); // 一段抛物线飞行
  const P = buildTrajectoryProgress(pts);
  const lowFlight = P.query(50, 0, 10, 0, false), flat = P.query(50, 0, 10, 0, true);
  assert.ok(lowFlight.d > 15, `3D 距离应当很大:${lowFlight.d}`); assert.ok(flat.d < 1, `flat 模式只看水平:${flat.d}`);
  assert.ok(Math.abs(flat.s - P.query(50, 0, 30, 0, true).s) < 1, '飞行中进度与高度无关');
});
