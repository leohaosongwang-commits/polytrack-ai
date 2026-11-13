// 把一份"已通过游戏 Verify 的求解结果"收进扩展的内置方案表 extension/plans/bundled.json(再运行 node scripts/build_extension.mjs 重建)。
// 内置的只是按键翻转帧 / 回放串(我们自己的输出),不含任何游戏文件;赛道用"赛道数据指纹"索引,扩展里 curTrackId() 用同一个算法。
// 用法:node scripts/bundle_plan.mjs --result out/xxx.json --name "Summer 1" [--track scripts/data/slalom.txt]
//   不给 --track 时用游戏默认载入的官方赛道(第一条)取指纹;给了就按自定义赛道导入后取指纹。
//   写入前会再用游戏自带 Verify 校验一遍(完成帧 true、少 1 帧 false),不通过就拒绝写入。
// 注意:只在本地运行,harness 拒绝所有非静态资源请求,不会上传任何成绩。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchGame } from './lib/pt_harness.mjs';

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
if (!a.result || !a.name) { console.error('用法: node scripts/bundle_plan.mjs --result out/xxx.json --name "赛道名" [--track 导出串文件]'); process.exit(2); }
const OUT = fileURLToPath(new URL('../extension/plans/bundled.json', import.meta.url));
const res = JSON.parse(fs.readFileSync(a.result, 'utf8'));
if (!res.recording || !res.finishFrames || !res.toggles) { console.error('结果文件缺少 recording / finishFrames / toggles'); process.exit(2); }

// 与 extension/src/core.js 里的 hashTrack 完全一致(FNV-1a 32 位 + 长度)
function hashTrack(td) { let h = 2166136261 >>> 0; const n = td.length; if (typeof td === 'string') for (let i = 0; i < n; i++) h = Math.imul(h ^ td.charCodeAt(i), 16777619); else for (let i = 0; i < n; i++) h = Math.imul(h ^ td[i], 16777619); return (h >>> 0).toString(16) + '-' + n; }

const g = await launchGame({ mainVirtual: true, ...(a.track && a.track !== true ? { customTrack: fs.readFileSync(a.track, 'utf8').trim() } : {}) });
try {
  const td = await g.page.evaluate((i) => { const m = window.__pt.meta[i]; const t = m.creates[m.creates.length - 1].trackData; return typeof t === 'string' ? t : Array.from(t); }, g.rt);
  const id = hashTrack(td);
  const n = res.finishFrames;
  const at = await g.verify(res.recording, n, 1); const m1 = await g.verify(res.recording, n - 1, 1);
  const ok = at[0].result === true && m1[0].result === false;
  console.log(JSON.stringify({ id, name: a.name, finishFrames: n, verifyAtFinish: at[0].result, verifyMinus1: m1[0].result, ok }));
  if (!ok) { console.error('Verify 未通过,拒绝写入内置方案'); process.exit(1); }
  const db = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const old = db[id];
  if (old && old.finishFrames <= n && !a.force) { console.log(`已有更快或相同的内置方案(${(old.finishFrames / 1000).toFixed(3)} s),不覆盖(--force 可强制)`); process.exit(0); }
  db[id] = { name: a.name, finishFrames: n, toggles: res.toggles, recording: res.recording, addedAt: new Date().toISOString().slice(0, 10) };
  fs.writeFileSync(OUT, JSON.stringify(db, null, 1) + '\n');
  console.log(`已写入 ${OUT} :${a.name} ${(n / 1000).toFixed(3)} s;记得 node scripts/build_extension.mjs 重建`);
} finally { await g.close(); }
