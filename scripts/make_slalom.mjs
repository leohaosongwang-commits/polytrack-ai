// 生成"蛇形"测试赛道:起点 -> 直路 -> 交替的 S 弯(横向各偏移 4 格 = 20 m)-> 直路 -> 检查点 -> ... -> 终点。
// 全程朝 -z 方向,部件几何取自对部件目录(类别 2 的 41/42:占格 12 长 x 4 宽,横向偏移 ±4 格)的观察。
// 赛道由游戏自己的序列化器生成;输出的是我们自己设计的数据。
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { launchGame } from './lib/pt_harness.mjs';

export function slalomParts({ bends = 6, lead = 8, gap = 3, tailN = 6, cpAfterBend = 3, y = 11 } = {}) {
  const parts = []; let x = 0, z = 0;
  const put = (partId, rotation, extra = {}) => parts.push({ partId, x, y, z, rotation, ...extra });
  put(5, 0, { startOrder: 0 }); z -= 4;
  for (let i = 0; i < lead; i++, z -= 4) put(0, 0);
  for (let b = 0; b < bends; b++) {
    const right = b % 2 === 0; // 42: 向 +x 偏移; 41: 向 -x 偏移
    put(right ? 42 : 41, 0); z -= 12; x += right ? 4 : -4;
    for (let i = 0; i < gap; i++, z -= 4) put(0, 0);
    if (b + 1 === cpAfterBend) { put(52, 0, { cpOrder: 0 }); z -= 4; }
  }
  for (let i = 0; i < tailN; i++, z -= 4) put(0, 0);
  put(6, 0);
  return parts;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2] ?? 'slalom';
  const bends = Number(process.env.BENDS ?? 6);
  const parts = slalomParts({ bends, lead: Number(process.env.LEAD ?? 8), tailN: Number(process.env.TAIL ?? 6), cpAfterBend: Number(process.env.CP ?? 3) });
  const g = await launchGame({ exposeTrack: true, mainVirtual: true });
  const t = await g.trackInfo();
  const colorOf = (id) => t.parts.find((p) => p.partId === id)?.color ?? t.parts.find((p) => p.partId === 0)?.color ?? 0;
  for (const p of parts) p.color = colorOf(p.partId);
  const r = await g.buildTrack(parts, name);
  await g.close();
  if (r.error) throw new Error(r.error);
  const out = fileURLToPath(new URL(`./data/${name}.txt`, import.meta.url));
  fs.writeFileSync(out, r.exportString + '\n');
  console.log(name, 'parts', parts.length, 'start', JSON.stringify(r.start), 'len', r.exportString.length, '->', out);
}
