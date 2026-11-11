// 任务 4:精确到帧的按键注入。
// 检查:(1) 游戏实际记录到的按键翻转帧 == 我们下发的帧(逐帧完全一致);(2) 不同虚拟时钟步长下结果一致、可复现;
//       (3) 压力脚本:1 帧点按、连续两帧换键、同一帧多键、~200 次随机翻转;(4) 游戏非实时回放路径与实时路径逐帧一致。
import fs from 'node:fs';
import { runOne, expectedTogglesGame } from './lib/pt_runner.mjs';
import { S1, S2, E1, randomScript } from './lib/fixtures.mjs';
const OUT = new URL('../logs/', import.meta.url).pathname;
const scripts = { S1: [S1, 30000], S2: [S2, 30000], E1_edge: [E1, 6000], R1: [randomScript(1), 6000], R2: [randomScript(2), 6000], R3: [randomScript(3), 6000] };
const cfgs = process.env.QUICK === '1' ? ['fast_step100', 'frame_by_frame'] : ['fast_step100', 'frame_by_frame', 'render_60hz', 'odd_step_7_3'];
const all = {}; let okAll = true;
for (const [name, [script, endFrame]] of Object.entries(scripts)) {
  all[name] = { nEvents: script.length, runs: [] };
  const want = expectedTogglesGame(script);
  for (const cfgName of cfgs) {
    const r = await runOne({ script, cfgName, endFrame });
    const togglesExact = JSON.stringify(r.recordedToggles) === JSON.stringify(want);
    all[name].runs.push({ cfg: cfgName, finishFrames: r.finishFrames, hash: r.trajectoryHash, togglesExact, replayPathMatch: r.replayPathMatch?.equal, verify: r.verifyAtFinish ?? null, multiplier: r.multiplier });
    if (!togglesExact) all[name].firstMismatch = { cfg: cfgName, got: r.recordedToggles, want };
    console.log(`${name} [${cfgName}] 事件=${script.length} 记录翻转帧==下发帧:${togglesExact} 完成帧=${r.finishFrames} 哈希=${r.trajectoryHash} 回放路径一致=${r.replayPathMatch?.equal} Verify=${r.verifyAtFinish ?? '-'}`);
  }
  const hs = new Set(all[name].runs.map((r) => r.hash + '|' + r.finishFrames));
  all[name].identicalAcrossConfigs = hs.size === 1;
  all[name].ok = all[name].identicalAcrossConfigs && all[name].runs.every((r) => r.togglesExact && r.replayPathMatch && (r.verify === null || r.verify === true));
  okAll &&= all[name].ok;
  console.log('=> 判定', name, all[name].ok ? '✔' : '✘');
}
fs.writeFileSync(OUT + 't4_injection.json', JSON.stringify({ cfgs, all }, null, 2));
console.log(okAll ? '任务 4:帧精确且可复现 ✔' : '任务 4:存在问题 ✘');
process.exit(okAll ? 0 : 1);
