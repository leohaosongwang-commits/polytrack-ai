// 运行一次"脚本 x 配置"并收集结果;t3 / t4 共用。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { launchGame, sleep } from './pt_harness.mjs';
import { runScript, collect, KEYCODE } from './pt_driver.mjs';
import { eventsToToggles } from './pt_codec.mjs';

export const TRACK = fs.readFileSync(new URL('../data/mini_track.txt', import.meta.url), 'utf8').trim();

// "加速倍数"由两件事决定:Worker 虚拟时钟的步长(每个虚拟 tick 前进多少毫秒)和是否限速/渲染。
export const CONFIGS = {
  fast_step100: { desc: '步长 100ms(游戏允许的最大步长),主线程虚拟、不渲染,全速', step: 100, mainVirtual: true },
  render_60hz: { desc: '步长 16.67ms(60Hz),主线程真实 rAF 渲染 640x360,全速', step: 1000 / 60, mainVirtual: false },
  frame_by_frame: { desc: '步长 1ms(每个 tick 恰好 1 个物理帧),主线程虚拟,全速', step: 1, mainVirtual: true },
  odd_step_7_3: { desc: '步长 7.3ms(与帧不对齐),主线程虚拟,全速', step: 7.3, mainVirtual: true },
  realtime_1x: { desc: '步长 16.67ms 且限速为 1x 实时,主线程真实渲染', step: 1000 / 60, mainVirtual: false, pace: 1 },
};

export function hashRows(rows, upTo) {
  const h = crypto.createHash('sha256');
  for (const r of rows) if (r[0] <= upTo) h.update(r.join(',') + ';');
  return h.digest('hex').slice(0, 24);
}

/** 以虚拟时钟驱动一次脚本,返回结果(含与"游戏非实时回放路径"逐帧对比) */
export async function runOne({ script, cfgName, endFrame = 30000, replayCheck = true, verifyCheck = true, verifyRepeat = 1 }) {
  const cfg = CONFIGS[cfgName];
  const g = await launchGame({ customTrack: TRACK, mainVirtual: cfg.mainVirtual, keepAll: true });
  try {
    const r = await runScript(g, script, { step: cfg.step, pace: cfg.pace ?? 0, endFrame });
    const c = await collect(g, { cut: endFrame });
    const N = c.cutFrame;
    const out = { cfg: cfgName, wallMs: Math.round(r.wallMs), virtualMs: Math.round(r.virtualMs), multiplier: +(r.virtualMs / r.wallMs).toFixed(2),
      runs: c.runs, finishFrames: c.finishFrames, cutFrame: N, cpEvents: c.cpEvents, resetFrames: c.resetFrames, trajectoryHash: c.trajectoryHash, nRows: c.nRows,
      recordedToggles: c.recordedToggles, finalPos: c.finalPos };
    if (replayCheck) {
      const rp = await g.replayStates(c.recording, N);
      const rows = rp.all.filter((x) => x[0] <= N);
      let firstDiff = null;
      if (rows.length !== c.rows.length) firstDiff = { reason: 'length', live: c.rows.length, replay: rows.length };
      else for (let i = 0; i < rows.length && !firstDiff; i++) for (let k = 0; k < 8; k++) if (rows[i][k] !== c.rows[i][k]) { firstDiff = { frame: rows[i][0], field: k, live: c.rows[i][k], replay: rows[i][k] }; break; }
      out.replayPathMatch = { equal: firstDiff === null, rows: rows.length, firstDiff };
    }
    if (verifyCheck && c.finishFrames !== null) {
      const v = await g.verify(c.recording, c.finishFrames, verifyRepeat);
      out.verifyAtFinish = v[0].result; out.verifyError = v[0].error;
      if (verifyRepeat > 1) out.verifyRepeat = v.map((x) => x.result);
      const vm = await g.verify(c.recording, c.finishFrames - 1, 1), vp = await g.verify(c.recording, c.finishFrames + 1, 1);
      out.verifyNeighbors = { minus1: vm[0].result, plus1: vp[0].result }; // 完成帧 +-1 必须验证失败,说明验证对帧数是严格的
    }
    out.recording = c.recording;
    return out;
  } finally { await g.close(); }
}

/** 对照组:不打补丁的真实时间运行,按墙钟时间用 CDP 键盘事件注入(只支持无重来的脚本) */
export async function runRealtimeContrast(script) {
  const g = await launchGame({ customTrack: TRACK, patchWorker: false, keepAll: true });
  try {
    const evs = [...script].sort((a, b) => a.frame - b.frame);
    await g.keyDown(KEYCODE[evs[0].key]);
    const t0 = performance.now();
    for (const e of evs.slice(1)) {
      const due = t0 + e.frame;
      while (performance.now() < due - 3) await sleep(1);
      while (performance.now() < due) { /* 最后几毫秒忙等 */ }
      if (e.down) await g.keyDown(KEYCODE[e.key]); else await g.keyUp(KEYCODE[e.key]);
    }
    for (let i = 0; i < 400; i++) { const p = await g.peek(); if (p && p.fin !== null) break; await sleep(50); }
    const c = await collect(g, { cut: 40000 });
    return { finishFrames: c.finishFrames, trajectoryHash: c.trajectoryHash, recordedToggles: c.recordedToggles, cpEvents: c.cpEvents };
  } finally { await g.close(); }
}

export const expectedToggles = (events) => eventsToToggles(events);
// 游戏对 reset 的记录是"1 帧脉冲":按下 R 的那一帧记一次翻转,下一帧自动记一次翻转(与按住 R 多久无关)
export function expectedTogglesGame(events) {
  const t = eventsToToggles(events.filter((e) => e.key !== 'reset'));
  t.reset = [];
  for (const e of [...events].sort((a, b) => a.frame - b.frame)) if (e.key === 'reset' && e.down) t.reset.push(e.frame, e.frame + 1);
  return t;
}
