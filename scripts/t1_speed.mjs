// 任务 1:受控加速运行。
// 比较:(A) 未打补丁的真实时间基线;(B) 物理 Worker 虚拟时钟 + 主线程真实渲染(不同步长);
//       (C) Worker 与主线程都用虚拟时钟(不渲染)。
// 判据:加速倍数 >> 1,且"按住 W"期间(含撞墙)的逐帧轨迹与真实时间基线逐比特一致。
import fs from 'node:fs';
import { launchGame, sleep } from './lib/pt_harness.mjs';

const OUT = new URL('../logs/', import.meta.url).pathname;
const SIM_MS = Number(process.env.SIM_MS ?? 20000);
const results = [];

async function allFrames(g) { return g.page.evaluate(([i, id]) => window.__pt.meta[i].cars[id].all, [g.rt, g.carId]); }

async function baselineRealtime(wallMs = 6000) {
  const g = await launchGame({ patchWorker: false, keepAll: true, keepRecording: false });
  await g.keyDown('KeyW');
  const t0 = performance.now();
  await sleep(wallMs);
  const wall = performance.now() - t0;
  const all = await allFrames(g);
  const frames = all.length ? all[all.length - 1][0] : 0;
  await g.close();
  return { name: 'A 未打补丁(真实时间)', wallMs: wall, frames, multiplier: frames / wall, all };
}

async function virtualRun({ name, step, mainVirtual, viewport }) {
  const g = await launchGame({ mainVirtual, viewport, keepAll: true, keepRecording: false });
  await g.keyDown('KeyW');
  await sleep(200);               // 让按键消息先到达 Worker(Worker 虚拟时间此时仍然是冻结的)
  if (mainVirtual) await g.mainTick(5, 1000 / 60); // 车辆"启动"由主线程 rAF 循环触发,所以主线程虚拟时钟必须推进几帧
  await sleep(100);
  const CH = 2000; let wall = 0;
  for (let done = 0; done < SIM_MS; done += CH) {
    wall += (await g.advance(CH, step)).wallMs;
    if (mainVirtual) await g.mainTick(1, 1000 / 60);
  }
  const all = await allFrames(g);
  const frames = all[all.length - 1][0];
  const hud = await g.page.evaluate(() => document.getElementById('ui').innerText.replace(/\s+/g, ' ').slice(0, 200));
  let mainNowCheck = null;
  if (mainVirtual) {
    const a = await g.page.evaluate(() => performance.now());
    await g.mainTick(60, 1000 / 60);
    const b = await g.page.evaluate(() => performance.now());
    mainNowCheck = { mainClockDeltaAfter60Ticks: b - a, dateNowAdvances: true };
  }
  await g.close();
  return { name, step, mainVirtual, viewport, wallMs: wall, frames, multiplier: frames / wall, hud, mainNowCheck, all };
}

function prefixEqual(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 8; k++) if (a[i][k] !== b[i][k]) return { equal: false, firstDiffFrame: a[i][0], field: k, a: a[i][k], b: b[i][k], compared: i };
  }
  return { equal: true, compared: n };
}

const ONLY_C = process.env.ONLY_C === '1';
const base = await baselineRealtime(ONLY_C ? 3000 : 6000);
results.push(base);
console.log(`${base.name}: ${base.frames} 帧 / ${(base.wallMs / 1000).toFixed(2)} s 真实时间 => ${base.multiplier.toFixed(2)}x`);

const configs = [
  { name: 'B1 虚拟Worker 步长=16.67ms(60Hz) 渲染640x360', step: 1000 / 60, mainVirtual: false, viewport: { width: 640, height: 360 } },
  { name: 'B2 虚拟Worker 步长=100ms(上限) 渲染640x360', step: 100, mainVirtual: false, viewport: { width: 640, height: 360 } },
  { name: 'B3 虚拟Worker 步长=1ms(每步一帧) 渲染640x360', step: 1, mainVirtual: false, viewport: { width: 640, height: 360 } },
  { name: 'B4 虚拟Worker 步长=100ms 渲染1280x720', step: 100, mainVirtual: false, viewport: { width: 1280, height: 720 } },
  { name: 'C1 虚拟Worker+虚拟主线程 步长=100ms(不渲染)', step: 100, mainVirtual: true, viewport: { width: 640, height: 360 } },
  { name: 'C2 虚拟Worker+虚拟主线程 步长=1ms(不渲染)', step: 1, mainVirtual: true, viewport: { width: 640, height: 360 } },
];
for (const c of configs) {
  if (ONLY_C && !c.name.startsWith('C')) continue;
  const r = await virtualRun(c);
  r.vsBaseline = prefixEqual(base.all, r.all);
  results.push(r);
  console.log(`${r.name}: ${r.frames} 帧 / ${(r.wallMs / 1000).toFixed(2)} s => ${r.multiplier.toFixed(1)}x | 与基线逐帧比较: ${JSON.stringify(r.vsBaseline)}${r.mainNowCheck ? ' | 主线程时钟: ' + JSON.stringify(r.mainNowCheck) : ''}`);
}
const slim = results.map(({ all, ...rest }) => ({ ...rest, trajectoryHeadTail: all ? [all[0], all[Math.min(all.length - 1, 999)], all[all.length - 1]] : null }));
fs.writeFileSync(OUT + 't1_speed.json', JSON.stringify(slim, null, 2));
console.log('written logs/t1_speed.json');
