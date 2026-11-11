// 帧精确的"脚本化驾驶":按 [{frame, key, down}] 事件表,在指定的物理帧号注入真实键盘事件(CDP Input.dispatchKeyEvent)。
//
// 为什么能做到帧精确:
//  * 物理 Worker 的时钟是虚拟的、只在我们发"推进"指令时前进;按键消息到达 Worker 时时间是冻结的,
//    游戏给按键打的帧号 = car.frames + max(0, now - 上次tick时间) = car.frames(差值为 0),即"下一个还没执行的帧"。
//  * 推进用"先大步、再 1ms 单步"的闭环:每次读到最新 frames,直到恰好等于目标帧 F 才注入。
//    (步长 1ms 时每个 tick 至多执行 1 个物理帧,因此不会越过 F。)
import { sleep } from './pt_harness.mjs';
import { RecordingBuilder, encodeRecording } from './pt_codec.mjs';
import crypto from 'node:crypto';

export const KEYCODE = { up: 'KeyW', right: 'KeyD', down: 'KeyS', left: 'KeyA', reset: 'KeyR' };

async function pump(g) { if (g.mainVirtual) await g.mainTick(2, 1000 / 60); else await sleep(30); }

export async function waitStarted(g, tries = 400) {
  // 车辆的 StartCar 由主线程 rAF 循环在第一次按键后发出;Worker 在车辆启动前不产生状态,所以边推进 1ms 边等。
  // 启动前推进虚拟时间不影响结果:车从第 0 步开始就带着第 0 帧的按键(帧号 0)。
  for (let i = 0; i < tries; i++) {
    await pump(g); await g.advance(1, 1);
    const p = await g.peek(); if (p && p.started) return true;
  }
  throw new Error('car did not start');
}

/**
 * opts.step    大步推进时使用的虚拟时钟步长(ms)。1000/60 = 60Hz;100 = 游戏允许的最大步长;1 = 每步一帧
 * opts.pace    >0 时按"虚拟速度 = pace 倍实时"限速(用来测 1x 速度);0 = 全速
 * opts.endFrame 推进到该帧(或完成)为止
 */
export async function runScript(g, events, { step = 1000 / 60, pace = 0, endFrame = 20000, margin = 40, log = null } = {}) {
  const evs = [...events].sort((a, b) => (a.run ?? 0) - (b.run ?? 0) || a.frame - b.frame);
  const t0 = performance.now(); let virt = 0;
  const adv = async (ms, st) => {
    await g.advance(ms, st); virt += ms;
    if (pace > 0) { const due = t0 + virt / pace; const w = due - performance.now(); if (w > 0) await sleep(w); }
  };
  const frames = async () => { const p = await g.peek(); return p ? { f: p.frames, fin: p.fin } : { f: 0, fin: null }; };
  let started = false;
  const reach = async (F) => { // 把物理推进到恰好 frames == F(或完成)
    for (;;) {
      const { f, fin } = await frames();
      if (fin !== null || f >= F) return;
      const rem = F - f;
      if (rem > margin + 8 && step > 1) await adv(rem - margin, step); else await adv(1, 1);
    }
  };
  let curRun = 0; let runsSeen = await g.runsCount();
  for (let i = 0; i < evs.length;) {
    const F = evs[i].frame, R = evs[i].run ?? 0;
    if (log) log('event run', R, 'frame', F, evs[i].key, evs[i].down, 'started', started);
    if (started && R !== curRun) { // 上一局里按了重生键且没有可重生的检查点 => 游戏整局重来:按键处理函数里立刻新建一辆车,帧号从 0 重新开始
      for (let t = 0; t < 400 && (await g.runsCount()) <= runsSeen; t++) await pump(g);
      if ((await g.runsCount()) <= runsSeen) throw new Error('expected a restart (new car) but none happened');
      runsSeen = await g.runsCount();
      await waitStarted(g);
    }
    curRun = R;
    if (started) await reach(F);
    if (started && (await frames()).fin !== null) break;
    const cur = started ? (await frames()).f : 0;
    if (started && cur !== F) throw new Error(`could not land on frame ${F}: at ${cur}`);
    let hadReset = false;
    while (i < evs.length && evs[i].frame === F && (evs[i].run ?? 0) === R) {
      const e = evs[i++];
      if (e.key === 'reset') hadReset = true;
      if (e.down) await g.keyDown(KEYCODE[e.key]); else await g.keyUp(KEYCODE[e.key]);
    }
    await g.page.evaluate(() => 0); // 往返一次,确保主线程已处理完键盘事件并把消息发给 Worker
    if (!started) { await pump(g); await waitStarted(g); started = true; }
    else if (hadReset) await pump(g);
  }
  // 事件之后:继续推进到完成或 endFrame
  for (;;) {
    const { f, fin } = await frames();
    if (fin !== null || f >= endFrame) break;
    await adv(Math.min(500, endFrame - f), step);
    if (g.mainVirtual) await g.mainTick(1, 1000 / 60);
  }
  const wallMs = performance.now() - t0;
  return { wallMs, virtualMs: virt };
}

/** 收集一次运行的结果:完成帧、检查点事件、重生事件、逐帧轨迹摘要哈希、按游戏逻辑从状态流重建的回放 */
export async function collect(g, { cut = null } = {}) {
  const c = await g.page.evaluate(([i]) => { const m = window.__pt.meta[i]; const car = m.cars[window.__pt.cur(i)]; return { all: car.all, rec: car.rec, cpEvents: car.cpEvents, resetFrames: car.resetFrames, last: car.last, ctl: m.ctl, runs: m.creates.length }; }, [g.rt]);
  const fin = c.last.finishFrames;
  const lim = fin !== null ? fin : cut; // 完成的跑法截到完成帧;未完成的跑法截到指定帧
  const rows = c.all.filter((r) => lim === null || r[0] <= lim);
  const h = crypto.createHash('sha256'); for (const r of rows) h.update(r.join(',') + ';');
  const rb = new RecordingBuilder();
  for (const [fr, bits] of c.rec) if (lim === null || fr < lim) rb.record(fr, { up: !!(bits & 1), right: !!(bits & 2), down: !!(bits & 4), left: !!(bits & 8), reset: !!(bits & 16) });
  return { runs: c.runs, cutFrame: lim, rows, finishFrames: fin, lastFrame: c.last.frames, cpEvents: c.cpEvents, resetFrames: c.resetFrames, trajectoryHash: h.digest('hex').slice(0, 24), nRows: rows.length,
    finalPos: rows.length ? rows[rows.length - 1].slice(0, 5) : null, recordedToggles: rb.t, recording: encodeRecording(rb.t), ctlMessages: c.ctl.length };
}
