// 任务 1 补充:游戏自带的 Verify(离线重放)路径吞吐,以及游戏自带的 TestDeterminism 自检。
// 回放 = "从第 0 帧起一直按住 W";目标帧数设为 100000,Worker 会同步模拟满 100000 帧(不会完成赛道,Verify 返回 false 属正常)。
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { launchGame } from './lib/pt_harness.mjs';
import { encodeRecording, eventsToToggles } from './lib/pt_codec.mjs';
const OUT = fileURLToPath(new URL('../logs/', import.meta.url));
const g = await launchGame({ mainVirtual: true });
const rec = encodeRecording(eventsToToggles([{ frame: 0, key: 'up', down: true }]));
const det = await g.testDeterminism();
console.log('游戏自带 testDeterminism():', det);
const rows = [];
for (const frames of [20000, 100000, 600000]) {
  const r = (await g.verify(rec, frames, 3));
  const fps = r.map((x) => Math.round(frames / (x.wallMs / 1000)));
  rows.push({ frames, runs: r, framesPerSec: fps });
  console.log(`Verify ${frames} 帧 x3: 耗时 ${r.map((x) => x.wallMs.toFixed(0) + 'ms').join(', ')} => ${fps.join(', ')} 帧/秒 (实时 1000 帧/秒, 即 ${(fps[0] / 1000).toFixed(0)}x)`);
}
fs.writeFileSync(OUT + 't1b_offline_throughput.json', JSON.stringify({ testDeterminism: det, rows }, null, 2));
await g.close();
