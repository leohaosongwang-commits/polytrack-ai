// 任务 3 补充:专门挖"重生(R 键)相关的不一致"。多种重生节奏 x 多个虚拟时钟配置:
//  比较 完成帧 / 逐帧轨迹哈希 / 回放路径一致 / Verify 严格性(±1 帧)。记录游戏实际写进回放的 reset 翻转帧。
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { runOne } from './lib/pt_runner.mjs';
import { RS1, RS2, RS3 } from './lib/fixtures.mjs';
const OUT = fileURLToPath(new URL('../logs/', import.meta.url));
const scripts = { RS1_连续点按: RS1, RS2_长按与改油门: RS2, RS3_整局重来后再重生: RS3 };
const cfgs = ['fast_step100', 'frame_by_frame', 'odd_step_7_3', 'render_60hz'];
const out = {}; let ok = true;
for (const [name, script] of Object.entries(scripts)) {
  out[name] = [];
  for (const cfgName of cfgs) {
    const r = await runOne({ script, cfgName, endFrame: 40000 });
    const { recording, rows, ...rest } = r; out[name].push(rest);
    console.log(`${name} [${cfgName}] 完成帧=${r.finishFrames} 哈希=${r.trajectoryHash} 局数=${r.runs} 记录到的reset翻转帧=${JSON.stringify(r.recordedToggles.reset)} 游戏看到的重生上升沿=${JSON.stringify(r.resetFrames)} 回放路径一致=${r.replayPathMatch?.equal}${r.replayPathMatch?.firstDiff ? ' 首个差异=' + JSON.stringify(r.replayPathMatch.firstDiff) : ''} Verify=${r.verifyAtFinish} ±1=${JSON.stringify(r.verifyNeighbors)}`);
  }
  const keys = new Set(out[name].map((r) => `${r.finishFrames}|${r.trajectoryHash}`));
  const good = keys.size === 1 && out[name].every((r) => r.replayPathMatch?.equal && r.verifyAtFinish === true);
  ok &&= good; console.log('=> 判定', name, good ? '✔ 全部一致' : '✘ 存在不一致', 'distinct=' + keys.size);
}
fs.writeFileSync(OUT + 't3b_respawn.json', JSON.stringify(out, null, 2));
process.exit(ok ? 0 : 1);
