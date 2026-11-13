// 把"一条回放串"做成扩展能读的本地方案(只用于本机:不进内置方案表、不进仓库),并用游戏自带 Verify 校验。
// 典型用途:把排行榜回放(游戏的 Watch 功能取得、只读)当起点,在本机的 Chrome 里一点就自动驾驶。
// 用法:node scripts/make_local_plan.mjs --recording-file 回放串.txt --frames 22123 --source "榜单回放(第 1 名)" --out plan.json [--track 导出串文件]
//   输出 plan.json = { key: "ptai1:<赛道指纹>", plan: {...} };把 plan 的 JSON 存进该赛道页面的 localStorage[key] 即可
//   (面板会显示"本地导入:<source>,已通过游戏 Verify";面板上的"清除本赛道缓存"可撤销)。
// 校验:完成帧 true、少 1 帧 false,不通过就拒绝输出。只在本地运行,不会向游戏服务器上传任何成绩(harness 拒绝所有非静态资源请求)。
import fs from 'node:fs';
import { launchGame } from './lib/pt_harness.mjs';
import { decodeRecording } from './lib/pt_codec.mjs';

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
if (!(a['recording-file'] || a.recording) || !a.frames || !a.out) { console.error('用法: node scripts/make_local_plan.mjs --recording-file 回放串.txt --frames N --source "说明" --out plan.json [--track 导出串文件]'); process.exit(2); }
const recording = (a.recording && a.recording !== true ? a.recording : fs.readFileSync(a['recording-file'], 'utf8')).trim();
const frames = Number(a.frames);
// 与 extension/src/core.js 里的 hashTrack 完全一致(FNV-1a 32 位 + 长度)
function hashTrack(td) { let h = 2166136261 >>> 0; const n = td.length; if (typeof td === 'string') for (let i = 0; i < n; i++) h = Math.imul(h ^ td.charCodeAt(i), 16777619); else for (let i = 0; i < n; i++) h = Math.imul(h ^ td[i], 16777619); return (h >>> 0).toString(16) + '-' + n; }

const g = await launchGame({ mainVirtual: true, ...(a.track && a.track !== true ? { customTrack: fs.readFileSync(a.track, 'utf8').trim() } : {}) });
try {
  const td = await g.page.evaluate((i) => { const m = window.__pt.meta[i]; const t = m.creates[m.creates.length - 1].trackData; return typeof t === 'string' ? t : Array.from(t); }, g.rt);
  const id = hashTrack(td);
  const at = await g.verify(recording, frames, 1); const m1 = await g.verify(recording, frames - 1, 1);
  const ok = at[0].result === true && m1[0].result === false;
  console.log(JSON.stringify({ id, frames, verifyAtFinish: at[0].result, verifyMinus1: m1[0].result, ok }));
  if (!ok) { console.error('Verify 未通过(这条回放不是这条赛道的,或完成帧不对),拒绝输出'); process.exit(1); }
  const dec = decodeRecording(recording); const toggles = Array.isArray(dec) ? dec : ['up', 'right', 'down', 'left', 'reset'].map((n) => dec[n]);
  const plan = { v: 1, finishFrames: frames, toggles, recording, verified: true, source: String(a.source && a.source !== true ? a.source : '本地导入'), solvedAt: Date.now() };
  fs.writeFileSync(a.out, JSON.stringify({ key: 'ptai1:' + id, plan }));
  console.log(`已写出 ${a.out}:${(frames / 1000).toFixed(3)} s,key = ptai1:${id}`);
} finally { await g.close(); }
