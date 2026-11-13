// 在"真实的 PolyTrack 页面"里把一份求解结果开一遍给你看:有窗口、有渲染、按真实时间 1x(可调)播放。
// 做法:有窗口的 Chrome 加载官网游戏(只放行游戏静态资源主机),把结果里的回放转成"在第 F 帧按下/松开某键"的事件,
//       用帧精确驱动器把真实键盘事件注入页面;Worker 用虚拟时钟,所以每次播放的结果和求解时逐帧一致。
// 用法:node scripts/play_replay.mjs --track scripts/data/slalom.txt --result out/slalom_v3.json [--pace 1] [--width 1280 --height 720] [--hold 10] [--shots 目录]
// 注意:不会向游戏服务器上传任何成绩(harness 拒绝所有非静态资源请求)。
import fs from 'node:fs';
import path from 'node:path';
import { launchGame } from './lib/pt_harness.mjs';
import { runScript, collect } from './lib/pt_driver.mjs';
import { decodeRecording, KEYS } from './lib/pt_codec.mjs';

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v.slice(2), arr[i + 1]]]), []));
if (!a.track || !a.result) { console.error('用法: node scripts/play_replay.mjs --track <导出串文件> --result <结果.json> [--pace 1] [--hold 10] [--shots 目录]'); process.exit(2); }
process.env.PT_HEADED ??= '1';
process.env.PT_CHROME ??= '1'; // 默认用本机 Google Chrome;设 PT_CHROME= 空可改用 Playwright 自带 Chromium

const res = JSON.parse(fs.readFileSync(a.result, 'utf8'));
const toggles = decodeRecording(res.recording);
const events = [];
for (const k of KEYS) toggles[k].forEach((frame, i) => events.push({ frame, key: k, down: i % 2 === 0 }));
const pace = Number(a.pace ?? 1);
const endFrame = res.finishFrames + 600; // 冲线后多放 0.6 s

const g = await launchGame({ customTrack: fs.readFileSync(a.track, 'utf8').trim(), mainVirtual: false, keepAll: true, viewport: { width: Number(a.width ?? 1280), height: Number(a.height ?? 720) } });
console.log(`播放 ${a.result}:预期完成帧 ${res.finishFrames}(${(res.finishFrames / 1000).toFixed(3)} s),倍速 ${pace}x,按键事件 ${events.length} 个`);

let shotTimer = null;
if (a.shots) {
  fs.mkdirSync(a.shots, { recursive: true });
  let n = 0;
  shotTimer = setInterval(() => { g.page.screenshot({ path: path.join(a.shots, `shot_${String(n++).padStart(2, '0')}.png`) }).catch(() => {}); }, Number(a['shot-every'] ?? 3000));
}

const r = await runScript(g, events, { step: 1000 / 60, pace, chunk: 16, endFrame });
if (shotTimer) clearInterval(shotTimer);
const c = await collect(g, { cut: endFrame });
const ok = c.finishFrames === res.finishFrames;
console.log(JSON.stringify({ finishFrames: c.finishFrames, expected: res.finishFrames, same: ok, runs: c.runs, wallSeconds: +(r.wallMs / 1000).toFixed(1), realtimeMultiplier: +(r.virtualMs / r.wallMs).toFixed(2) }));
if (a.shots) await g.page.screenshot({ path: path.join(a.shots, 'final.png') });
await new Promise((rs) => setTimeout(rs, Number(a.hold ?? 10) * 1000));
await g.close();
process.exit(ok ? 0 : 1);
