// 生成阶段 0 用的直线测试赛道:Start -> 直路 -> Checkpoint -> 直路 -> Finish(车沿 -x 方向行驶)。
// 部件摆放约定取自对官方 Summer 1 部件表的观察:partSize=5,直路/检查点占 4x4 格,所以每块沿行驶方向间隔 4 格。
// 赛道由游戏自己的赛道类序列化(内存中),输出的是我们自己设计的数据,可以放进项目目录。
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { launchGame } from './lib/pt_harness.mjs';
const OUT = fileURLToPath(new URL('./data/mini_track.txt', import.meta.url));
const START_X = 64, Y = 11;
const N1 = Number(process.env.N1 ?? 12), N2 = Number(process.env.N2 ?? 12); // 检查点前后的直路块数
const parts = [];
let x = START_X;
parts.push({ partId: 5, x, y: Y, z: 0, rotation: 1, startOrder: 0 }); x -= 4;
for (let i = 0; i < N1; i++, x -= 4) parts.push({ partId: 0, x, y: Y, z: 0, rotation: 3 });
parts.push({ partId: 52, x, y: Y, z: 0, rotation: 3, cpOrder: 0 }); x -= 4;
for (let i = 0; i < N2; i++, x -= 4) parts.push({ partId: 0, x, y: Y, z: 0, rotation: 3 });
parts.push({ partId: 6, x, y: Y, z: 0, rotation: 1 });
const g = await launchGame({ exposeTrack: true, mainVirtual: true });
const t = await g.trackInfo();
// 沿用官方赛道里同类部件的颜色值
const colorOf = (id) => t.parts.find((p) => p.partId === id)?.color ?? 0;
for (const p of parts) p.color = colorOf(p.partId);
const r = await g.buildTrack(parts, 'Phase0 straight test');
await g.close();
if (r.error) throw new Error(r.error);
fs.writeFileSync(OUT, r.exportString + '\n');
console.log('parts', parts.length, 'start', JSON.stringify(r.start), 'export string length', r.exportString.length);
console.log('road length (m) ≈', (parts.length - 1) * 20, ' finish x(world) =', x * 5);
