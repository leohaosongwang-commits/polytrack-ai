// 端到端:在小蛇形赛道上跑规划 + 少量打磨,检查"能冲线 / 游戏 Verify 通过 / 优于基线 / 同种子可复现"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { solveTrack, parseSegs } from '../scripts/solve.mjs';
import { trackPath } from './helpers.mjs';

const cfg = { trackFile: trackPath('slalom_mini'), seconds: 600, workers: 3, seed: 7, segs: parseSegs('40x4,100x4,240x2'), pop: 48, iters: 2, commit: 4, polishIters: 12, log: () => {} };

test('小蛇形赛道:冲线 + Verify 通过 + 基线(一直按 W)不能冲线或更慢', { timeout: 600000 }, async () => {
  const r = await solveTrack(cfg);
  assert.ok(r.finishFrames > 0 && r.finishFrames < 30000);
  assert.equal(r.verifyOk, true);
  const base = r.baseline.holdW.finishFrames;
  assert.ok(base === null || r.finishFrames < base, `baseline=${base} solver=${r.finishFrames}`);
  assert.ok(r.phaseB.finishFrames <= r.phaseA.finishFrames); // 打磨不会变差
});

test('同种子同参数可复现:两次运行得到逐字节相同的回放串', { timeout: 900000 }, async () => {
  const a = await solveTrack(cfg); const b = await solveTrack(cfg);
  assert.equal(a.recording, b.recording);
  assert.equal(a.finishFrames, b.finishFrames);
});

// Go-Explore 式探索(不依赖势场当"可行"信号):小蛇形赛道上找到一条冲线路线,打磨后游戏 Verify 通过。约 2~4 分钟。
test('探索模式:小蛇形赛道找到冲线路线 + Verify 通过', { timeout: 900000 }, async () => {
  const r = await solveTrack({ ...cfg, workers: 4, seed: 1, polishIters: 6, explore: { seconds: 500, pop: 96, H: 24, seg: 60 } });
  assert.ok(r.finishFrames > 0 && r.finishFrames < 30000, `finish=${r.finishFrames}`);
  assert.equal(r.verifyOk, true);
});
