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
