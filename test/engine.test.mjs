// 需要浏览器 + 能访问游戏静态资源主机。验证批量评估引擎本身是否可信。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openGame } from './helpers.mjs';
import { masksToToggles } from '../scripts/lib/solver.mjs';
import { encodeRecording } from '../scripts/lib/pt_codec.mjs';

let g;
before(async () => { g = await openGame('mini_track'); await g.makePool(3); });
after(async () => { await g?.close(); });

// S1 风格的直路脚本:W 常按,左点按 2000-2150,右点按 2400-2550
const masks = (n) => Uint8Array.from({ length: n }, (_, f) => 1 | (f >= 2000 && f < 2150 ? 8 : 0) | (f >= 2400 && f < 2550 ? 2 : 0));
const rec = (m) => { const t = masksToToggles(m); return encodeRecording({ up: t[0], right: t[1], down: t[2], left: t[3], reset: t[4] }); };

test('Eval 的完成帧与阶段 0 的参考值一致(S1 = 8250),且与游戏 Verify 一致', async () => {
  const m = masks(9000);
  const [r] = await g.evalBatch([Array.from(m)], { seg: 1, tail: 1, maxFrames: 20000 });
  assert.equal(r.fin, 8250);
  const v = await g.verify(rec(m.slice(0, r.fin)), r.fin, 1);
  assert.equal(v[0].result, true);
  assert.equal((await g.verify(rec(m), r.fin - 1, 1))[0].result, false);
  assert.equal((await g.verify(rec(m), r.fin + 1, 1))[0].result, false);
});

test('批量结果与分到几个 Worker 无关,顺序与输入一致', async () => {
  const plans = Array.from({ length: 7 }, (_, i) => Array.from(masks(9000)).map((v, f) => (f > 3000 && f < 3000 + i * 30 ? 9 : v)));
  const a = await g.evalBatch(plans, { seg: 1, tail: 1, maxFrames: 20000 });
  await g.makePool(1);
  const b = await g.evalBatch(plans, { seg: 1, tail: 1, maxFrames: 20000 });
  await g.makePool(3);
  assert.deepEqual(a.map((r) => [r.fin, r.last[5], r.last[7]]), b.map((r) => [r.fin, r.last[5], r.last[7]]));
});

test('WASM 快照:整段模拟 == 前半段提交 + 后半段从快照出发(逐比特)', async () => {
  const rnd = (() => { let s = 7; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; })();
  const plan = Array.from({ length: 60 }, () => [1, 9, 3, 4][(rnd() * 4) | 0]);
  const full = (await g.evalBatch([plan], { seg: 50, maxFrames: 3000 }))[0];
  await g.commit(plan.slice(0, 30), 50, null, true);
  const half = await g.evalBatch([plan.slice(30), plan.slice(30)], { seg: 50, maxFrames: 1500, fromCommit: true });
  assert.deepEqual(half[0].last, full.last);
  assert.deepEqual(half[1].last, full.last);
});

test('可变时长动作(segs)与等价的逐帧展开结果相同', async () => {
  const segs = [30, 70, 120, 200]; const plan = [1, 9, 3, 1];
  const perFrame = []; segs.forEach((d, i) => { for (let j = 0; j < d; j++) perFrame.push(plan[i]); });
  const a = (await g.evalBatch([plan], { segs, maxFrames: 420 }))[0];
  const b = (await g.evalBatch([perFrame], { seg: 1, maxFrames: 420 }))[0];
  assert.deepEqual(a.last, b.last);
});

test('commit(reset=true) 回到起点重算:同一序列、中间被别的提交打断后,状态逐比特相同', async () => {
  const a = [1, 9, 3, 1, 4, 1];
  const r1 = await g.commit(a, 60, null, true);
  await g.commit([1, 1, 3, 3], 60, null, false); // 在快照上继续前进,把状态弄乱
  const r2 = await g.commit(a, 60, null, true);
  assert.deepEqual(r1.last, r2.last);
  assert.equal(r1.frames, 360);
});
