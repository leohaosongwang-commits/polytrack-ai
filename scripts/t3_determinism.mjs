// 任务 3:确定性测试。同一串输入,多次运行 + 不同"加速档位"(虚拟时钟步长/是否渲染/是否限速到 1x),比较完成时间和逐帧轨迹哈希。
// 另外:(a) 每次运行都用"游戏自己的非实时回放路径"重放并逐帧比对;(b) 用游戏自带 Verify 验证完成帧(含 +-1 帧负对照);
//       (c) 对照组:不打补丁的真实时间运行 + 墙钟时间注入按键,展示为什么必须接管时钟。
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { runOne, runRealtimeContrast, CONFIGS } from './lib/pt_runner.mjs';
import { S1, S2, S3 } from './lib/fixtures.mjs';
const OUT = fileURLToPath(new URL('../logs/', import.meta.url));
const plan = (process.env.QUICK === '1')
  ? ['fast_step100', 'frame_by_frame']
  : ['fast_step100', 'fast_step100', 'fast_step100', 'render_60hz', 'frame_by_frame', 'odd_step_7_3', 'realtime_1x'];
const scripts = { S1, S2, S3 };
const results = {}; const verdict = {};
for (const [name, script] of Object.entries(scripts)) {
  results[name] = [];
  for (const [i, cfgName] of plan.entries()) {
    const r = await runOne({ script, cfgName, verifyRepeat: i === 0 ? 5 : 1 });
    results[name].push(r);
    console.log(`${name} [${cfgName}] 完成帧=${r.finishFrames} 哈希=${r.trajectoryHash} 检查点=${JSON.stringify(r.cpEvents)} 重生=${JSON.stringify(r.resetFrames)} 倍速≈${r.multiplier}x 回放路径一致=${r.replayPathMatch?.equal} Verify=${r.verifyAtFinish} (±1: ${JSON.stringify(r.verifyNeighbors)})${r.verifyRepeat ? ' 5次新Worker Verify=' + JSON.stringify(r.verifyRepeat) : ''}`);
  }
  const keys = new Set(results[name].map((r) => `${r.finishFrames}|${r.trajectoryHash}|${JSON.stringify(r.cpEvents)}|${JSON.stringify(r.resetFrames)}`));
  verdict[name] = { runs: results[name].length, distinctOutcomes: keys.size, identical: keys.size === 1, finishFrames: results[name][0].finishFrames,
    allReplayPathMatch: results[name].every((r) => r.replayPathMatch?.equal), allVerifyTrue: results[name].every((r) => r.verifyAtFinish === true && r.verifyNeighbors?.minus1 === false && r.verifyNeighbors?.plus1 === false) };
  console.log('=> 判定', name, JSON.stringify(verdict[name]));
}
// 对照组:真实时间 + 墙钟注入(S1)
const contrast = [];
if (process.env.QUICK !== '1') {
  for (let i = 0; i < 3; i++) { const r = await runRealtimeContrast(S1); contrast.push(r); console.log(`对照(不打补丁, 真实时间, 墙钟注入) #${i + 1}: 完成帧=${r.finishFrames} 哈希=${r.trajectoryHash} 记录到的转向翻转帧 left=${JSON.stringify(r.recordedToggles.left)} right=${JSON.stringify(r.recordedToggles.right)}`); }
}
const slim = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.map(({ recording, ...rest }) => rest)]));
fs.writeFileSync(OUT + 't3_determinism.json', JSON.stringify({ configs: CONFIGS, plan, verdict, results: slim, realtimeContrast: contrast }, null, 2));
const ok = Object.values(verdict).every((v) => v.identical && v.allReplayPathMatch && v.allVerifyTrue);
console.log(ok ? '任务 3:全部一致 ✔' : '任务 3:存在不一致 ✘');
process.exit(ok ? 0 : 1);
