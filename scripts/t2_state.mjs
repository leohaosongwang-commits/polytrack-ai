// 任务 2:读取车辆状态,并与游戏界面(HUD)交叉核对。
// 方法:旁路观察物理 Worker 回传的状态缓冲区(位置/姿态/速度/检查点/完成帧数),每秒虚拟时间采样一次,
//       同时读取界面 DOM 文本(计时器、车速、检查点计数),核对两者一致。DOM 文本本身也是 OCR 之外的备用读取通道。
import fs from 'node:fs';
import { launchGame, sleep } from './lib/pt_harness.mjs';
const OUT = new URL('../logs/', import.meta.url).pathname;
const custom = fs.readFileSync(new URL('./data/mini_track.txt', import.meta.url), 'utf8').trim();

const g = await launchGame({ customTrack: custom, keepAll: true });
await g.keyDown('KeyW'); await sleep(200);

async function hud() {
  // 按 DOM 结构取数:计时器 = 含 7 个单字符数字 span 的父节点(MM:SS.mmm);车速 = 含 1~3 个数字 span 的父节点;检查点 = 形如 "a/b" 的 span
  return g.page.evaluate(() => {
    const ui = document.getElementById('ui');
    const groups = new Map();
    for (const sp of ui.querySelectorAll('span')) {
      if (sp.children.length === 0 && /^\d$/.test(sp.textContent.trim())) { const p = sp.parentElement; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(sp.textContent.trim()); }
    }
    let timeMs = null, speed = null;
    for (const d of groups.values()) {
      if (d.length === 7) timeMs = (+(d[0] + d[1]) * 60 + +(d[2] + d[3])) * 1000 + +(d[4] + d[5] + d[6]);
      else if (d.length >= 1 && d.length <= 3) speed = +d.join('');
    }
    let cp = null, cpTotal = null;
    for (const sp of ui.querySelectorAll('span')) { const m = /^\s*(\d+)\/(\d+)\s*$/.exec(sp.textContent); if (sp.children.length === 0 && m) { cp = +m[1]; cpTotal = +m[2]; break; } }
    return { timeMs, speed, cp, cpTotal };
  });
}
const rows = []; let finishInfo = null;
for (let s = 1; s <= 40; s++) {
  await g.advance(1000, 1000 / 60);
  await sleep(300); // 让主线程 rAF 把最新状态刷到界面上
  const l = await g.last(); const h = await hud();
  const row = { sec: s, state: { frames: l.frames, speedKmh: +l.speedKmh.toFixed(3), x: +l.x.toFixed(3), y: +l.y.toFixed(3), z: +l.z.toFixed(3), cp: l.cp, finishFrames: l.finishFrames }, hud: h,
    // 完成之后 HUD 冻结在完成瞬间(计时器 = finishFrames),物理仍在继续,所以完成后只比较"HUD 计时器 == finishFrames"
    match: l.finishFrames === null
      ? { time: h.timeMs === l.frames, speed: h.speed !== null && Math.abs(h.speed - l.speedKmh) <= 1, cp: h.cp === l.cp }
      : { time: h.timeMs === l.finishFrames, speed: null, cp: h.cp === l.cp } };
  rows.push(row);
  console.log(`t=${s}s  state: frames=${l.frames} v=${l.speedKmh.toFixed(1)} x=${l.x.toFixed(1)} cp=${l.cp} fin=${l.finishFrames} | HUD: ${JSON.stringify(h)} | 一致: ${JSON.stringify(row.match)}`);
  if (l.finishFrames !== null) { finishInfo = { finishFrames: l.finishFrames, firstSeenAtFrames: l.frames }; break; }
}
await sleep(500);
const car = await g.car();
const finalHud = await g.page.evaluate(() => document.getElementById('ui').innerText.replace(/\s+/g, ' ').match(/\d\d:\d\d\.\d\d\d/g));
const summary = {
  samples: rows.length,
  allTimeMatch: rows.every((r) => r.match.time),
  allSpeedMatch: rows.filter((r) => r.match.speed !== null).every((r) => r.match.speed),
  allCpMatch: rows.every((r) => r.match.cp),
  checkpointEvents: car.cpEvents, finishInfo, hudTimesAfterFinish: finalHud,
  note: '运行中 HUD 计时器 = 状态里的 frames(毫秒);完成后 HUD 显示的完成时间 = finishFrames',
};
console.log(JSON.stringify(summary, null, 1));
fs.writeFileSync(OUT + 't2_state.json', JSON.stringify({ rows, summary }, null, 2));
await g.close();
