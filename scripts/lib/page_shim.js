// 在页面主线程最先执行(Playwright addInitScript)。作用:
//  1. 包装 window.Worker,只对物理 Worker 做旁路观察:记录发给它的消息、解码它回传的车辆状态;
//  2. 提供 window.__pt.advance():向 Worker 虚拟时钟发"推进 N 毫秒"指令并等待完成;
//  3. 可选(cfg.mainVirtual):把主线程的 performance.now / Date.now / requestAnimationFrame 也换成虚拟时钟。
(() => {
  const cfg = window.__ptCfg || {};
  const PT = (window.__pt = { cfg, workers: [], meta: [], waiters: new Map(), nextId: 1, mainNow: 0 });
  const realNow = performance.now.bind(performance); // 在任何覆盖之前保存真实时钟,仅用于测量耗时
  PT.realNow = realNow;

  // ---------- 主线程虚拟时钟(可选) ----------
  if (cfg.mainVirtual) {
    const T0 = 1.7e12; let rafId = 1; let rafQ = [];
    Object.defineProperty(performance, 'now', { value: () => PT.mainNow, configurable: true, writable: true });
    Date.now = () => Math.floor(T0 + PT.mainNow);
    window.requestAnimationFrame = (cb) => { const id = rafId++; rafQ.push([id, cb]); return id; };
    window.cancelAnimationFrame = (id) => { rafQ = rafQ.filter((e) => e[0] !== id); };
    // 主线程固定步长推进:每步触发一轮 rAF(游戏渲染/UI 动画),其余 setTimeout 仍用真实时间
    PT.mainTick = (n, dtMs) => {
      for (let i = 0; i < n; i++) { PT.mainNow += dtMs; const q = rafQ; rafQ = []; for (const [, cb] of q) cb(PT.mainNow); }
      return PT.mainNow;
    };
  }

  // ---------- 车辆状态解码(格式见 pt_codec.mjs 的注释) ----------
  function decode(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const carId = dv.getUint32(0, true);
    const frames = u8[4] | (u8[5] << 8) | (u8[6] << 16);
    const speedKmh = dv.getFloat32(7, true);
    const fl = u8[11]; let i = 12; let finishFrames = null;
    if (fl & 2) { finishFrames = u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16); i += 3; }
    const cp = dv.getUint16(i, true); i += 2;
    const px = dv.getFloat32(i, true), py = dv.getFloat32(i + 4, true), pz = dv.getFloat32(i + 8, true); i += 12;
    i += 16; const nImp = u8[i]; i += 1 + 4 * nImp;
    for (let w = 0; w < 4; w++) if (fl & (8 << w)) i += 24;
    i += 16 * 4 + 4; const cb = u8[i];
    return { carId, frames, speedKmh, started: !!(fl & 1), finishFrames, cp, respawnable: !!(fl & 4), x: px, y: py, z: pz, ctl: cb & 31 };
  }
  function hashInto(h, u8) { // 两条 32 位 FNV 变体拼成 64 位摘要
    let a = h[0], b = h[1];
    for (let k = 0; k < u8.length; k++) { const v = u8[k]; a = Math.imul(a ^ v, 16777619); b = Math.imul(b + v + 1, 2246822519) ^ (b >>> 13); }
    h[0] = a; h[1] = b;
  }
  const hex = (h) => (h[0] >>> 0).toString(16).padStart(8, '0') + (h[1] >>> 0).toString(16).padStart(8, '0');

  function carRec(meta, id) {
    return (meta.cars[id] ??= { id, last: null, hash: [2166136261, 1], n: 0, samples: [], finishSeenAt: null, cpEvents: [], resetFrames: [] });
  }

  // ---------- 包装 Worker ----------
  const OW = window.Worker;
  window.Worker = class extends OW {
    constructor(url, opts) {
      super(url, opts);
      if (!String(url).includes('simulation_worker')) return;
      const meta = { idx: PT.workers.length, init: null, creates: [], ctl: [], cars: {}, msgsIn: 0, realtime: null };
      PT.workers.push(this); PT.meta.push(meta);
      const post = this.postMessage.bind(this);
      this.postMessage = (msg, tr) => {
        try {
          if (msg && typeof msg.messageType === 'number') {
            if (msg.messageType === 0) { meta.init = msg; meta.realtime = !!msg.isRealtime; }
            else if (msg.messageType === 3) meta.creates.push(msg);
            else if (msg.messageType === 6) { const c = meta.cars[msg.carId]; meta.ctl.push({ carId: msg.carId, up: msg.up, right: msg.right, down: msg.down, left: msg.left, reset: msg.reset, atFrame: c?.last?.frames ?? null }); }
          }
        } catch (e) { console.error('pt hook', e); }
        return post(msg, tr);
      };
      this.postRaw = post;
      this.addEventListener('message', (ev) => {
        const d = ev.data; meta.msgsIn++;
        if (d && d.__vt) { const w = PT.waiters.get(d.id); if (w) { PT.waiters.delete(d.id); w(d); } return; }
        if (d && d.messageType === 10) {
          for (const buf of d.carStateBuffers) {
            const u8 = new Uint8Array(buf); const s = decode(u8); const c = carRec(meta, s.carId);
            const prev = c.last; c.last = s; c.n++;
            hashInto(c.hash, u8);
            if (cfg.sampleEvery && s.frames % cfg.sampleEvery === 0) c.samples.push([s.frames, s.x, s.y, s.z, s.speedKmh, s.cp]);
            if (prev && s.cp > prev.cp) c.cpEvents.push({ frames: s.frames, cp: s.cp });
            if (prev && !(prev.ctl & 16) && (s.ctl & 16)) c.resetFrames.push(s.frames);
            if (s.finishFrames !== null && c.finishSeenAt === null) c.finishSeenAt = s.frames;
            if (cfg.keepAll) (c.all ??= []).push([s.frames, s.x, s.y, s.z, s.speedKmh, s.cp, s.ctl, s.finishFrames]);
            if (cfg.keepRecording && s.started && (!prev || prev.finishFrames === null)) (c.rec ??= []).push([prev ? prev.frames : 0, s.ctl]);
          }
        }
      });
    }
  };

  // ---------- 供 harness 调用的 API ----------
  PT.advance = (widx, ms, step) => new Promise((resolve) => {
    const id = PT.nextId++; PT.waiters.set(id, resolve);
    PT.workers[widx].postRaw({ __vt: 'advance', id, ms, step });
  });
  PT.snapshot = (widx) => {
    const m = PT.meta[widx]; const out = { idx: widx, realtime: m.realtime, cars: {} };
    for (const [id, c] of Object.entries(m.cars)) out.cars[id] = { n: c.n, last: c.last, hash: hex(c.hash), cpEvents: c.cpEvents, resetFrames: c.resetFrames, finishSeenAt: c.finishSeenAt };
    return out;
  };
  PT.cur = (widx) => { const m = PT.meta[widx]; return m.creates.length ? m.creates[m.creates.length - 1].carId : null; }; // 最新创建的车(整局重来会新建车)
  PT.peek = (widx) => { const c = PT.meta[widx].cars[PT.cur(widx)]; return c && c.last ? { frames: c.last.frames, fin: c.last.finishFrames, cp: c.last.cp, started: c.last.started } : null; };
  PT.getCar = (widx) => { const c = PT.meta[widx].cars[PT.cur(widx)]; return c ? { ...c, hash: hex(c.hash) } : null; };
  PT.resetCarStats = (widx) => { PT.meta[widx].cars = {}; PT.meta[widx].ctl = []; };

  // ---------- 无渲染、无逐帧消息的"离线"路径:复用游戏自带的 Verify / TestDeterminism ----------
  // 新建一个全新的物理 Worker,把游戏自己发给实时 Worker 的 Init / CreateCar 参数(赛道、山体顶点)原样重放,
  // 再发 Verify(回放字符串 + 目标帧数)。Worker 内部是同步循环:不走 rAF,不逐帧 postMessage。
  async function freshWorker(srcIdx) {
    const src = PT.meta[srcIdx];
    const w = new Worker('simulation_worker.bundle.js');
    const wi = PT.workers.indexOf(w);
    const done = new Promise((resolve) => {
      w.addEventListener('message', (ev) => { const d = ev.data; if (d && (d.messageType === 8 || d.messageType === 9)) resolve(d); });
      w.addEventListener('error', (ev) => resolve({ result: null, error: String(ev.message || 'worker error') })); // 例如回放反序列化失败
      setTimeout(() => resolve({ result: null, error: 'timeout' }), 120000);
    });
    w.postMessage({ ...src.init, isRealtime: false });
    return { w, wi, done, src };
  }
  PT.verify = async (srcIdx, recording, targetFrames, repeat = 1) => {
    const out = [];
    for (let r = 0; r < repeat; r++) {
      const { w, done, src } = await freshWorker(srcIdx);
      const c = src.creates[src.creates.length - 1];
      const t0 = realNow();
      w.postMessage({ messageType: 1, mountainVertices: c.mountainVertices, mountainOffset: c.mountainOffset, trackData: c.trackData, carId: 900 + r, carRecording: recording, targetFrames });
      const res = await done; const wall = realNow() - t0;
      out.push({ result: res.result, wallMs: wall, error: res.error ?? null });
      w.terminate();
    }
    return out;
  };
  // 游戏自己的"非实时回放"路径(用于幽灵/验证):CreateCar 带回放 + StartCar 带目标帧数,Worker 内部同步跑完并回传逐帧状态
  PT.replay = async (srcIdx, recording, targetFrames) => {
    const { w, wi, src } = await freshWorker(srcIdx);
    const c = src.creates[src.creates.length - 1];
    w.postMessage({ messageType: 3, mountainVertices: c.mountainVertices, mountainOffset: c.mountainOffset, trackData: c.trackData, carId: 77, carRecording: recording });
    w.postMessage({ messageType: 5, carId: 77, targetSimulationTimeFrames: targetFrames });
    const meta = PT.meta[wi]; let last = null;
    // Worker 里的 WASM 物理模块是异步初始化的;初始化完成前虚拟 tick 不会触发任何东西,所以每轮都让出一点真实时间
    for (let i = 0; i < 4000; i++) {
      await PT.advance(wi, 10, 10);
      last = meta.cars[77]?.last;
      if (last && last.frames >= targetFrames) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const car = meta.cars[77]; const out = { all: car?.all ?? [], last: car?.last ?? null, hash: car ? hex(car.hash) : null };
    w.terminate(); return out;
  };
  // ---------- 批量评估 Worker 池(见 eval_patch.js) ----------
  PT.pool = []; PT.carSeq = 100000;
  PT.makePool = async (srcIdx, n) => {
    for (const p of PT.pool) p.w.terminate();
    PT.pool = [];
    const src = PT.meta[srcIdx]; const c = src.creates[src.creates.length - 1];
    for (let k = 0; k < n; k++) {
      const { w } = await freshWorker(srcIdx);
      const id = PT.nextId++; const ready = new Promise((resolve) => PT.waiters.set(id, resolve));
      w.postMessage({ messageType: 101, id, trackData: c.trackData, mountainVertices: c.mountainVertices, mountainOffset: c.mountainOffset });
      await ready; PT.pool.push({ w });
    }
    return PT.pool.length;
  };
  PT.evalBatch = async (plans, opts) => {
    const n = PT.pool.length; if (!n) throw new Error('call makePool first');
    const per = Math.ceil(plans.length / n); const jobs = [];
    for (let k = 0; k < n; k++) {
      const part = plans.slice(k * per, (k + 1) * per); if (!part.length) continue;
      const id = PT.nextId++; const p = new Promise((resolve) => PT.waiters.set(id, resolve));
      PT.pool[k].w.postMessage({ messageType: 100, id, plans: part, carIdBase: PT.carSeq, ...opts });
      PT.carSeq += part.length; jobs.push(p);
    }
    const res = await Promise.all(jobs); return res.flatMap((r) => r.results);
  };
  // 把一段动作提交为所有池 Worker 的新基准状态(各自用同样的动作前进并快照,保持同步)
  PT.commit = async (actions, seg, segs, reset) => {
    const jobs = PT.pool.map((p) => { const id = PT.nextId++; const pr = new Promise((resolve) => PT.waiters.set(id, resolve)); p.w.postMessage({ messageType: 102, id, actions, seg, segs, reset }); return pr; });
    const res = await Promise.all(jobs);
    return res[0];
  };
  PT.probe = async () => {
    const id = PT.nextId++; const pr = new Promise((resolve) => PT.waiters.set(id, resolve));
    PT.pool[0].w.postMessage({ messageType: 103, id }); return pr;
  };
  PT.testDeterminism = async (srcIdx) => {
    const { w, done } = await freshWorker(srcIdx);
    w.postMessage({ messageType: 2 });
    const res = await done; w.terminate(); return res.isDeterminstic;
  };
})();
