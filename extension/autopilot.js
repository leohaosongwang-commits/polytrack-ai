// ==UserScript==
// @name         PolyTrack AI 自动驾驶(0.6.3,个人研究)
// @namespace    polytrack-ai
// @version      0.2.0
// @match        https://app-polytrack.kodub.com/0.6.3/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
// 由 scripts/build_extension.mjs 生成,请改源文件后重新构建。
(() => {
  'use strict';
  if (window.__ptaiLoaded) return; window.__ptaiLoaded = true;
  if (!location.href.startsWith('https://app-polytrack.kodub.com/0.6.3/')) return;
  window.__ptCfg = { mainVirtual: false, sampleEvery: 0, keepAll: false, keepRecording: false };
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
    const qx = dv.getFloat32(i, true), qy = dv.getFloat32(i + 4, true), qz = dv.getFloat32(i + 8, true), qw = dv.getFloat32(i + 12, true); i += 16; const nImp = u8[i]; i += 1 + 4 * nImp;
    for (let w = 0; w < 4; w++) if (fl & (8 << w)) i += 24;
    i += 16 * 4 + 4; const cb = u8[i];
    return { carId, frames, speedKmh, started: !!(fl & 1), finishFrames, cp, respawnable: !!(fl & 4), x: px, y: py, z: pz, ctl: cb & 31, wheels: ((fl >> 3) & 1) + ((fl >> 4) & 1) + ((fl >> 5) & 1) + ((fl >> 6) & 1), qx, qy, qz, qw };
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
      super(PT.mapUrl ? PT.mapUrl(url) : url, opts); // 扩展里 mapUrl 把物理 Worker 换成"打过补丁的 blob";harness 里由路由处理,mapUrl 不存在
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
            if (cfg.keepAll) (c.all ??= []).push([s.frames, s.x, s.y, s.z, s.speedKmh, s.cp, s.ctl, s.finishFrames, s.wheels, s.qx, s.qy, s.qz, s.qw]);
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
  PT.peek = (widx) => { const c = PT.meta[widx].cars[PT.cur(widx)]; return c && c.last ? { frames: c.last.frames, fin: c.last.finishFrames, cp: c.last.cp, started: c.last.started, ctl: c.last.ctl } : null; }; // ctl = 物理侧实际收到的按键位(1 上/W,2 右/D,4 下/S,8 左/A,16 重置)
  PT.getCar = (widx) => { const c = PT.meta[widx].cars[PT.cur(widx)]; return c ? { ...c, hash: hex(c.hash) } : null; };
  PT.resetCarStats = (widx) => { PT.meta[widx].cars = {}; PT.meta[widx].ctl = []; };

  // ---------- 无渲染、无逐帧消息的"离线"路径:复用游戏自带的 Verify / TestDeterminism ----------
  // 新建一个全新的物理 Worker,把游戏自己发给实时 Worker 的 Init / CreateCar 参数(赛道、山体顶点)原样重放,
  // 再发 Verify(回放字符串 + 目标帧数)。Worker 内部是同步循环:不走 rAF,不逐帧 postMessage。
  async function freshWorker(srcIdx) {
    const src = PT.meta[srcIdx];
    const w = new Worker('simulation_worker.bundle.js');
    const wi = PT.workers.indexOf(w);
    if (PT.meta[wi]) PT.meta[wi].ours = true; // 我们自己建的评估/校验 Worker(扩展里的时钟推进器不要去推它们)
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
      // gate.shifts 是逐计划的数组:每个 Worker 只拿到自己那一段
      const o = opts && opts.gate && opts.gate.shifts ? { ...opts, gate: { ...opts.gate, shifts: opts.gate.shifts.slice(k * per, (k + 1) * per) } } : opts;
      PT.pool[k].w.postMessage({ messageType: 100, id, plans: part, carIdBase: PT.carSeq, ...o });
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

const __ptSolverMod = (() => {
// 赛道进度势能:由游戏自己的解析器给出的部件表(trackInfo)重建"起点 -> 终点"的中线折线,
// 然后把任意世界坐标投影到折线上得到 (s = 沿中线的弧长, d = 水平偏离中线的距离)。
// 做法:从终点格子对道路格子(类别 Special/Road/RoadTurns/RoadWide)做 BFS(4 邻接,允许相邻层高差 1),
// 同一 BFS 层的格子取质心 => 一个路点。原型限制:假设赛道是"一条主路",不处理分叉/重叠的多层立交。
const SIZE = 5; // 游戏 partSize:格子边长 5 m;格子 c 覆盖世界区间 [5c, 5c+5)
const ROAD_CATS = new Set([0, 1, 2, 3]);
const key = (x, y, z) => `${x},${y},${z}`;

function buildProgress(track) {
  const cells = new Map(); let startPart = null; const finishCells = []; const cpParts = [];
  for (const p of track.parts) {
    if (!ROAD_CATS.has(p.category)) continue;
    for (const c of p.cells) cells.set(key(...c), c);
    if (p.startOrder != null) startPart = p;
    if (track.info[p.partId]?.detector?.type === 1) for (const c of p.cells) finishCells.push(c);
    if (track.info[p.partId]?.detector?.type === 0) cpParts.push(p);
  }
  if (!startPart || !finishCells.length) throw new Error('赛道缺少起点或终点');
  const dist = new Map(); const q = [];
  for (const c of finishCells) { dist.set(key(...c), 0); q.push(c); }
  for (let h = 0; h < q.length; h++) {
    const [x, y, z] = q[h]; const d = dist.get(key(x, y, z));
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
      const k = key(x + dx, y + dy, z + dz);
      if (cells.has(k) && !dist.has(k)) { dist.set(k, d + 1); q.push(cells.get(k)); }
    }
  }
  const startCell = startPart.cells[0];
  const D = Math.max(...startPart.cells.map((c) => dist.get(key(...c)) ?? -1));
  if (D < 0) throw new Error('起点与终点在道路格子上不连通');
  const byLevel = new Map();
  for (const [k, v] of dist) { if (v > D) continue; (byLevel.get(v) ?? byLevel.set(v, []).get(v)).push(cells.get(k)); }
  const wp = [];
  for (let k = D; k >= 0; k--) {
    const w = byLevel.get(k); if (!w) continue;
    const n = w.length;
    wp.push({ x: (w.reduce((a, c) => a + c[0], 0) / n) * SIZE + SIZE / 2, y: (w.reduce((a, c) => a + c[1], 0) / n) * SIZE, z: (w.reduce((a, c) => a + c[2], 0) / n) * SIZE + SIZE / 2 });
  }
  let s = 0; wp[0].s = 0;
  for (let i = 1; i < wp.length; i++) { s += Math.hypot(wp[i].x - wp[i - 1].x, wp[i].z - wp[i - 1].z); wp[i].s = s; }
  const L = s;
  const xs = Float64Array.from(wp, (w) => w.x), zs = Float64Array.from(wp, (w) => w.z), ss = Float64Array.from(wp, (w) => w.s);
  /** 投影到折线:返回 {s, d};s 在 [0, L] */
  function query(x, z) {
    let best = Infinity, bs = 0;
    for (let i = 0; i + 1 < xs.length; i++) {
      const ax = xs[i], az = zs[i], bx = xs[i + 1] - ax, bz = zs[i + 1] - az;
      const len2 = bx * bx + bz * bz; let t = len2 > 0 ? ((x - ax) * bx + (z - az) * bz) / len2 : 0; t = Math.max(0, Math.min(1, t));
      const dx = x - (ax + t * bx), dz = z - (az + t * bz); const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bs = ss[i] + t * Math.sqrt(len2); }
    }
    return { s: bs, d: Math.sqrt(best) };
  }
  const startY = track.start?.position?.y ?? wp[0].y;
  return { length: L, waypoints: wp, query, startY, nCells: cells.size, nLevels: wp.length, checkpoints: cpParts.length };
}

// ======================================================================================
// 分段距离场版本(用于多层 / 带跳跃的赛道,例如官方 Summer 1)
// ---------------------------------------------------------------------------------------
// 把赛道看成"起点 -> 检查点 0 -> 检查点 1 -> ... -> 终点"的有序分段(游戏要求按序通过检查点,状态里的 nextCheckpointIndex 就是当前段号)。
// 对每一段,以该段的目标(检查点 / 终点)为源,在"可行驶格子"图上做 Dijkstra:
//   * 连续邻接(4 邻接,层差 <= 1):代价 5 m/格;
//   * 跳跃边:水平距离 <= jumpMax 格、向上不超过 jumpRise 层、向下不超过 jumpUp 层,代价 = 实际水平距离 x jumpCost(略大于 1,只用来"没路时才跳")。
// 车在第 k 段、位于某格 c 时,进度 s = 前 k 段累计长度 + (第 k 段长度 - dist_k(c))。段与段之间连续。
// 位置 -> 格子:在水平 3x3 范围内找 3D 加权最近的格子;找不到(在空中跨缺口 / 已掉出)就扩大搜索;再用到邻格梯度做亚格插值。
function buildProgressField(track, { cats = [0, 1, 2, 3, 4, 5], solidCats = [5], jumpMax = 6, jumpUp = 5, jumpRise = 1, rampJumpMax = 16, jumpCost = 1.5, blocked = null, strict = false } = {}) {
  // blocked:不参与势场的格子("x,y,z" 集合)—— 规划器发现势场认为"能走"但物理上走不通的路线后,把那段路线上的零件整块屏蔽再重建(见 solver.repairPotential)。strict:某段不连通就抛错。
  const allowed = new Set(cats); const SZ = SIZE;
  const idxOf = new Map(); const cellList = [];
  // 实心方块(category 5,4x4x1 的立方体,设计者把它们叠起来当桥墩 / 墙):正上方还有别的格子,就是被压在下面的实心体,不能行驶 —— 否则势场会"穿墙"规划路线
  const solid = new Set(solidCats); const occ = new Set();
  for (const p of track.parts) if (allowed.has(p.category)) for (const c of p.cells) occ.add(key(...c));
  for (const p of track.parts) if (allowed.has(p.category)) for (const c of p.cells) { if (solid.has(p.category) && !(track.info[p.partId]?.detector || p.startOrder != null) && occ.has(key(c[0], c[1] + 1, c[2]))) continue; /* 起点 / 检查点 / 终点不删 */ const k = key(...c); if (blocked?.has(k) && !(track.info[p.partId]?.detector || p.startOrder != null)) continue; if (!idxOf.has(k)) { idxOf.set(k, cellList.length); cellList.push(c); } }
  const n = cellList.length;
  const cellParts = new Map(); // "x,y,z" -> [零件下标](一个格子可能被多个零件占用)
  track.parts.forEach((p, pi) => { if (allowed.has(p.category)) for (const c of p.cells) { const k = key(...c); (cellParts.get(k) ?? cellParts.set(k, []).get(k)).push(pi); } });
  // 坡道顶端:有多个高度层的非实心部件(斜坡)里最高那层的格子。只有从这里起跳才允许跨很远的缺口(设计好的大跳跃)。
  const rampTop = [];
  for (const p of track.parts) { if (solid.has(p.category) || !allowed.has(p.category)) continue; const ys = p.cells.map((c) => c[1]); const lo = Math.min(...ys), hi = Math.max(...ys); if (hi - lo < 1 || hi - lo > 2) continue; for (const c of p.cells) if (c[1] === hi) { const j = idxOf.get(key(...c)); if (j !== undefined) rampTop.push(j); } }
  const col = new Map(); // "x,z" -> [[y, idx]]
  cellList.forEach((c, i) => { const k = c[0] + ',' + c[2]; (col.get(k) ?? col.set(k, []).get(k)).push([c[1], i]); });
  const dist1 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

  function dijkstra(sources, jmp) {
    const d = new Float64Array(n).fill(Infinity); const heap = [];
    const push = (dd, i) => { heap.push([dd, i]); let j = heap.length - 1; while (j > 0) { const p = (j - 1) >> 1; if (heap[p][0] <= heap[j][0]) break; [heap[p], heap[j]] = [heap[j], heap[p]]; j = p; } };
    const pop = () => { const t = heap[0]; const l = heap.pop(); if (heap.length) { heap[0] = l; let j = 0; for (;;) { let m = j; const a = 2 * j + 1, b = a + 1; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === j) break; [heap[m], heap[j]] = [heap[j], heap[m]]; j = m; } } return t; };
    for (const i of sources) { d[i] = 0; push(0, i); }
    while (heap.length) {
      const [dd, i] = pop(); if (dd > d[i]) continue;
      const [x, y, z] = cellList[i];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
        const j = idxOf.get(key(x + dx, y + dy, z + dz)); if (j === undefined) continue;
        const nd = dd + SZ; if (nd < d[j]) { d[j] = nd; jmp[j] = -1; push(nd, j); }
      }
      for (let dx = -jumpMax; dx <= jumpMax; dx++) for (let dz = -jumpMax; dz <= jumpMax; dz++) {
        const h = Math.hypot(dx, dz); if (h <= 1.5 || h > jumpMax) continue;
        const ys = col.get((x + dx) + ',' + (z + dz)); if (!ys) continue;
        for (const [yy, j] of ys) { const rise = y - yy; /* 正向行驶是 j -> i:向上最多 jumpRise 层(凭水平间隙跳不上高台),向下最多 jumpUp 层 */ if (rise > jumpRise || -rise > jumpUp) continue; const nd = dd + h * SZ * jumpCost; if (nd < d[j]) { d[j] = nd; jmp[j] = -1; push(nd, j); } }
      }
      for (const j of rampTop) { // 坡道顶端起跳的长跳:落点 i 在 rampJumpMax 格内、向上最多 jumpRise 层
        const [jx, jy, jz] = cellList[j]; const h = Math.hypot(x - jx, z - jz); if (h <= jumpMax || h > rampJumpMax) continue;
        const rise = y - jy; if (rise > jumpRise || -rise > jumpUp) continue;
        const nd = dd + h * SZ * jumpCost; if (nd < d[j]) { d[j] = nd; jmp[j] = i; push(nd, j); } // jmp[j] = 长跳的落点
      }
    }
    return d;
  }

  // 有序锚点:起点 -> 检查点(按 cpOrder)-> 终点
  const sel = (pred) => track.parts.filter(pred);
  const startPart = sel((p) => p.startOrder != null)[0];
  // 检查点按 cpOrder 分组:一个检查点可以由并排的多个零件拼成(宽路),车穿过其中任何一个就算过。游戏状态里的 cp 是"已过的检查点个数",
  // 所以势场的目标也必须是"一组零件的并集",否则车过了半个检查点后,势场会让它去 20 m 外的另一半(summer3:进度钉死、规划停滞)。
  const cpMap = new Map(); for (const p of sel((q) => track.info[q.partId]?.detector?.type === 0 && q.cpOrder != null)) (cpMap.get(p.cpOrder) ?? cpMap.set(p.cpOrder, []).get(p.cpOrder)).push(p);
  const cps = [...cpMap.keys()].sort((a, b) => a - b).map((k) => cpMap.get(k));
  const fin = sel((p) => track.info[p.partId]?.detector?.type === 1);
  if (!startPart || !fin.length) throw new Error('赛道缺少起点或终点');
  const srcOf = (parts) => parts.flatMap((p) => p.cells.map((c) => idxOf.get(key(...c)))).filter((i) => i !== undefined);
  const targets = [...cps, fin];
  const jumps = targets.map(() => new Int32Array(n).fill(-1));
  const fields = targets.map((t, k) => dijkstra(srcOf(t), jumps[k]));
  const startIdx = Math.min(...startPart.cells.map((c) => idxOf.get(key(...c))).filter((i) => i !== undefined));
  const startIdxs = startPart.cells.map((c) => idxOf.get(key(...c))).filter((i) => i !== undefined);
  // 各段长度 = 该段起点(上一个检查点 / 起点)到该段目标的距离
  const segLen = []; const offset = []; let acc = 0;
  for (let k = 0; k < targets.length; k++) {
    const fromIdxs = k === 0 ? startIdxs : srcOf(targets[k - 1]);
    const L = Math.max(...fromIdxs.map((i) => fields[k][i]).filter(Number.isFinite), 0);
    if (!Number.isFinite(L) || L === 0 && k === 0) throw new Error(`第 ${k} 段不连通`);
    segLen.push(L); offset.push(acc); acc += L;
  }
  const total = acc;
  if (strict) for (let k = 0; k < targets.length; k++) { const fromIdxs = k === 0 ? startIdxs : srcOf(targets[k - 1]); if (!fromIdxs.length || !fromIdxs.some((i) => Number.isFinite(fields[k][i]))) throw new Error(`第 ${k} 段不连通(屏蔽后)`); }

  // 空中走廊:每条被选中的长跳,沿"起跳格 -> 落点格"的连线(两侧各 2.5 格)登记 (值 = 落点值 + 到落点的剩余水平距离 x jumpCost x 格长, 最低高度)。
  // 飞行中的车高于下方地面,按普通方式会被映射到脚下平台的格子(那里的剩余距离很大),进度就会"起飞即下降";有了走廊,飞行过程中进度单调增加。
  const air = targets.map((_, k) => { const m = new Map(); for (const j of rampTop) { const i = jumps[k][j]; if (i < 0) continue; const [jx, jy, jz] = cellList[j], [ix, iy, iz] = cellList[i]; const hh = Math.hypot(ix - jx, iz - jz); if (hh < 1) continue;
      const ux = (ix - jx) / hh, uz = (iz - jz) / hh; const minY = Math.min(jy, iy) * SZ - 4;
      for (let t = 0; t <= hh; t += 0.25) { const px = jx + 0.5 + ux * t, pz = jz + 0.5 + uz * t; const val = fields[k][i] + (hh - t) * SZ * jumpCost;
        for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) { const cx = Math.floor(px) + a, cz = Math.floor(pz) + b; if (Math.hypot(cx + 0.5 - px, cz + 0.5 - pz) > 2.5) continue; const key2 = cx + ',' + cz; const old = m.get(key2); if (!old || val < old.v) m.set(key2, { v: val, minY }); } } }
    return m; });
  function locate(x, y, z) { // -> 最近格子下标 + 水平偏离
    const cx = Math.floor(x / SZ), cz = Math.floor(z / SZ), cy = y / SZ;
    for (const R of [1, 3, 8, 20]) {
      let best = -1, bs = Infinity, bd = 0, bv = 0;
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const ys = col.get((cx + dx) + ',' + (cz + dz)); if (!ys) continue;
        for (const [yy, i] of ys) {
          const hx = (cx + dx + 0.5) * SZ - x, hz = (cz + dz + 0.5) * SZ - z; const h = Math.hypot(hx, hz);
          const v = (yy + 0.5 - cy) * SZ; const vs = v > 0 ? v * 3 : -v * 1; // 车下方的格子更合理:在其上方的格子加重惩罚
          const s = h + vs; if (s < bs) { bs = s; best = i; bd = h; bv = v; }
        }
      }
      if (best >= 0) return { i: best, h: bd, v: bv };
    }
    return { i: -1, h: Infinity, v: 0 };
  }
  function query(x, z, y = null, cp = 0) {
    const k = Math.max(0, Math.min(targets.length - 1, cp | 0));
    const yy = y ?? track.start?.position?.y ?? 0;
    if (y != null) { const ak = air[k].get(Math.floor(x / SZ) + ',' + Math.floor(z / SZ)); if (ak && y > ak.minY) return { s: offset[k] + Math.max(0, Math.min(segLen[k], segLen[k] - ak.v)), d: 0, above: 0 }; }
    const { i, h, v } = locate(x, yy, z);
    if (i < 0) return { s: offset[k], d: 99, above: 0 };
    // 亚格插值:朝梯度(邻格中距离最小者)方向的投影修正
    const c = cellList[i]; const f = fields[k]; let g = null, gd = f[i];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) { const j = idxOf.get(key(c[0] + dx, c[1] + dy, c[2] + dz)); if (j !== undefined && f[j] < gd) { gd = f[j]; g = [dx, dz]; } }
    let corr = 0; if (g) corr = Math.max(-SZ / 2, Math.min(SZ / 2, ((x - (c[0] + 0.5) * SZ) * g[0] + (z - (c[2] + 0.5) * SZ) * g[1]))); // 沿 g 方向前进 corr 米 => 距离减少
    const dk = Math.max(0, f[i] - corr);
    const s = offset[k] + Math.max(0, Math.min(segLen[k], segLen[k] - dk));
    // above:车比它映射到的路面格子低多少(米)。从高架路面掉到地面后,最近的格子在头顶上方,above 很大 => 回不去了
    return { s, d: Math.max(0, h - SZ / 2), above: Math.max(0, v) };
  }
  /** 调试用:从 (x,y,z) 出发,按第 cp 段的距离场逐步走到目标,返回经过的格子(含跳跃边),用来看"势场认为的最短路线"长什么样 */
  const idxByAll = (cx, cy, cz) => { const out = []; for (let dx = -rampJumpMax; dx <= rampJumpMax; dx++) for (let dz = -rampJumpMax; dz <= rampJumpMax; dz++) { const ys = col.get((cx + dx) + ',' + (cz + dz)); if (ys) for (const [, j] of ys) out.push(j); } return out; };
  function route(x, y, z, cp) {
    const f = fields[cp]; let { i } = locate(x, y, z); const out = []; let guard = 0;
    while (i >= 0 && f[i] > 0 && guard++ < 4000) {
      const [cx, cy, cz] = cellList[i]; out.push([cx, cy, cz, +f[i].toFixed(0)]); let nb = -1, nd = f[i];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) { const j = idxOf.get(key(cx + dx, cy + dy, cz + dz)); if (j !== undefined && f[j] + SZ <= f[i] + 1e-6 && f[j] < nd) { nd = f[j]; nb = j; } }
      for (let dx = -jumpMax; dx <= jumpMax; dx++) for (let dz = -jumpMax; dz <= jumpMax; dz++) { const h = Math.hypot(dx, dz); if (h <= 1.5 || h > jumpMax) continue; const ys = col.get((cx + dx) + ',' + (cz + dz)); if (!ys) continue; for (const [yy, j] of ys) { const rise = yy - cy; if (rise > jumpRise || -rise > jumpUp) continue; if (f[j] + h * SZ * jumpCost <= f[i] + 1e-6 && f[j] < nd) { nd = f[j]; nb = j; } } }
      if (cellList[i] && !(nb >= 0)) { /* 没有普通边时试试从坡道顶端起跳的长跳(route 只在 i 是坡道顶端时走长跳) */ }
      if (rampTop.includes(i)) for (const jj of idxByAll(cx, cy, cz)) { const [lx, ly, lz] = cellList[jj]; const h = Math.hypot(lx - cx, lz - cz); if (h <= jumpMax || h > rampJumpMax) continue; const rise = ly - cy; if (rise > jumpRise || -rise > jumpUp) continue; if (f[jj] + h * SZ * jumpCost <= f[i] + 1e-6 && f[jj] < nd) { nd = f[jj]; nb = jj; } }
      if (nb < 0) break; i = nb;
    }
    return out;
  }
  const startY = track.start?.position?.y ?? 0;
  const minY = Math.min(...cellList.map((c) => c[1])) * SZ - 15;
  /** 一串格子(route 的返回值)涉及的零件下标(去重;起点 / 检查点 / 终点零件不算) */
  const partsOnRoute = (cells) => { const out = new Set(); for (const c of cells) for (const pi of cellParts.get(key(c[0], c[1], c[2])) ?? []) { const p = track.parts[pi]; if (track.info[p.partId]?.detector || p.startOrder != null) continue; out.add(pi); } return [...out]; };
  return { route, partsOnRoute, kind: 'field', length: total, segLen, offset, query, startY, minY, nCells: n, nLevels: targets.length, checkpoints: cps.length, waypoints: [] };
}

// 参考轨迹势场:把"一圈已经跑通的完整路线"当中线。
// 动机(report 6.13):格子势场表达不了墙 / 环 / 长跳,但探索式规划能给出一圈能冲线的路线(慢、粗糙)。
// 把这圈的逐帧轨迹(3D 折线)当势场,滚动时域规划器就能沿着它优化速度:进度 s = 投影点沿折线的弧长,偏离 d = 到折线的 3D 距离
// (3D:环 / 多层立交里上下两层的路线在水平面上重叠,必须带高度)。折线上每个点还带着当时的车速,规划器可以用它当"入墙 / 起跳要保持的速度"。
//
// samples:[[帧, 车速km/h, flags, 完成帧, 已过检查点数, x, y, z, ...], ...](eval 的采样状态,按帧序)。
// 返回值与 buildProgressField 的接口兼容:query(x, z, y, cp) -> { s, d, above, vref };另有 length / startY / minY / nLevels / checkpoints。
// 检查点分段:cp = k 的车只和路线里"已过 k 个检查点"的那一段(前后各多留 pad 个采样,容忍刚过检查点时的错位)比较,
// 这样同一处 xz 位置上不同阶段的路线不会互相串。
function buildTrajectoryProgress(samples, { pad = 15 } = {}) {
  const n = samples.length;
  if (n < 2) throw new Error('参考轨迹太短');
  const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n), V = new Float64Array(n), S = new Float64Array(n), CP = new Int32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i]; X[i] = s[5]; Y[i] = s[6]; Z[i] = s[7]; V[i] = s[1]; CP[i] = s[4];
    if (i) { acc += Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1], Z[i] - Z[i - 1]); } S[i] = acc;
  }
  const maxCp = CP[n - 1];
  const lo = new Int32Array(maxCp + 2).fill(n), hi = new Int32Array(maxCp + 2).fill(-1);
  for (let i = 0; i < n; i++) { const k = CP[i]; if (i < lo[k]) lo[k] = i; if (i > hi[k]) hi[k] = i; }
  for (let k = 0; k <= maxCp; k++) if (hi[k] < 0) { lo[k] = k ? lo[k - 1] : 0; hi[k] = k ? hi[k - 1] : 0; } // 没有出现过的阶段(不该发生):借用前一段
  let minY = Infinity; for (let i = 0; i < n; i++) if (Y[i] < minY) minY = Y[i];
  function query(x, z, y = null, cp = 0, flat = false) { // flat:四轮离地的状态只比水平位置(飞行中的高度本来就和参考不一样,只有落点 / 方向要对准)
    const k = Math.max(0, Math.min(maxCp, cp | 0)), yy = flat ? 0 : (y ?? Y[0]), fy = flat ? 0 : 1;
    const a = Math.max(0, lo[k] - pad), b = Math.min(n - 1, hi[k] + pad);
    let best = Infinity, bi = a, bt = 0;
    for (let i = a; i < b; i++) {
      const ax = X[i], ay = fy * Y[i], az = Z[i], bx = X[i + 1] - ax, by = fy * (Y[i + 1] - Y[i]), bz = Z[i + 1] - az;
      const len2 = bx * bx + by * by + bz * bz; let t = len2 > 0 ? ((x - ax) * bx + (yy - ay) * by + (z - az) * bz) / len2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + t * bx), dy = yy - (ay + t * by), dz = z - (az + t * bz), d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    const j = Math.min(n - 1, bi + 1);
    return { s: S[bi] + bt * (S[j] - S[bi]), d: Math.sqrt(best), above: 0, vref: V[bi] * (1 - bt) + V[j] * bt };
  }
  const FR = Int32Array.from(samples, (q) => q[0]);
  return { kind: 'trajectory', length: acc, arc: S, frameAt: FR, query, startY: Y[0], minY: minY - 25, nCells: n, nLevels: maxCp + 1, checkpoints: maxCp, waypoints: [] };
}

// 离线搜索器(原型):在游戏自己的确定性物理上,用"滚动时域 + 交叉熵(CEM)"规划 + "全程爬山打磨"找更快的圈速。
//
// 阶段 A(规划,mpc):从已提交快照出发,对未来 H 个动作(每个动作持续 seg 帧)做 CEM 随机射击,
//        取评分最高的计划,提交其前 commitN 个动作(WASM 线性内存快照),重复直到冲线。
// 阶段 B(打磨,polish):对整圈逐帧控制做局部变异(替换窗口 / 平移翻转边界),
//        每代并行评估一批候选,只要完成帧更小就接受。目标函数就是真正的圈速(完成帧数,1 帧 = 1 ms)。
//
// 评分(阶段 A,越大越好):
//   完成  : 1e6 - 完成帧
//   掉出  : -1e6 + 存活帧
//   其他  : 沿中线弧长 s + 速度项(速度 m/s x lookAhead 秒)- 偏离中线惩罚


const ACTIONS = [1, 9, 3, 4]; // 默认动作集:W, W+左, W+右, 刹车。可用 opts.actions 扩展(漂移 SL=12 / SR=6,滑行转向 L=8 / R=2,滑行 0)
const ACTION_NAMES = { 0: '·', 1: 'W', 2: 'R', 3: 'WR', 4: 'S', 6: 'SR', 8: 'L', 9: 'WL', 12: 'SL', 5: 'WS', 13: 'WSL', 7: 'WSR' };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 把逐帧动作掩码转成游戏回放串需要的"翻转帧"列表(5 个键:up,right,down,left,reset) */
function masksToToggles(masks) {
  const lists = [[], [], [], [], []]; const cur = [0, 0, 0, 0, 0];
  for (let f = 0; f < masks.length; f++) for (let k = 0; k < 5; k++) { const v = (masks[f] >> k) & 1; if (v !== cur[k]) { lists[k].push(f); cur[k] = v; } }
  return lists;
}

/** 翻转帧列表(5 键) -> 逐帧掩码,长度 n */
function togglesToMasks(lists, n) {
  const m = new Uint8Array(n);
  lists.forEach((l, k) => { let on = 0, j = 0; for (let f = 0; f < n; f++) { while (j < l.length && l[j] <= f) { on ^= 1; j++; } if (on) m[f] |= 1 << k; } });
  return m;
}

/** 每 seg 帧一个动作 -> 逐帧掩码 */
function expandActions(actions, seg, totalFrames) {
  const m = new Uint8Array(totalFrames);
  for (let f = 0; f < totalFrames; f++) m[f] = actions[Math.min(actions.length - 1, (f / seg) | 0)] ?? 0;
  return m;
}

class Solver {
  /**
   * @param g        已启动的 Game(需 exposeTrack:true,customTrack 为目标赛道)
   * @param opts     {workers, seg, horizon, pop, iters, commitN, lookAhead, halfWidth, seed, log}
   */
  constructor(g, opts = {}) {
    this.g = g;
    // crashStop = {w, drop, minV}(默认开):候选在 w 帧内掉速超过 drop km/h(撞击)就在引擎里提前结束并按"撞了"扣 crashStopPenalty 米;
    //   slalom 实测约 77% 的随机候选会撞,提前结束让模拟帧数少约 40%。carryMass = 初始分布里留给"上一步剩余计划"的概率质量(默认 0.8,旧版 0.55)。
    this.o = { refPath: null, refFlatAir: false, speedPen: 0, speedSlack: 0.9, carryMass: 0.8, localRollback: 0, repairMax: 0, repairCells: 14, repairNear: 15, repairBack: 700, crashStop: { w: 50, drop: 25, minV: 60 }, crashStopPenalty: 30, workers: 4, seg: 40, horizon: 20, segs: null, pop: 112, iters: 2, commitN: 8, lookAhead: 0.6, halfWidth: 8.5, offPenalty: 15, switchPenalty: 0.4, crashRate: 220, crashPenalty: 0, seed: 1, maxFrames: 45000, potential: 'polyline', actions: ACTIONS, extraRel: 1, airMax: 0, airTail: 4, airSettle: 100, stallFrames: 2500, stallMeters: 5, stallRetries: 6, stallBackFrames: 8000, stallRecoverFrames: 4000, stallClearMeters: 40, stallTotalMax: 12, slowKmh: 40, tumblePenalty: 30, fallAbove: 10, tumbleDeg: 50, recoverFrames: 2500, recoverExtra: [], maxRollbacks: 12, slowSegs: [...Array(12).fill(60), ...Array(12).fill(120), ...Array(6).fill(250)], log: () => {}, ...opts };
    this.rng = mulberry32(this.o.seed);
  }
  async init() {
    const ti = await this.g.trackInfo(); this.ti = ti; this.blocked = new Set(); this.repairs = 0;
    // refPath(eval 采样状态数组)给定时:用"一圈已有路线"的轨迹当势场(6.13:探索式规划给出的粗糙一圈 -> 沿它压圈速);偏离 = 到轨迹的 3D 距离
    this.prog = this.o.refPath ? buildTrajectoryProgress(this.o.refPath) : this.o.potential === 'field' ? buildProgressField(ti) : buildProgress(ti);
    this.minY = this.prog.minY ?? this.prog.startY - 12;
    if (this.o.refPath) { if (this.o.halfWidth === 8.5) this.o.halfWidth = 6; } else if (this.o.potential === 'field' && this.o.halfWidth === 8.5) this.o.halfWidth = 1.0; // 距离场的偏离量 = 离开可行驶格子的水平距离
    await this.g.makePool(this.o.workers);
    this.o.log(`赛道: 中线长度 ${this.prog.length.toFixed(0)} m, ${this.prog.nLevels} 个路点, 检查点 ${this.prog.checkpoints} 个; 评估 Worker ${this.o.workers} 个`);
  }

  /** 清掉一次 plan() 留下的运行状态(停滞计数、历史),让同一个 Solver(同一批评估 Worker)可以接着规划别的窗口 */
  resetRun() { this.sHist = []; this.posHist = []; this.stallRetry = 0; this.stallS = null; this.stallTotal = 0; this.stopped = null; this.partial = null; this.stats = null; }

  /** 单个候选的评分 */
  score(r, plan) {
    const { lookAhead, halfWidth, offPenalty, switchPenalty } = this.o;
    let sw = 0; if (plan) for (let i = 1; i < plan.length; i++) if (plan[i] !== plan[i - 1]) sw++;
    if (r.fin >= 0) return 1e6 - r.fin;
    if (r.dead) return -1e6 + r.frames;
    const crashedPen = r.crashed ? this.o.crashStopPenalty : 0; // 引擎因撞击提前结束的候选:照常按终态评分(进度少了自然排后),再扣一笔固定罚分
    let off = 0, crash = 0;
    if (this.v0 != null) { // 速度骤降(撞击)惩罚:相邻采样间的平均减速度 > crashRate km/h/s
      let pv = this.v0, pf = this.f0;
      for (const s of r.smp) { const dt = (s[0] - pf) / 1000; if (dt > 0 && (pv - s[1]) / dt > this.o.crashRate) crash++; pv = s[1]; pf = s[0]; }
    }
    let tumble = 0, fell = false, vdef = 0; const cosT = Math.cos((this.o.tumbleDeg * Math.PI) / 180);
    for (const s of r.smp) {
      const q = this.prog.query(s[5], s[7], s[6], s[4], this.o.refFlatAir && ((s[2] >> 3) & 15) === 0); if (q.d > halfWidth) off += q.d - halfWidth; // 轨迹势场 + refFlatAir:飞行中只比水平位置(实验开关,默认关:summer3 上开了反而更容易停滞)
      if (this.o.speedPen && q.vref != null) { const dv = q.vref * this.o.speedSlack - s[1]; if (dv > vdef) vdef = dv; } // 速度门槛:参考路线在这里的车速(入墙 / 起跳靠它)的 speedSlack 倍,低于它按缺口扣分
      if (q.above > this.o.fallAbove) fell = true; // 掉下高架:回不去 => 按死亡处理
      // 翻滚:四轮都离地、且车身相对竖直方向倾斜超过 tumbleDeg(撞击被弹飞后乱转)。正常的坡道起跳姿态平稳,不会触发。
      if (this.o.tumblePenalty && ((s[2] >> 3) & 15) === 0 && 1 - 2 * (s[8] * s[8] + s[10] * s[10]) < cosT) tumble++;
    }
    const e = r.last; const q = this.prog.query(e[5], e[7], e[6], e[4], this.o.refFlatAir && ((e[2] >> 3) & 15) === 0);
    if (fell || q.above > this.o.fallAbove) return -1e6 + r.frames;
    // 落地预判:计划结束时还在空中的候选,引擎会用 airTail(默认刹车)继续模拟到落地后 airSettle 帧;这里把进度按多花的时间折回,使各候选可比(落地冲击掉速会体现出来)
    const shift = (e[1] / 3.6) * ((r.extra || 0) / 1000);
    return q.s - shift + (e[1] / 3.6) * lookAhead - offPenalty * off - (q.d > halfWidth ? offPenalty * (q.d - halfWidth) : 0) - switchPenalty * sw - this.o.crashPenalty * crash - this.o.tumblePenalty * tumble - crashedPen - this.o.speedPen * vdef;
  }

  /**
   * 势场修复(失败驱动):规划停滞 = 势场认为"往前有路",车却怎么也上不去(例如把一摞实心方块的侧面当成了坡)。
   * 做法:取停滞位置出发、势场认为的最短路线前方 repairCells 个格子,把这些格子所属的零件整块从势场里屏蔽,重建势场;
   * 屏蔽后起点 -> 终点不连通(这条路线是唯一的路,只是需要助跑等)就放弃修复、原样保留。
   * 返回 { rollbackTo: 建议回退到的帧(车最近一次"连续进入"被屏蔽区域之前 repairBack 帧), parts, cells },或 null。
   */
  repairPotential(last, frames) {
    if (this.o.potential !== 'field' || this.repairs >= this.o.repairMax || !this.prog.route || !last) return null;
    const route = this.prog.route(last[5], last[6], last[7], last[4]);
    const parts = this.prog.partsOnRoute(route.slice(1, 1 + this.o.repairCells));
    if (!parts.length) return null;
    const add = []; for (const pi of parts) for (const c of this.ti.parts[pi].cells) add.push(c);
    const nb = new Set(this.blocked); for (const c of add) nb.add(`${c[0]},${c[1]},${c[2]}`);
    let np; try { np = buildProgressField(this.ti, { blocked: nb, strict: true }); } catch { return null; }
    this.blocked = nb; this.prog = np; this.repairs++;
    const R = this.o.repairNear, ctr = add.map((c) => [(c[0] + 0.5) * 5, (c[2] + 0.5) * 5]);
    const near = (h) => ctr.some((q) => Math.hypot(q[0] - h[1], q[1] - h[3]) < R);
    const hist = this.posHist ?? []; let i = hist.length - 1; while (i >= 0 && near(hist[i])) i--;
    const enter = hist[i + 1] ? hist[i + 1][0] : frames; // 最近一次连续进入该区域的帧
    return { rollbackTo: Math.max(0, enter - this.o.repairBack), parts: parts.length, cells: add.length, total: this.repairs };
  }

  /** 评估一批候选并累计统计(候选数、模拟帧数、墙钟),用来看时间花在哪 */
  async evalTimed(plans, opts, f0) {
    const t = Date.now(); const res = await this.g.evalBatch(plans, opts); const st = (this.stats ??= { steps: 0, evalCalls: 0, cands: 0, simFrames: 0, evalMs: 0, commitMs: 0, crashed: 0, itersUsed: 0, committedActions: 0 });
    st.evalMs += Date.now() - t; st.evalCalls++; st.cands += plans.length; for (const r of res) { st.simFrames += Math.max(0, r.frames - f0) + (r.extra || 0); if (r.crashed) st.crashed++; }
    return res;
  }
  statsLine() {
    const s = this.stats; if (!s) return '';
    return `统计: ${s.steps} 步, ${s.cands} 个候选(平均每步 ${(s.cands / Math.max(1, s.steps)).toFixed(0)}、${(s.itersUsed / Math.max(1, s.steps)).toFixed(2)} 轮), 模拟 ${(s.simFrames / 1e6).toFixed(1)}M 帧(平均每候选 ${(s.simFrames / Math.max(1, s.cands)).toFixed(0)} 帧${s.crashed ? `, 撞击提前结束 ${(100 * s.crashed / s.cands).toFixed(0)}%` : ''}), 评估 ${(s.evalMs / 1000).toFixed(1)}s(${(s.simFrames / Math.max(1, s.evalMs)).toFixed(0)}k 帧/s), 提交 ${(s.commitMs / 1000).toFixed(1)}s, 平均每步提交 ${(s.committedActions / Math.max(1, s.steps)).toFixed(1)} 个动作`;
  }

  // ---------- 阶段 A:CEM 滚动时域规划 ----------
  async plan() {
    const { pop, iters, commitN, maxFrames } = this.o; const AC = this.o.actions; const A = AC.length; const rel = AC.map((a) => (ACTIONS.includes(a) ? 1 : this.o.extraRel));
    const baseSegs = this.o.segs ?? Array.from({ length: this.o.horizon }, () => this.o.seg);
    const recoverSegs = [...baseSegs, ...this.o.recoverExtra]; // 失败后的"恢复窗口"用更长的视野(多看 1.2 s),才看得到高速弯里的死胡同
    let segs = baseSegs, horizon = segs.length, total = 0, smpAt = [], slowMode = false, mode = 'base', recoverUntil = -1;
    const setSegs = (sg) => { segs = sg; horizon = sg.length; total = sg.reduce((a, b) => a + b, 0); smpAt = []; let c = 0; for (const x of sg) { c += x; smpAt.push(c); } };
    setSegs(baseSegs);
    let lastV = null; let rollbacks = 0; const committed = []; const durs = []; let frames = 0; let carry = null; let fin = -1; let step = 0;
    if (this.o.prefix) { // 从已有的提交序列(前缀)继续规划:只重算后面的部分,用来快速验证"某个卡点之后能不能过"
      committed.push(...this.o.prefix.committed); durs.push(...this.o.prefix.durs);
      const c0 = await this.g.commit(committed, 1, durs, true); frames = c0.frames; lastV = c0.last ? c0.last[1] : null;
      this.o.log(`  [规划] 从前缀继续:已有 ${committed.length} 个动作 / ${frames} 帧,车速 ${lastV != null ? lastV.toFixed(0) : '-'} km/h`);
    }
    const t0 = Date.now();
    this.stopped = null;
    while (fin < 0 && frames < maxFrames && !this.stopped) {
      if (this.o.cancel?.()) throw new Error('已取消');
      // 长视野两种触发:① 低速机动(起步后车速低于 slowKmh,默认关);② 回退后的恢复窗口(recoverUntil 之前)
      { const slow = !!this.o.slowSegs && frames > 2000 && lastV != null && lastV < this.o.slowKmh; slowMode = slow;
        const want = slow ? 'slow' : this.o.recoverExtra.length && frames < recoverUntil ? 'recover' : 'base';
        if (want !== mode) { mode = want; setSegs(want === 'slow' ? this.o.slowSegs : want === 'recover' ? recoverSegs : baseSegs); carry = null; if (this.o.trace || want !== 'base') this.o.log(`  [规划] 帧 ${frames}: 切换视野 -> ${want === 'slow' ? '低速长时域' : want === 'recover' ? '恢复窗口(长时域)' : '常规'}`); } }
      // 初始分布:有上一轮计划就在其(平移后的)动作上放较大概率
      const probs = Array.from({ length: horizon }, (_, h) => {
        const p = new Float64Array(A);
        const want = carry && h < carry.length ? AC.indexOf(carry[h]) : -1; const base = want >= 0 ? want : AC.indexOf(1);
        let z = 0; for (let a = 0; a < A; a++) if (a !== base) z += rel[a];
        const pBase = want >= 0 ? this.o.carryMass : 0.4; const mass = 1 - pBase; // 其余动作共享的先验质量;extraRel < 1 时漂移等"额外动作"先验更小(搜索空间变大但不稀释常用动作)。carryMass 越大,候选越贴近上一步剩下的计划(局部搜索),越小越发散
        for (let a = 0; a < A; a++) p[a] = a === base ? pBase : (mass * rel[a]) / z;
        return p;
      });
      let best = null; this.v0 = lastV; this.f0 = frames; let itersRun = 0;
      for (let it = 0; it < iters; it++) {
        const plans = []; const idx = []; itersRun++;
                if (carry && it === 0) { const p = carry.slice(0, horizon); while (p.length < horizon) p.push(1); plans.push(p); idx.push(p.map((a) => AC.indexOf(a))); }
        while (plans.length < pop) {
          const ix = probs.map((p) => { let u = this.rng(), a = 0; for (; a < A - 1; a++) { u -= p[a]; if (u <= 0) break; } return a; });
          idx.push(ix); plans.push(ix.map((a) => AC[a]));
        }
        const res = await this.evalTimed(plans, { segs, maxFrames: total, fromCommit: true, sampleAt: smpAt, minY: this.minY, ...(this.o.crashStop ? { crashStop: this.o.crashStop } : {}), ...(this.o.airMax ? { airMax: this.o.airMax, airTail: this.o.airTail, airSettle: this.o.airSettle } : {}) }, frames);
        const sc = res.map((r, i) => this.score(r, plans[i]));
        const order = sc.map((s, i) => i).sort((a, b) => sc[b] - sc[a]);
        if (!best || sc[order[0]] > best.score) best = { score: sc[order[0]], plan: plans[order[0]], res: res[order[0]] };
        const elite = order.slice(0, Math.max(4, Math.round(pop * 0.12)));
        for (let h = 0; h < horizon; h++) {
          const cnt = new Float64Array(A); for (const e of elite) cnt[idx[e][h]]++;
          for (let a = 0; a < A; a++) probs[h][a] = 0.65 * (cnt[a] / elite.length) + 0.35 * probs[h][a];
          const smooth = 0.02; let z = 0; for (let a = 0; a < A; a++) { probs[h][a] += smooth; z += probs[h][a]; } for (let a = 0; a < A; a++) probs[h][a] /= z;
        }
      }
      (this.stats ??= { steps: 0, evalCalls: 0, cands: 0, simFrames: 0, evalMs: 0, commitMs: 0, crashed: 0, itersUsed: 0, committedActions: 0 }).itersUsed += itersRun;
      if (best.score < -5e5) { // 所有候选都掉出赛道:回退若干步(回退幅度逐次加大)并换一批随机数重新规划
        rollbacks++; if (rollbacks > this.o.maxRollbacks || !committed.length) throw new Error(`规划失败:帧 ${frames} 附近所有候选都掉出赛道(已回退 ${rollbacks - 1} 次)`);
        recoverUntil = Math.max(recoverUntil, frames + this.o.recoverFrames); // 回退重来时在失败点之后 recoverFrames 帧内都用长视野
        const back = Math.min(committed.length, commitN * 2 * rollbacks); // 回退 2*rollbacks 个提交步
        committed.length -= back; durs.length -= back;
        const c0 = committed.length ? await this.g.commit(committed, 1, durs, true) : await this.g.commit([], 1, null, true);
        frames = c0.frames; lastV = c0.last ? c0.last[1] : null; carry = null; fin = -1; this.posHist = (this.posHist ?? []).filter((h) => h[0] <= frames);
        this.o.log(`  [规划] 回退 ${back} 个动作(第 ${rollbacks} 次),回到帧 ${frames}`);
        continue;
      }
      const take = best.res.fin >= 0 ? best.plan.length : Math.min(commitN, best.plan.length);
      const acts = best.plan.slice(0, take);
      const tCommit = Date.now();
      const c = await this.g.commit(acts, segs[0], segs.slice(0, acts.length));
      { const st = this.stats; st.commitMs += Date.now() - tCommit; st.steps++; st.committedActions += take; }
      if (c.last) (this.posHist ??= []).push([c.frames, c.last[5], c.last[6], c.last[7], this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]).s]);
      committed.push(...acts); durs.push(...segs.slice(0, acts.length)); frames = c.frames; fin = c.fin; lastV = c.last ? c.last[1] : lastV; carry = best.plan.slice(take);
      step++; if (rollbacks > 0 && frames > recoverUntil) rollbacks = 0; // 越过恢复窗口就清零,零星的几次失败不该耗光额度
      this.partial = { committed: committed.slice(), durs: durs.slice(), frames, last: c.last };
      if (this.o.stopS != null && c.last) { const qs = this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]).s; if (qs >= this.o.stopS) { this.stopped = { frames, v: c.last[1], pos: [c.last[5], c.last[6], c.last[7]], s: qs, cp: c.last[4] }; break; } } // 局部实验:到达指定中线进度就停(比较"谁先到")
      if (c.last && this.o.stallFrames) { // 停滞看门狗:最近 stallFrames 帧内进度增长不足 stallMeters => 快速失败(并保留现场供诊断)
        const q = this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]); (this.sHist ??= []).push([frames, q.s]);
        const old = this.sHist.find((h) => h[0] >= frames - this.o.stallFrames);
        const stalled = old && frames >= this.o.stallFrames && q.s - old[1] < this.o.stallMeters && this.sHist[0][0] <= frames - this.o.stallFrames;
        if ((this.stallRetry ?? 0) > 0 && this.stallS != null && q.s > this.stallS + this.o.stallClearMeters) { this.o.log(`  [规划] 越过卡点(进度 ${this.stallS.toFixed(0)} -> ${q.s.toFixed(0)} m):重试额度清零`); this.stallRetry = 0; this.stallS = null; } // 长赛道有好几个难点:额度按"卡点"计,不是整局共用
        if (stalled && this.o.repairMax > 0) { // 先试"势场修复":把势场认为的那条走不通的路线屏蔽掉,只回退到进入该区域之前一点点,而不是整段重来
          const rep = this.repairPotential(c.last, frames);
          if (rep) {
            let total = frames; while (committed.length > 1 && total > rep.rollbackTo) { total -= durs.pop(); committed.pop(); }
            const c0 = await this.g.commit(committed, 1, durs, true);
            this.posHist = (this.posHist ?? []).filter((h) => h[0] <= c0.frames);
            this.o.log(`  [规划] 停滞(帧 ${frames},位置 x=${c.last[5].toFixed(0)} y=${c.last[6].toFixed(0)} z=${c.last[7].toFixed(0)},车速 ${c.last[1].toFixed(0)} km/h):势场修复 #${rep.total}:屏蔽 ${rep.parts} 个零件(${rep.cells} 格)后势场仍连通,回退到帧 ${c0.frames}`);
            frames = c0.frames; lastV = c0.last ? c0.last[1] : null; carry = null; fin = -1; this.sHist = []; slowMode = false; mode = 'base'; setSegs(baseSegs);
            continue;
          }
        }
        if (stalled && (this.stallRetry ?? 0) < this.o.stallRetries && (this.stallTotal ?? 0) < this.o.stallTotalMax) { // 停滞:不立刻失败,回退一大段(逐次加大)后换一批随机数重规划(例如坡道前需要重新拉开助跑距离)
          this.stallRetry = (this.stallRetry ?? 0) + 1; this.stallTotal = (this.stallTotal ?? 0) + 1; this.stallS = Math.max(this.stallS ?? 0, q.s); let want = this.o.stallBackFrames * (1 + 0.5 * (this.stallRetry - 1)); let cut = 0;
          if (this.o.localRollback > 0) { // 局部回退:退到"进度比停滞时的最高进度低 localRollback 米(逐次加大)"的最近一帧,而不是固定退 8000 帧(短赛道会直接退回起点、整段重算)
            const hist = this.posHist ?? []; const sMax = Math.max(...hist.slice(-Math.ceil(this.o.stallFrames / 100) - 8).map((h) => h[4] ?? -Infinity)); const sTarget = sMax - this.o.localRollback * (1 + 0.75 * (this.stallRetry - 1));
            let i = hist.length - 1; while (i >= 0 && !(hist[i][4] <= sTarget)) i--;
            want = Math.max(1, frames - (i >= 0 ? hist[i][0] : 0));
          }
          while (committed.length > 1 && cut < want) { cut += durs.pop(); committed.pop(); }
          const c0 = await this.g.commit(committed, 1, durs, true);
          frames = c0.frames; lastV = c0.last ? c0.last[1] : null; carry = null; fin = -1; this.sHist = []; slowMode = false; mode = 'base'; setSegs(baseSegs); this.posHist = (this.posHist ?? []).filter((h) => h[0] <= frames);
          if (this.o.recoverExtra.length) recoverUntil = Math.max(recoverUntil, frames + this.o.stallRecoverFrames); // 停滞后重规划的这一段用长视野(recoverExtra):坡道 / 起跳的后果要几秒后才看得到
          this.o.log(`  [规划] 停滞(帧 ${frames + cut},位置 x=${c.last[5].toFixed(0)} z=${c.last[7].toFixed(0)},车速 ${c.last[1].toFixed(0)} km/h):回退 ${cut} 帧到 ${frames},第 ${this.stallRetry}/${this.o.stallRetries} 次重规划`);
          continue;
        }
        if (stalled) throw Object.assign(new Error(`规划停滞:帧 ${frames} 前 ${this.o.stallFrames} 帧内进度只增加 ${(q.s - old[1]).toFixed(1)} m(s=${q.s.toFixed(0)}/${this.prog.length.toFixed(0)},位置 x=${c.last[5].toFixed(1)} y=${c.last[6].toFixed(1)} z=${c.last[7].toFixed(1)},车速 ${c.last[1].toFixed(0)} km/h)`), { partial: this.partial });
      }
      if (this.o.trace && c.last) { const q = this.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]); this.o.log(`    t=${frames} v=${c.last[1].toFixed(0)} s=${q.s.toFixed(0)} d=${q.d.toFixed(1)} y=${c.last[6].toFixed(1)} flags=${c.last[2]} acts=${acts.map((a) => ACTION_NAMES[a]).join('')}`); }
      if (step % 5 === 0 || fin >= 0) this.o.log(`  [规划] 步 ${step}: 已提交 ${frames} 帧, 速度 ${c.last ? c.last[1].toFixed(0) : '-'} km/h, 评分 ${best.score.toFixed(1)}, 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    this.v0 = null; // 打磨阶段的局部评分只有一个采样点,不做撞击判断
    this.o.log('  [规划] ' + this.statsLine());
    if (this.stopped) return { masks: null, finishFrames: -1, committed, durs, stopped: this.stopped };
    if (fin < 0) throw new Error('规划未能在 maxFrames 内冲线');
    // 提交时可能因整段动作多走了几帧;真实完成帧以 fin 为准
    const masks = new Uint8Array(fin); { let f = 0; for (let i = 0; i < committed.length && f < fin; i++) for (let j = 0; j < durs[i] && f < fin; j++) masks[f++] = committed[i]; }
    return { masks, finishFrames: fin, committed };
  }

  // ---------- 阶段 B:窗口爬山打磨(带快照的局部搜索,最终以整圈完成帧验收) ----------
  // 每轮:随机选窗口起点 W 与长度 Lw;把前缀 [0,W) 提交为快照;对窗口做一批变异,各自模拟 "窗口 + K 帧原计划尾部",
  //       用局部评分(同一时刻的中线进度 + 速度项)比较;最优候选若局部更好,再做一次整圈完整评估,完成帧不变差才接受。
  mutateWindow(win) {
    const r = this.rng; const n = win.length; const out = Array.from(win); const ri = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    const kind = r();
    if (kind < 0.35) { const a = ri(0, n - 1), len = ri(2, Math.min(n, 120)), act = this.o.actions[ri(0, this.o.actions.length - 1)]; for (let f = a; f < Math.min(n, a + len); f++) out[f] = act; }
    else if (kind < 0.75) { // 平移一个翻转边界
      const edges = []; for (let f = 1; f < n; f++) if (out[f] !== out[f - 1]) edges.push(f);
      if (edges.length) { const e = edges[ri(0, edges.length - 1)]; const d = ri(-25, 25) || 1; if (d > 0) { for (let f = e; f < Math.min(n, e + d); f++) out[f] = out[e - 1]; } else { for (let f = Math.max(0, e + d); f < e; f++) out[f] = out[e]; } }
    } else if (kind < 0.9) { // 把窗口整体换成一个恒定动作(清除抖动)
      const act = this.o.actions[ri(0, this.o.actions.length - 1)]; const a = ri(0, n - 1), len = ri(10, Math.min(n, 200)); for (let f = a; f < Math.min(n, a + len); f++) out[f] = act;
    } else { const a = ri(0, n - 1), len = ri(1, 12); for (let f = a; f < Math.min(n, a + len); f++) out[f] = 4; } // 短促刹车
    return out;
  }

  async polish(masks0, fin0, { seconds = 60, batch = 96, K = 1000, maxIters = Infinity } = {}) {
    let best = Array.from(masks0), bestFin = fin0; const t0 = Date.now(); let it = 0, accepted = 0; const history = [{ it: 0, fin: bestFin, t: 0 }];
    while ((Date.now() - t0) / 1000 < seconds && it < maxIters && !this.o.cancel?.()) { // maxIters 给定时按迭代数停止(可复现);否则按时间
      it++;
      const n = best.length; const Lw = [30, 60, 120, 240][Math.floor(this.rng() * 4)];
      const W = Math.floor(this.rng() * Math.max(1, n - 50));
      const win = best.slice(W, W + Lw); const tail = best.slice(W + Lw, W + Lw + K);
      const span = win.length + tail.length;
      await this.g.commit(best.slice(0, W), 1, null, true);
      const plans = [win.concat(tail)];
      for (let b = 1; b < batch; b++) plans.push(this.mutateWindow(win).concat(tail));
      const res = await this.g.evalBatch(plans, { seg: 1, tail: 1, maxFrames: span, fromCommit: true, sampleAt: [span], minY: this.minY });
      const sc = res.map((r) => this.score(r, null));
      let bi = 0; for (let i = 1; i < sc.length; i++) if (sc[i] > sc[bi]) bi = i;
      if (bi === 0 || sc[bi] <= sc[0] + 1e-6) continue;
      const cand = best.slice(0, W).concat(plans[bi].slice(0, win.length), best.slice(W + Lw));
      const fin = await this.finishOf(cand);
      if (fin >= 0 && fin <= bestFin) {
        const improved = fin < bestFin; best = cand.slice(0, fin); bestFin = fin; accepted++;
        if (improved) { history.push({ it, fin: bestFin, t: (Date.now() - t0) / 1000 }); this.o.log(`  [打磨] 轮 ${it}: 完成帧 ${bestFin} (${((Date.now() - t0) / 1000) | 0}s, 已接受 ${accepted})`); }
      }
    }
    return { masks: Uint8Array.from(best), finishFrames: bestFin, generations: it, accepted, history };
  }

  /** 对整圈逐帧掩码做一次完整评估(从起点出发),返回完成帧(未完成为 -1) */
  async finishOf(masks) {
    const [r] = await this.g.evalBatch([Array.from(masks)], { seg: 1, tail: 1, maxFrames: masks.length + 200, minY: this.minY });
    return r.fin;
  }
}

// Go-Explore 式探索:先找到"任意一条能冲线的路线",不依赖手工势场对"这条路走不走得通"的判断。
// 动机(report 6.11):官方 summer2 / summer3 里有近乎垂直的墙 / 环形结构,格子势场表达不了,滚动时域规划器在那里停滞。
//
// 做法:
//   档案(archive):把状态按 (已过检查点数, 3D 位置格子 6 x 4 x 6 m) 分格;每格只留一个代表(到达时车速更快的优先 —— 爬墙 / 起跳需要入坡速度)。
//   每个代表 = 一条动作链(父节点 + 一小段动作,每个动作 seg 帧);状态靠"确定性重放"还原(commit 到各评估 Worker 的 WASM 快照)。
//   每轮:按权重挑一格(势场进度只当弱启发:exp((s - s_max)/T) / (1 + 被选次数)),还原它,
//        从它出发做 pop 条随机展开(H 个动作,惰性 = 以 persist 的概率沿用上一个动作),沿途每个动作边界取样 -> 新格子 / 更快到达的格子进档案。
//   某条展开冲线就停(extraSeconds > 0 则再找一会儿取最快的),返回逐帧掩码,交给 Solver.polish 做帧级打磨。
// 与 plan() 的区别:不需要势场"单调向前"这个前提;势场只用来给选格子排个先后,选错了也只是浪费几轮。
async function exploreLap(S, o = {}) {
  const { seconds = 600, pop = 96, H = 24, seg = 60, cellXZ = 6, cellY = 4, T = 60, persist = 0.7, extraSeconds = 0, minSpeedGain = 10, maxIters = Infinity, pNovel = 0.25, airCap = 8, staleExp = 1, pStale = 1 } = o;
  const log = o.log ?? S.o.log, g = S.g, rng = S.rng;
  const AC = [1, 9, 3, 4]; const PW = [0.45, 0.2, 0.2, 0.15]; // W, W+左, W+右, 刹车
  const pickAct = () => { let u = rng(); for (let i = 0; i < AC.length; i++) { u -= PW[i]; if (u <= 0) return AC[i]; } return AC[0]; };
  // 势场里"与目标不连通"的段(segLen = 0,例如 summer2 / summer3 过了最后一个检查点之后要跨环 / 长跳),进度没有梯度 —— 这种段改用
  // "到目标中心的水平直线距离"当弱启发:s = offset[k] + max(0, E - dist),E = 上一个目标到这个目标的直线距离。直线距离在环 / 墙附近会误导,所以它只用来排序,选格子时还掺了 pNovel 的纯新颖度。
  const ti = S.ti, P = S.prog, ctr = (cells) => [cells.reduce((a, c) => a + c[0], 0) / cells.length * 5 + 2.5, 0, cells.reduce((a, c) => a + c[2], 0) / cells.length * 5 + 2.5];
  const groups = new Map(); for (const p of ti.parts) if (ti.info[p.partId]?.detector?.type === 0 && p.cpOrder != null) (groups.get(p.cpOrder) ?? groups.set(p.cpOrder, []).get(p.cpOrder)).push(...p.cells);
  const targets = [...[...groups.keys()].sort((a, b) => a - b).map((k) => ctr(groups.get(k)))]; { const f = []; for (const p of ti.parts) if (ti.info[p.partId]?.detector?.type === 1) f.push(...p.cells); if (f.length) targets.push(ctr(f)); }
  const startC = ti.start?.position ? [ti.start.position.x, 0, ti.start.position.z] : [0, 0, 0];
  const degenerate = (P.segLen ?? []).map((l) => !(l > 1)), segE = targets.map((t, k) => Math.hypot(t[0] - (k ? targets[k - 1][0] : startC[0]), t[2] - (k ? targets[k - 1][2] : startC[2])));
  if (degenerate.some(Boolean)) log(`  [探索] 势场第 ${degenerate.map((d, k) => (d ? k : -1)).filter((k) => k >= 0).join(',')} 段与目标不连通:这些段改用直线距离当弱启发`);
  const sOf = (q, x, z, cp) => { const k = Math.min(cp, targets.length - 1); return degenerate[k] ? P.offset[k] + Math.max(0, segE[k] - Math.hypot(x - targets[k][0], z - targets[k][2])) : q.s; };
  const root = { parent: null, chunk: new Uint8Array(0), frames: 0, last: 1, s: 0 };
  const arch = new Map(); arch.set('root', { node: root, speed: 0, s: 0, bad: false, visits: 0, stale: 0 });
  const chainOf = (node) => { const parts = []; for (let n = node; n; n = n.parent) parts.push(n.chunk); parts.reverse(); const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let k = 0; for (const p of parts) { out.set(p, k); k += p.length; } return out; };

  // ---- 把某个节点的状态还原成各评估 Worker 的"已提交快照" ----
  let cur = null; // 当前已提交的节点
  const load = async (node) => {
    if (node === cur) return;
    const chain = []; let n = node; while (n && n !== cur) { chain.push(n); n = n.parent; }
    let acts, reset;
    if (cur && n === cur) { // 目标是当前快照的后代:只提交增量
      chain.reverse(); acts = [].concat(...chain.map((c) => Array.from(c.chunk))); reset = false;
    } else { acts = Array.from(chainOf(node)); reset = true; }
    const c = await g.commit(acts, seg, acts.map(() => seg), reset);
    if (c.frames !== node.frames) log(`  [探索] 警告:还原节点的帧数 ${c.frames} != 期望 ${node.frames}(重放不一致?)`);
    cur = node;
  };
  await g.commit([], seg, null, true); cur = root;
  const pick = () => { // 按权重抽一格;pNovel 的概率完全不看势场、只看"被选次数"(势场在墙 / 环 / 长跳处会误导,这是保底)
    let smax = -Infinity; for (const c of arch.values()) if (c.s > smax) smax = c.s;
    const novel = rng() < pNovel, useStale = pStale >= 1 || rng() < pStale; // pStale:这一次抽格子才用"最近没产出就降权"(默认每次都用;slalom 靠它:20 s,关掉后 300 s 都没找到)
    // stale = 自上次"选它能产出新格子"以来又选了多少次(Go-Explore 的"productive"信号)
    let tot = 0; const ws = []; for (const c of arch.values()) { const st = useStale ? Math.pow(1 + c.stale, staleExp) : 1, w = (novel ? 1 / ((1 + c.visits) * st * st) : Math.exp((c.s - smax) / T) / ((1 + c.visits) * st)) * (c.bad ? 0.05 : 1); ws.push(w); tot += w; }
    let u = rng() * tot, i = 0; const cells = [...arch.values()]; for (; i < cells.length - 1; i++) { u -= ws[i]; if (u <= 0) break; } return cells[i];
  };
  // 一个取样点 -> 档案。返回 0 = 没变化,1 = 新格子,2 = 同一格里更快到达的代表
  const cpKey = (smp) => smp[4] + '|' + Math.floor(smp[5] / cellXZ) + '|' + Math.floor(smp[6] / cellY) + '|' + Math.floor(smp[7] / cellXZ);
  const register = (base, chunk, smp) => {
    const x = smp[5], y = smp[6], z = smp[7], cp = smp[4];
    if (!(y > S.minY)) return 0;
    const key = cpKey(smp), old = arch.get(key);
    if (old && !(smp[1] > old.speed + minSpeedGain)) return 0;
    const q = S.prog.query(x, z, y, cp);
    const air = ((smp[2] >> 3) & 15) === 0; // 四轮离地:势场的"空中走廊"会给飞行中的状态虚高的进度,这里只允许比起飞点最多高 airCap 米,落地后再按真实位置算
    const qs = sOf(q, x, z, cp), sv = air ? Math.min(qs, base.s + airCap) : qs;
    const node = { parent: base, chunk, frames: smp[0], last: chunk[chunk.length - 1], s: sv };
    arch.set(key, { node, speed: smp[1], s: sv, bad: q.above > S.o.fallAbove || q.d > 25, visits: 0, stale: 0 });
    return old ? 2 : 1;
  };
  const consider = (base, plan, i, smp) => register(base, Uint8Array.from(plan.slice(0, i + 1)), smp);

  // 续跑:resume = { committed } —— 以前某次探索写出的 *.frontier.json / *.failed.json(每个动作 seg 帧)。沿这条链重放一遍,把沿途每个动作边界的状态登记进档案,再接着往后探索。
  if (o.resume?.committed?.length) {
    const acts = o.resume.committed, ds = o.resume.durs ?? acts.map(() => seg);
    if (!ds.every((d) => d === seg)) throw new Error(`续跑文件里的动作时长必须都是 ${seg} 帧(用同样的 --explore-seg)`);
    const [r] = await g.evalBatch([acts], { segs: acts.map(() => seg), maxFrames: acts.length * seg, sampleAt: acts.map((_, k) => (k + 1) * seg), minY: S.minY });
    let prev = root, n = 0;
    for (const smp of r.smp) { const i = Math.round(smp[0] / seg) - 1; if (i < 0 || i >= acts.length) continue; const node = { parent: prev, chunk: Uint8Array.from([acts[i]]), frames: smp[0], last: acts[i], s: 0 }; const got = register(prev, node.chunk, smp); const cell = got ? arch.get(cpKey(smp)) : null; if (cell) node.s = cell.s; prev = cell ? cell.node : node; n += got ? 1 : 0; }
    log(`  [探索] 续跑:沿 ${acts.length} 个动作(${acts.length * seg} 帧)重放,登记 ${n} 个状态,档案 ${arch.size} 格`);
  }
  const t0 = Date.now(); let iters = 0, simFrames = 0, best = null, firstFinAt = null, newCells = 0, lastLog = 0;
  const segs = Array(H).fill(seg), sampleAt = segs.map((_, k) => (k + 1) * seg);
  while (iters < maxIters) {
    if (S.o.cancel?.()) throw new Error('已取消');
    const el = (Date.now() - t0) / 1000;
    if (el > seconds && !best) break;
    if (best && el - firstFinAt > extraSeconds) break;
    iters++;
    const cell = pick(); cell.visits++;
    await load(cell.node);
    const base = cell.node, F = base.frames; let kids = 0;
    const plans = [];
    for (let k = 0; k < pop; k++) {
      const p = new Array(H); let a = rng() < 0.5 ? base.last : pickAct();
      for (let h = 0; h < H; h++) { if (h > 0 && rng() > persist) a = pickAct(); p[h] = a; }
      plans.push(p);
    }
    const res = await g.evalBatch(plans, { segs, maxFrames: H * seg, fromCommit: true, sampleAt, minY: S.minY, ...(S.o.crashStop ? { crashStop: S.o.crashStop } : {}) });
    for (let k = 0; k < res.length; k++) {
      const r = res[k]; simFrames += Math.max(0, r.frames - F);
      if (r.fin >= 0 && (!best || r.fin < best.fin)) { best = { fin: r.fin, base, plan: plans[k] }; if (firstFinAt == null) { firstFinAt = (Date.now() - t0) / 1000; log(`  [探索] 迭代 ${iters}: 找到冲线路线,完成帧 ${r.fin}(${(r.fin / 1000).toFixed(3)} s),用时 ${firstFinAt.toFixed(0)}s`); } }
      for (const s of r.smp) { const i = Math.round((s[0] - F) / seg) - 1; if (i < 0 || i >= H || Math.abs(s[0] - F - (i + 1) * seg) > 0) continue; { const got = consider(base, plans[k], i, s); newCells += got ? 1 : 0; if (got) kids++; } }
    }
    if (kids > 0) cell.stale = 0; else cell.stale++;
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now(); let smax = -Infinity; for (const c of arch.values()) if (c.s > smax) smax = c.s;
      if (o.onFrontier) { let bc = null; for (const c of arch.values()) if (!bc || c.s > bc.s) bc = c; const acts = Array.from(chainOf(bc.node)); o.onFrontier({ committed: acts, durs: acts.map(() => seg), frames: bc.node.frames, last: null, s: bc.s }); } // 定期把"最远进度"那一格的动作链写出去,不用等跑完就能用 diag_fail.mjs 重放
      log(`  [探索] 迭代 ${iters}: 档案 ${arch.size} 格(本段新增/更新 ${newCells}),最远进度 ${smax.toFixed(0)}/${S.prog.length.toFixed(0)} m,已模拟 ${(simFrames / 1e6).toFixed(1)}M 帧,用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`); newCells = 0;
    }
  }
  S.exploreStats = { iters, cells: arch.size, simFrames, seconds: (Date.now() - t0) / 1000 };
  if (!best) { // 没找到:把"最远进度"那一格的动作链当失败现场写出去(diag_fail.mjs 可以重放)
    let bc = null; for (const c of arch.values()) if (!bc || c.s > bc.s) bc = c;
    const acts = Array.from(chainOf(bc.node));
    throw Object.assign(new Error(`探索 ${iters} 轮、${arch.size} 格、${((Date.now() - t0) / 1000).toFixed(0)}s 内没有找到冲线路线(最远进度 ${bc.s.toFixed(0)}/${S.prog.length.toFixed(0)} m)`), { partial: { committed: acts, durs: acts.map(() => seg), frames: bc.node.frames, last: null } });
  }
  const acts = Array.from(chainOf(best.base)).concat(best.plan.slice(0, Math.ceil((best.fin - best.base.frames) / seg)));
  const masks = new Uint8Array(best.fin); let f = 0; for (const a of acts) for (let j = 0; j < seg && f < best.fin; j++) masks[f++] = a;
  log(`  [探索] 结束:${iters} 轮,档案 ${arch.size} 格,模拟 ${(simFrames / 1e6).toFixed(1)}M 帧,${((Date.now() - t0) / 1000).toFixed(0)}s;冲线 ${best.fin} 帧`);
  return { masks, finishFrames: best.fin };
}

return { Solver, masksToToggles, togglesToMasks, buildProgress, buildProgressField, buildTrajectoryProgress, exploreLap };
})();
window.__ptSolver = __ptSolverMod;
window.__ptGuideMath = (() => {
// 引导线(自动驾驶时画在车前面的"赛车线"):纯数学部分,不碰 DOM / WebGL,所以能在 Node 里单测。
//
// 思路:方案是确定性的,把它在评估引擎里整圈跑一遍(每 GUIDE_STEP 帧采一个状态),得到"车接下来要走的轨迹";
// 再用游戏自己的 three.js 相机矩阵(projectionMatrix * viewMatrix)把这条轨迹投影到屏幕上,画成一条贴地的发光缎带:
//   · 颜色 = 那一刻方案按的键(油门 薄荷绿 / 刹车 红 / 滑行 琥珀),所以能提前看出哪里要刹车;
//   · 离车越远越淡,起点在车头前面几米(不盖住车),缎带上有向前流动的箭头;
//   · 2D 叠加画不出遮挡,所以用"地平线裁剪"补一点:沿路线从近到远,某个点投影后比前面所有点的最高屏幕位置还低,就说明被前面的坡顶挡住了,淡出。
// 矩阵是列主序(WebGL / three.js 惯例);世界坐标与物理侧坐标一致(渲染里车的 modelMatrix 平移 == 物理侧位置,已实测)。
const GUIDE_STEP = 10; // 采样间隔(帧;1 帧 = 1 ms),30 m/s 时点距 0.3 m
const popcount4 = (v) => (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1);
const norm3 = (x, y, z) => { const l = Math.hypot(x, y, z); return l > 1e-9 ? [x / l, y / l, z / l] : [0, 0, 0]; };

/** 键位掩码 -> 缎带颜色(0..1)。1 = W 油门,4 = S 刹车 */
function actColor(mask) {
  if (mask & 4) return [1.0, 0.34, 0.26];
  if (mask & 1) return [0.22, 0.98, 0.76];
  return [1.0, 0.82, 0.32];
}

/**
 * samples:评估引擎的采样状态 [[帧, 车速, flags, 完成帧, cp, x, y, z, qx, qy, qz, qw], ...](按帧序,间隔 GUIDE_STEP)
 * masks:逐帧键位掩码(可选,用来给缎带上色)
 * 返回:贴地缎带的中心线 + 横向单位向量 + 弧长,供 projectGuide 使用
 */
function buildGuidePath(samples, masks = null, { drop = 0.62, smooth = 2 } = {}) {
  const n = samples.length; if (n < 4) throw new Error('轨迹太短,画不了引导线');
  const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n), ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n);
  const frames = new Int32Array(n), speed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i]; frames[i] = s[0]; speed[i] = s[1]; px[i] = s[5]; py[i] = s[6]; pz[i] = s[7];
    if (popcount4((s[2] >> 3) & 15) >= 2) { // 至少两个轮子着地:车身朝上的方向可信(坡道 / 倾斜路面);腾空时用世界的上
      const x = s[8], y = s[9], z = s[10], w = s[11];
      ux[i] = 2 * (x * y - w * z); uy[i] = 1 - 2 * (x * x + z * z); uz[i] = 2 * (y * z + w * x);
    } else { ux[i] = 0; uy[i] = 1; uz[i] = 0; }
  }
  const box = (a) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) { let t = 0, c = 0; for (let k = Math.max(0, i - smooth); k <= Math.min(n - 1, i + smooth); k++) { t += a[k]; c++; } o[i] = t / c; } return o; };
  const sx = box(px), sy = box(py), sz = box(pz), sux = box(ux), suy = box(uy), suz = box(uz);
  const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n), rx = new Float64Array(n), ry = new Float64Array(n), rz = new Float64Array(n), arc = new Float64Array(n);
  let prev = [1, 0, 0];
  for (let i = 0; i < n; i++) {
    const u = norm3(sux[i], suy[i], suz[i]); const uu = u[0] || u[1] || u[2] ? u : [0, 1, 0];
    cx[i] = sx[i] - drop * uu[0]; cy[i] = sy[i] - drop * uu[1]; cz[i] = sz[i] - drop * uu[2];
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    const d = norm3(sx[b] - sx[a], sy[b] - sy[a], sz[b] - sz[a]);
    // 右向量 = 行进方向 x 车身上方向(停着不动时 d 为 0,沿用上一个)
    let r = norm3(d[1] * uu[2] - d[2] * uu[1], d[2] * uu[0] - d[0] * uu[2], d[0] * uu[1] - d[1] * uu[0]);
    if (!(r[0] || r[1] || r[2])) r = prev; else prev = r;
    rx[i] = r[0]; ry[i] = r[1]; rz[i] = r[2];
    if (i) arc[i] = arc[i - 1] + Math.hypot(cx[i] - cx[i - 1], cy[i] - cy[i - 1], cz[i] - cz[i - 1]);
  }
  // 颜色:每个采样点取附近几个采样点按键的平均,避免短促的点按让颜色闪
  const col = new Float32Array(3 * n);
  if (masks) {
    for (let i = 0; i < n; i++) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) { const m = masks[Math.min(masks.length - 1, frames[k])] | 0; const [cr, cg, cb] = actColor(m); r += cr; g += cg; b += cb; c++; }
      col[3 * i] = r / c; col[3 * i + 1] = g / c; col[3 * i + 2] = b / c;
    }
  } else for (let i = 0; i < n; i++) { col[3 * i] = 0.22; col[3 * i + 1] = 0.98; col[3 * i + 2] = 0.76; }
  return { n, step: n > 1 ? frames[1] - frames[0] : GUIDE_STEP, frames, speed, cx, cy, cz, rx, ry, rz, arc, col, length: arc[n - 1] };
}

/** 世界坐标点 -> 裁剪坐标(VP 是列主序 4x4:projection * view) */
function clipOf(VP, x, y, z, out = [0, 0, 0, 0]) {
  out[0] = VP[0] * x + VP[4] * y + VP[8] * z + VP[12]; out[1] = VP[1] * x + VP[5] * y + VP[9] * z + VP[13];
  out[2] = VP[2] * x + VP[6] * y + VP[10] * z + VP[14]; out[3] = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
  return out;
}
function mulMat4(a, b) { // a * b,列主序
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let t = 0; for (let k = 0; k < 4; k++) t += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = t; }
  return o;
}
const smooth01 = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

const GUIDE_DEFAULTS = { ahead: 6, range: 170, hCore: 0.55, hOut: 1.4, baseAlpha: 0.9, rowSpacing: 0.6, chevSpacing: 7, chevHalf: 0.62, minHalfNdc: 0.004, maxWiden: 14 };

/**
 * 把"车当前所在帧 f 往前 range 米"的缎带投影到屏幕(NDC),顶点格式 [x, y, r, g, b, a] x 4 个/行(外左 0、内左 a、内右 a、外右 0:边缘羽化)。
 * 返回 { verts: Float32Array, idx: Uint32Array, nVerts, nIdx, rows },箭头的三角形接在同一个数组后面。
 * VP:projection * view;time:秒(箭头流动动画用);opts 见 GUIDE_DEFAULTS。
 */
function projectGuide(path, f, VP, time = 0, opts = {}) {
  const o = { ...GUIDE_DEFAULTS, ...opts };
  const { n, frames, arc, cx, cy, cz, rx, ry, rz, col } = path;
  const t = (f - frames[0]) / path.step; const i0 = Math.max(0, Math.min(n - 2, Math.floor(t))); const fr = Math.max(0, Math.min(1, t - i0));
  const sCar = arc[i0] + fr * (arc[i0 + 1] - arc[i0]), sStart = sCar + o.ahead, sEnd = sCar + o.range;
  let j = i0; while (j < n - 1 && arc[j] < sStart) j++;
  const maxRows = Math.ceil(o.range / o.rowSpacing) + 10, maxChev = Math.ceil(o.range / o.chevSpacing) + 4;
  const verts = new Float32Array((maxRows * 4 + maxChev * 6) * 6), idx = new Uint32Array(maxRows * 18 + maxChev * 12); let nv = 0, ni = 0, rows = 0;
  const rowS = [], rowA = [], rowR = [];
  const c4 = [0, 0, 0, 0]; let hMax = -Infinity, lastArc = -1e9;
  const pushV = (x, y, r, g, b, a) => { const k = nv * 6; verts[k] = x; verts[k + 1] = y; verts[k + 2] = r; verts[k + 3] = g; verts[k + 4] = b; verts[k + 5] = a; return nv++; };
  for (; j < n; j++) {
    const s = arc[j]; if (s > sEnd) break;
    if (s - lastArc < o.rowSpacing && j < n - 1) continue; lastArc = s;
    clipOf(VP, cx[j], cy[j], cz[j], c4); if (!(c4[3] > 0.2)) { if (rows) break; else continue; } // 在相机后面 / 太近:缎带到此为止
    const ndcX = c4[0] / c4[3], ndcY = c4[1] / c4[3];
    const vis = hMax === -Infinity ? 1 : Math.max(0, Math.min(1, 1 + (ndcY - hMax) / 0.03)); // 地平线裁剪:低于前面最高点就淡出
    if (ndcY > hMax) hMax = ndcY;
    // 远处缎带在屏幕上会细成一根线:保证核心至少 minHalfNdc 宽(横向放宽,最多 maxWiden 倍),远处也看得见
    clipOf(VP, cx[j] + rx[j] * o.hCore, cy[j] + ry[j] * o.hCore, cz[j] + rz[j] * o.hCore, c4);
    const half = c4[3] > 0.05 ? Math.abs(c4[0] / c4[3] - ndcX) : 0; const k = half > 1e-9 ? Math.min(o.maxWiden, Math.max(1, o.minHalfNdc / half)) : 1;
    const d = s - sCar; const alpha = o.baseAlpha * smooth01((d - o.ahead) / 8) * Math.pow(Math.max(0, 1 - d / o.range), 0.9) * vis;
    const r = col[3 * j], g = col[3 * j + 1], b = col[3 * j + 2];
    const pts = [[-o.hOut * k, 0], [-o.hCore * k, 1], [o.hCore * k, 1], [o.hOut * k, 0]]; const base = nv; let ok = true;
    for (const [off, solid] of pts) {
      clipOf(VP, cx[j] + rx[j] * off, cy[j] + ry[j] * off, cz[j] + rz[j] * off, c4);
      if (!(c4[3] > 0.05)) { ok = false; break; }
      pushV(c4[0] / c4[3], c4[1] / c4[3], r, g, b, solid ? alpha : 0);
    }
    if (!ok) { nv = base; break; }
    if (rows) { const p = base - 4; for (let q = 0; q < 3; q++) { idx[ni++] = p + q; idx[ni++] = p + q + 1; idx[ni++] = base + q; idx[ni++] = p + q + 1; idx[ni++] = base + q + 1; idx[ni++] = base + q; } }
    rowS.push(s); rowA.push(alpha); rowR.push(j); rows++;
  }
  // 箭头:每 chevSpacing 米一个,整体随时间向前流动
  const phase = (time * 9) % o.chevSpacing;
  if (rows > 1) {
    let k = 0; const first = rowS[0];
    for (let s = Math.ceil((first - phase) / o.chevSpacing) * o.chevSpacing + phase; s <= rowS[rowS.length - 1]; s += o.chevSpacing) {
      while (k < rowS.length - 2 && rowS[k + 1] < s) k++;
      const j0 = rowR[k], j1 = rowR[Math.min(rowR.length - 1, k + 1)], sp = rowS[k + 1] - rowS[k]; const u = sp > 1e-6 ? Math.max(0, Math.min(1, (s - rowS[k]) / sp)) : 0;
      const a = (rowA[k] + (rowA[Math.min(rowA.length - 1, k + 1)] - rowA[k]) * u) * 0.95; if (a < 0.02) continue;
      const mx = cx[j0] + (cx[j1] - cx[j0]) * u, my = cy[j0] + (cy[j1] - cy[j0]) * u, mz = cz[j0] + (cz[j1] - cz[j0]) * u;
      const dx = cx[j1] - cx[j0], dy = cy[j1] - cy[j0], dz = cz[j1] - cz[j0]; const dl = Math.hypot(dx, dy, dz); if (dl < 1e-6) continue;
      const fx = dx / dl, fy = dy / dl, fz = dz / dl, qx = rx[j0], qy = ry[j0], qz = rz[j0];
      const H = o.chevHalf; const shape = [[0, 0.62], [H, -0.1], [H, -0.46], [0, 0.04], [-H, -0.46], [-H, -0.1]]; const bv = nv; let ok = true;
      for (const [lx, lf] of shape) { clipOf(VP, mx + qx * lx + fx * lf, my + qy * lx + fy * lf + 0.02, mz + qz * lx + fz * lf, c4); if (!(c4[3] > 0.05)) { ok = false; break; } pushV(c4[0] / c4[3], c4[1] / c4[3], 1, 1, 1, a); }
      if (!ok) { nv = bv; continue; }
      for (const t3 of [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]]) { idx[ni++] = bv + t3[0]; idx[ni++] = bv + t3[1]; idx[ni++] = bv + t3[2]; }
    }
  }
  return { verts, idx, nVerts: nv, nIdx: ni, rows };
}

return { GUIDE_STEP, GUIDE_DEFAULTS, buildGuidePath, projectGuide, mulMat4, clipOf, actColor };
})();
// 自动驾驶引导线(车前方的发光赛车线)的浏览器侧:取游戏相机矩阵 + 叠加层渲染。数学部分在 scripts/lib/guide.mjs(构建时一起打进来)。
//
// 取相机:游戏用 three.js(WebGL2),每个物体 / 每遍渲染都会 uniformMatrix4fv 上传 projectionMatrix 和 viewMatrix。
// 这里在 WebGL2 原型上包一层,按"当前 program"记住最近一次上传的这两个矩阵;每次 draw 时,如果当前 program 的投影是透视的(m[11] === -1,阴影遍是正交的),
// 就把它当作主相机。每帧的最后一次 draw 之后(同一个任务结束时的微任务)再画我们的叠加层,所以用的是这一帧的相机,不会慢一拍。
// 叠加层是单独的一块 WebGL 画布(position:fixed,pointer-events:none,不碰游戏自己的 GL 状态),只在自动驾驶且开着"引导线"时才有开销。
// 不碰网络、不改游戏的任何绘制;只读矩阵。
(() => {
  const GL2 = window.WebGL2RenderingContext;
  const GM = window.__ptGuideMath; // { buildGuidePath, projectGuide, mulMat4 }
  const R = (window.__ptGuideRT = { cam: null, canvas: null, active: null, enabled: true, err: null, frames: 0 });
  if (!GL2 || !GM || R.hooked) return; R.hooked = true;

  const kindOf = new WeakMap(); const progs = new Map(); let cur = null, pending = false;
  const gUL = GL2.prototype.getUniformLocation;
  GL2.prototype.getUniformLocation = function (p, n) { const l = gUL.call(this, p, n); if (l && (n === 'projectionMatrix' || n === 'viewMatrix')) kindOf.set(l, n); return l; };
  const uP = GL2.prototype.useProgram;
  GL2.prototype.useProgram = function (p) { cur = p; return uP.call(this, p); };
  const uM = GL2.prototype.uniformMatrix4fv;
  GL2.prototype.uniformMatrix4fv = function (loc, tr, v, off) {
    const k = kindOf.get(loc);
    if (k && cur && v && v.length >= 16) { let s = progs.get(cur); if (!s) progs.set(cur, (s = {})); const m = new Float32Array(16), o = off | 0; for (let i = 0; i < 16; i++) m[i] = v[o + i]; s[k] = m; }
    return uM.apply(this, arguments);
  };
  const onDraw = function () {
    if (!R.active || (this.canvas && this.canvas.__ptaiOverlay)) return; // 叠加层自己的绘制不算(否则每画一帧又排一个微任务,死循环)
    const s = progs.get(cur);
    if (s && s.projectionMatrix && s.viewMatrix && s.projectionMatrix[11] === -1) { R.cam = { P: s.projectionMatrix, V: s.viewMatrix }; R.canvas = this.canvas; }
    if (pending) return; pending = true;
    queueMicrotask(() => { try { if (R.active) frame(); } catch (e) { R.err = String(e && e.message || e); } finally { pending = false; } });
  };
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const orig = GL2.prototype[name]; if (!orig) continue;
    GL2.prototype[name] = function () { onDraw.call(this); return orig.apply(this, arguments); };
  }

  // ---------- 叠加层渲染 ----------
  let ov = null; // { cv, gl, prog, vb, ib, loc }
  function makeOverlay() {
    const cv = document.createElement('canvas'); cv.id = 'ptai-guide'; cv.__ptaiOverlay = true;
    cv.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2;display:none;';
    const gl = cv.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('引导线着色器:' + gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 a_pos; in vec4 a_col; out vec4 v_col; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); v_col = a_col; }'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; in vec4 v_col; out vec4 o; void main(){ o = vec4(v_col.rgb * v_col.a, v_col.a); }'));
    gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('引导线着色器链接失败');
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(), ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    const lp = gl.getAttribLocation(prog, 'a_pos'), lc = gl.getAttribLocation(prog, 'a_col');
    gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 4, gl.FLOAT, false, 24, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    document.documentElement.appendChild(cv);
    return { cv, gl, prog, vao, vb, ib };
  }
  function clearOverlay() { if (!ov || ov.cleared) return; ov.gl.clearColor(0, 0, 0, 0); ov.gl.clear(ov.gl.COLOR_BUFFER_BIT); ov.cv.style.display = 'none'; ov.cleared = true; }

  function frame() {
    const A = R.active; if (!A || !R.cam || !R.canvas) return;
    if (!R.enabled) { clearOverlay(); return; }
    if (!ov) { ov = makeOverlay(); if (!ov) { R.err = '没有 WebGL2,画不了引导线'; R.active = null; return; } }
    const rect = R.canvas.getBoundingClientRect(); if (rect.width < 8 || rect.height < 8) { clearOverlay(); return; }
    const st = ov.cv.style;
    ov.cleared = false; st.display = 'block'; st.left = rect.left + 'px'; st.top = rect.top + 'px'; st.width = rect.width + 'px'; st.height = rect.height + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (ov.cv.width !== w || ov.cv.height !== h) { ov.cv.width = w; ov.cv.height = h; }
    const gl = ov.gl; gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const f = A.frames(); if (f == null) return;
    const VP = GM.mulMat4(R.cam.P, R.cam.V);
    const g = GM.projectGuide(A.path, f, VP, performance.now() / 1000, { minHalfNdc: 2.6 / (rect.width / 2) }); // 核心至少约 2.6 像素半宽
    R.frames++; R.lastRows = g.rows;
    if (!g.nIdx) return;
    gl.useProgram(ov.prog); gl.bindVertexArray(ov.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ov.vb); gl.bufferData(gl.ARRAY_BUFFER, g.verts.subarray(0, g.nVerts * 6), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ov.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.idx.subarray(0, g.nIdx), gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, g.nIdx, gl.UNSIGNED_INT, 0);
  }

  window.__ptGuideUI = {
    /** 开始画:path = buildGuidePath 的结果;frames() 返回车当前的物理帧 */
    start(path, frames) { R.active = { path, frames }; R.err = null; },
    stop() { R.active = null; R.cam = null; clearOverlay(); },
    setEnabled(on) { R.enabled = !!on; if (!on) clearOverlay(); },
    isEnabled: () => R.enabled,
    rt: R,
  };
})();

// PolyTrack AI — 页面内自动驾驶(扩展的 MAIN world 脚本,构建时与 page_shim / solver 拼成一个 autopilot.js)。
// 仅个人学习研究;只支持 PolyTrack 0.6.3(https://app-polytrack.kodub.com/0.6.3/)。
//
// 做了什么:
//  1. 把游戏自己的物理 Worker 换成"打过补丁的 blob"(补丁 = 虚拟时钟 + 批量评估引擎,在你自己的浏览器里内存中完成,不写盘);
//  2. 时钟推进器:没开自动驾驶时,按真实时间把虚拟时钟推进给 Worker,游戏照常可玩;
//  3. 求解(规划 + 打磨 + 游戏自带 Verify)直接在页面里跑,结果按赛道缓存;
//  4. 自动驾驶:在精确的物理帧注入键盘事件(帧号来自求解结果),所以每次开的结果和求解时逐帧一致;
//  5. 不拦成绩提交:扩展不包装任何网络 API,上传与否完全由游戏结算界面决定。
(() => {
  const PT = window.__pt;
  const SOLVER = window.__ptSolver; // { Solver }
  const GUIDE = window.__ptGuideMath, GUIDEUI = window.__ptGuideUI; // 引导线(见 extension/src/guide.js)
  const GAME_BASE = 'https://app-polytrack.kodub.com/0.6.3/';
  const WORKER_SHIM = "// 在物理 Worker 脚本最前面注入(由 harness 在浏览器侧、内存中拼接,不落盘、不分发游戏文件)。\n// 作用:把 Worker 里的 performance.now / Date.now / requestAnimationFrame / setTimeout / setInterval\n// 换成由主线程消息驱动的\"虚拟时钟\"。游戏自己的物理循环代码保持原样,只是时间由我们推进。\n(() => {\n  const g = self;\n  let vnow = 0;\n  const T0 = 1.7e12;\n  let nid = 1;\n  let rafQ = [];\n  const timers = new Map(); // id -> {fn, due, every}\n  Object.defineProperty(g.performance, 'now', { value: () => vnow, configurable: true, writable: true });\n  Date.now = () => Math.floor(T0 + vnow);\n  g.requestAnimationFrame = (cb) => { const id = nid++; rafQ.push([id, cb]); return id; };\n  g.cancelAnimationFrame = (id) => { rafQ = rafQ.filter((e) => e[0] !== id); };\n  g.setTimeout = (fn, ms = 0, ...a) => { const id = nid++; timers.set(id, { fn: () => fn(...a), due: vnow + Math.max(0, ms), every: 0 }); return id; };\n  g.setInterval = (fn, ms = 0, ...a) => { const id = nid++; const e = Math.max(1e-3, ms); timers.set(id, { fn: () => fn(...a), due: vnow + e, every: e }); return id; };\n  g.clearTimeout = g.clearInterval = (id) => { timers.delete(id); };\n\n  function tick() {\n    for (const [id, t] of [...timers]) {\n      if (!timers.has(id) || t.due > vnow) continue;\n      if (t.every) t.due = vnow + t.every; else timers.delete(id);\n      t.fn();\n    }\n    const q = rafQ; rafQ = [];\n    for (const [, cb] of q) cb(vnow);\n  }\n  g.addEventListener('message', (ev) => {\n    const d = ev.data;\n    if (!d || typeof d !== 'object' || !d.__vt) return;\n    ev.stopImmediatePropagation();\n    if (d.__vt === 'advance') {\n      // 以固定步长 d.step(ms)推进 d.ms 毫秒虚拟时间;每个步长触发一次到期定时器 + 一轮 rAF 回调\n      let rem = d.ms;\n      const step = d.step > 0 ? d.step : 1000 / 60;\n      while (rem > 1e-9) { const dt = Math.min(step, rem); vnow += dt; rem -= dt; tick(); }\n      g.postMessage({ __vt: 'done', id: d.id, vnow });\n    } else if (d.__vt === 'track') {\n      // 仅在 harness 以 exposeTrack 打补丁时可用:self.__Ko / self.__ho 由补丁暴露\n      const Ko = g.__Ko, ho = g.__ho;\n      if (!Ko || !ho) { g.postMessage({ __vt: 'track', id: d.id, error: 'internals not exposed' }); return; }\n      const tr = Ko.fromSaveString(d.trackData);\n      const parts = [];\n      tr.forEachPart((x, y, z, partId, rotation, axis, color, cpOrder, startOrder) => {\n        const cfg = ho.find((c) => c.id === partId); const cells = [];\n        if (cfg) cfg.tiles.rotated(rotation, axis).forEach((a, b, c2) => cells.push([x + a, y + b, z + c2]));\n        parts.push({ x, y, z, partId, rotation, axis, color, cpOrder, startOrder, category: cfg?.category, cells });\n      });\n      const st = tr.getStartTransform();\n      const info = {};\n      for (const p of parts) {\n        if (info[p.partId]) continue;\n        const cfg = ho.find((c) => c.id === p.partId);\n        const tiles = []; if (cfg) cfg.tiles.rotated(0, 0).forEach((a, b, c2) => tiles.push([a, b, c2]));\n        info[p.partId] = { category: cfg?.category, detector: cfg?.detector ? JSON.parse(JSON.stringify(cfg.detector)) : null, startOffset: cfg?.startOffset ? JSON.parse(JSON.stringify(cfg.startOffset)) : null, tilesUnrotated: tiles };\n      }\n      g.postMessage({ __vt: 'track', id: d.id, parts, info, start: st ? { position: { x: st.position.x, y: st.position.y, z: st.position.z }, quaternion: { x: st.quaternion.x, y: st.quaternion.y, z: st.quaternion.z, w: st.quaternion.w } } : null });\n    } else if (d.__vt === 'catalog') {\n      // 仅在 exposeTrack 补丁下可用:列出全部部件配置(id、类别、未旋转的占格、检测器、起点偏移),用于设计赛道\n      const ho = g.__ho;\n      if (!ho) { g.postMessage({ __vt: 'catalog', id: d.id, error: 'internals not exposed' }); return; }\n      const parts = ho.map((cfg) => { const tiles = []; cfg.tiles.rotated(0, 0).forEach((a, b, c) => tiles.push([a, b, c])); const rot = [1, 2, 3].map((r) => { const o = []; cfg.tiles.rotated(r, 0).forEach((a, b, c) => o.push([a, b, c])); return o; }); return { id: cfg.id, category: cfg.category, tiles, rot, detector: cfg.detector ? JSON.parse(JSON.stringify(cfg.detector)) : null, startOffset: cfg.startOffset ? JSON.parse(JSON.stringify(cfg.startOffset)) : null }; });\n      g.postMessage({ __vt: 'catalog', id: d.id, parts });\n    } else if (d.__vt === 'build') {\n      // 用游戏自己的赛道类生成一条我们自己设计的测试赛道,返回存档串与导出串(PolyTrack2...)\n      const Ko = g.__Ko;\n      if (!Ko) { g.postMessage({ __vt: 'build', id: d.id, error: 'internals not exposed' }); return; }\n      const base = Ko.fromSaveString(d.baseTrackData);\n      const tr = new Ko(base.environment, base.sunDirection);\n      for (const p of d.parts) tr.addPart(p.x, p.y, p.z, p.partId, p.rotation, p.axis ?? 0, p.color ?? 0, p.cpOrder ?? null, p.startOrder ?? null);\n      g.postMessage({ __vt: 'build', id: d.id, save: tr.toSaveString(), exportString: tr.toExportString({ name: d.name, author: null, lastModified: null }), start: (() => { const s = tr.getStartTransform(); return s ? { position: { x: s.position.x, y: s.position.y, z: s.position.z }, quaternion: { x: s.quaternion.x, y: s.quaternion.y, z: s.quaternion.z, w: s.quaternion.w } } : null; })() });\n    } else if (d.__vt === 'now') {\n      g.postMessage({ __vt: 'now', id: d.id, vnow });\n    }\n  });\n})();\n";
  const EVAL_CASES = "case 101:self.__ev={trk:Ko.fromSaveString(r.trackData),mv:r.mountainVertices,mo:r.mountainOffset,snap:null,snap0:null,f:0};\nself.__dec=function(u,f){const dv=new DataView(u.buffer,u.byteOffset,u.byteLength);const fl=u[11];let o=12,fin=-1;if(fl&2){fin=u[o]|u[o+1]<<8|u[o+2]<<16;o+=3}\nconst cp=dv.getUint16(o,true);o+=2;return[f,dv.getFloat32(7,true),fl,fin,cp,dv.getFloat32(o,true),dv.getFloat32(o+4,true),dv.getFloat32(o+8,true),dv.getFloat32(o+12,true),dv.getFloat32(o+16,true),dv.getFloat32(o+20,true),dv.getFloat32(o+24,true)]};\npostMessage({__vt:\"prep\",id:r.id});break;\ncase 103:postMessage({__vt:\"probe\",id:r.id,heap:t.HEAPU8.length});break;\ncase 102:!function(e){\nconst V=self.__ev,seg=e.seg||1,dec=self.__dec;let u=null,f=0;\nif(!V.snap0){s(1,V.mv,new R(V.mo.x,V.mo.y,V.mo.z),V.trk,V.trk.getStartTransform());V.snap0=t.HEAPU8.slice()}\nif(V.snap&&!e.reset){t.HEAPU8.set(V.snap);f=V.f}else{t.HEAPU8.set(V.snap0);f=0}\nconst h={id:1};let fin=-1;\nfor(let ai=0;ai<e.actions.length;ai++){const m=e.actions[ai],sg=e.segs?e.segs[ai]:seg;for(let j=0;j<sg;j++){u=new Uint8Array(n(h,{up:!!(m&1),right:!!(m&2),down:!!(m&4),left:!!(m&8),reset:!!(m&16)}));f++;if(u[11]&2){fin=u[12]|u[13]<<8|u[14]<<16;break}}if(fin>=0)break}\nV.snap=t.HEAPU8.slice();V.f=f;\npostMessage({__vt:\"commit\",id:e.id,frames:f,fin:fin,last:u?dec(u,f):null})}(r);break;\ncase 100:!function(e){\nconst V=self.__ev,dec=self.__dec,out=[];\nconst maxF=Math.min(e.maxFrames||60000,5999999),se=e.sampleEvery|0,seg=e.seg||1,tail=e.tail|0,minY=e.minY==null?-1e9:e.minY;\nlet bd=null;if(e.segs){bd=[];let c=0;for(const x of e.segs){c+=x;bd.push(c)}}\nconst smpAt=e.sampleAt?new Set(e.sampleAt):null;const TA=e.tailArr||null;\nconst CS=e.crashStop||null;const hist=CS?new Float32Array(CS.w|0||50):null;\nlet st=null;\nif(!e.fromCommit)st=V.trk.getStartTransform();else{if(!V.snap0){s(1,V.mv,new R(V.mo.x,V.mo.y,V.mo.z),V.trk,V.trk.getStartTransform());V.snap0=t.HEAPU8.slice()}if(!V.snap){V.snap=V.snap0;V.f=0}}\nfor(let k=0;k<e.plans.length;k++){\nconst plan=e.plans[k],id=e.fromCommit?1:e.carIdBase+k;\nlet f0=0;\nif(e.fromCommit){t.HEAPU8.set(V.snap);f0=V.f}else s(id,V.mv,new R(V.mo.x,V.mo.y,V.mo.z),V.trk,st);\nconst h={id};let f=f0,u=null,fin=-1,dead=false,ai=0,crashed=false;const smp=[];\nconst GT=e.gate||null;let crossed=false,fc=0;const sh=GT&&GT.shifts?(GT.shifts[k]|0):0;\nfor(;f<f0+maxF;f++){\nlet a;if(bd){while(ai<bd.length&&f-f0>=bd[ai])ai++;a=ai}else a=((f-f0)/seg)|0;let m=a<plan.length?plan[a]:(TA?(TA[a-plan.length]??tail):tail);\nif(crossed){const pi=f-fc+sh;m=(pi>=0&&pi<GT.post.length)?GT.post[pi]:tail}\nu=new Uint8Array(n(h,{up:!!(m&1),right:!!(m&2),down:!!(m&4),left:!!(m&8),reset:!!(m&16)}));\nif(u[11]&2){fin=u[12]|u[13]<<8|u[14]<<16;f++;break}\nif(CS){const sp=new DataView(u.buffer,u.byteOffset,u.byteLength).getFloat32(7,true),k=(f-f0)%hist.length,old=hist[k];hist[k]=sp;if(f-f0>=hist.length&&old-sp>CS.drop&&old>CS.minV){crashed=true;f++;break}}\nif(GT&&!crossed&&a>=plan.length){const dv=new DataView(u.buffer);if((dv.getFloat32(14,true)-GT.p[0])*GT.d[0]+(dv.getFloat32(18,true)-GT.p[1])*GT.d[1]+(dv.getFloat32(22,true)-GT.p[2])*GT.d[2]>=0){crossed=true;fc=f+1}}\nif(smpAt?smpAt.has(f+1-f0):(se&&(f+1-f0)%se===0))smp.push(dec(u,f+1));\nif(minY>-1e8&&new DataView(u.buffer).getFloat32(18,true)<minY){dead=true;f++;break}}\nlet extra=0;\nif(e.airMax&&fin<0&&!dead&&!crashed&&((u[11]>>3)&15)===0){const am=e.airTail|0,settle=e.airSettle==null?100:e.airSettle;let landed=0;\nwhile(extra<e.airMax){const w=(u[11]>>3)&15;if(w>0){landed++;if(landed>settle)break}else landed=0;\nu=new Uint8Array(n(h,{up:!!(am&1),right:!!(am&2),down:!!(am&4),left:!!(am&8),reset:false}));f++;extra++;\nif(u[11]&2){fin=u[12]|u[13]<<8|u[14]<<16;break}\nif(minY>-1e8&&new DataView(u.buffer).getFloat32(18,true)<minY){dead=true;break}}}\nif(!e.fromCommit)t.ccall(\"deleteCarModel\",\"void\",[\"number\"],[id]);\nout.push({frames:f,fin:fin,dead:dead,crashed:crashed,last:dec(u,f),smp:smp,extra:extra,fc:crossed?fc:0})}\npostMessage({__vt:\"eval\",id:e.id,results:out})}(r);break;\n";
  const POTENTIAL = 'field';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => Promise.race([new Promise((r) => requestAnimationFrame(r)), sleep(30)]);

  // ================= 1. 物理 Worker 补丁(内存中,blob) =================
  let patchedUrl = null;
  function buildPatchedWorkerUrl(srcUrl) {
    if (patchedUrl) return patchedUrl;
    const abs = new URL(srcUrl, document.baseURI).href;
    const x = new XMLHttpRequest(); x.open('GET', abs, false); x.send();
    if (x.status !== 200) throw new Error('物理 Worker 脚本下载失败: HTTP ' + x.status);
    let src = x.responseText;
    const a1 = 'const Ko=class{constructor(t,e){Oo.add(this)', b1 = 'const uo=ho.filter(', a2 = 'case Ki.TestDeterminism:{';
    if (!src.includes(a1) || !src.includes(b1) || src.split(a2).length !== 2) throw new Error('游戏版本和补丁不匹配(只支持 0.6.3)');
    src = src.replace(a1, 'const Ko=self.__Ko=class{constructor(t,e){Oo.add(this)').replace(b1, 'self.__ho=ho;const uo=ho.filter(').replace(a2, EVAL_CASES + a2);
    // blob 里的相对路径(importScripts 物理模块、fetch / XHR 取 wasm)都要按原脚本所在目录解析
    const pre = `self.__PT_BASE=${JSON.stringify(GAME_BASE)};{const B=self.__PT_BASE,abs=(u)=>{try{return new URL(String(u),B).href}catch(e){return u}};`
      + `const __is=self.importScripts.bind(self);self.importScripts=(...u)=>__is(...u.map(abs));`
      + `const __f=self.fetch.bind(self);self.fetch=(i,o)=>__f(typeof i==='string'||i instanceof URL?abs(i):i,o);`
      + `const __xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return __xo.call(this,m,abs(u),...r)};}\n`;
    patchedUrl = URL.createObjectURL(new Blob([pre + WORKER_SHIM + '\n' + src], { type: 'application/javascript' }));
    return patchedUrl;
  }
  PT.mapUrl = (url) => (String(url).includes('simulation_worker') ? buildPatchedWorkerUrl(url) : url);

  // ================= 2. 时钟推进器(没开自动驾驶时,把真实时间喂给虚拟时钟) =================
  const S = { driving: false, solving: false, cancel: false, drive: null, guideOn: (() => { try { return localStorage.getItem('ptai:guide') !== '0'; } catch { return true; } })(), guideStart: null };
  const primaryIdx = () => { for (let i = PT.meta.length - 1; i >= 0; i--) { const m = PT.meta[i]; if (m.realtime === true && !m.ours && m.creates.length > 0) return i; } return -1; };
  {
    let last = performance.now(), acc = 0, pending = false;
    const loop = (now) => {
      requestAnimationFrame(loop);
      acc += Math.max(0, Math.min(100, now - last)); last = now; // 与游戏自己的 clamp(0.1 s) 一致
      if (S.driving) { acc = 0; return; }
      if (pending || acc < 1) return;
      const ms = acc, step = Math.min(ms, 1000 / 60); acc = 0;
      const idx = primaryIdx();
      PT.meta.forEach((m, i) => { if (i !== idx && !m.ours && m.init) PT.workers[i].postRaw({ __vt: 'advance', id: -1, ms, step }); }); // 其余游戏 Worker(幽灵等):发完即忘
      if (idx < 0) return;
      pending = true;
      Promise.race([PT.advance(idx, ms, step), sleep(250)]).finally(() => { pending = false; });
    };
    requestAnimationFrame(loop);
  }

  // ================= 3. 求解器用的"游戏"适配层 =================
  const makeG = (src) => ({
    trackInfo: () => new Promise((resolve) => { const id = PT.nextId++; PT.waiters.set(id, resolve); const m = PT.meta[src]; PT.workers[src].postRaw({ __vt: 'track', id, trackData: m.creates[m.creates.length - 1].trackData }); }),
    makePool: (n) => PT.makePool(src, n),
    evalBatch: (plans, opts) => PT.evalBatch(plans, opts),
    commit: (a, seg, segs, reset) => PT.commit(a, seg, segs, reset),
    verify: (rec, target, repeat) => PT.verify(src, rec, target, repeat),
  });

  // 回放串(与 pt_codec.mjs 同格式;浏览器里用 CompressionStream 做 zlib)
  async function encodeRecordingWeb(lists) {
    const parts = lists.map((list) => { const b = new Uint8Array(3 + 3 * list.length); b[0] = list.length & 255; b[1] = (list.length >> 8) & 255; b[2] = (list.length >> 16) & 255; list.forEach((f, k) => { const d = k === 0 ? f : f - list[k - 1]; b[3 + 3 * k] = d & 255; b[4 + 3 * k] = (d >> 8) & 255; b[5 + 3 * k] = (d >> 16) & 255; }); return b; });
    const raw = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { raw.set(p, o); o += p.length; }
    const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    let s = ''; for (let i = 0; i < z.length; i++) s += String.fromCharCode(z[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ================= 4. 缓存 =================
  function hashTrack(td) {
    let h = 2166136261 >>> 0; const n = td.length;
    if (typeof td === 'string') for (let i = 0; i < n; i++) h = Math.imul(h ^ td.charCodeAt(i), 16777619);
    else for (let i = 0; i < n; i++) h = Math.imul(h ^ td[i], 16777619);
    return (h >>> 0).toString(16) + '-' + n;
  }
  const cacheKey = (id) => 'ptai1:' + id;
  // 内置方案:随扩展一起发的"已验证回放"(只是按键翻转帧,不含任何游戏文件),按赛道指纹索引。由 scripts/bundle_plan.mjs 写入 extension/plans/bundled.json,构建时内联。
  const BUNDLED = {"53689afa-227":{"name":"slalom (自定义)","finishFrames":15604,"toggles":[[0,3280,3320,3920,3960,4040,4080,4480,4520,5640,5680,5920,5960,6160,6200,6760,6840,7720,7760,7840,7880,8080,8120,8640,8680,8760,8800,9320,9360,9600,9640,10000,10040,10400,10440,10600,10640,11400,11440],[80,120,320,400,2120,2160,2960,3080,3240,3280,3520,3560,3640,3720,3800,3920,4120,4160,4320,4360,4400,4480,4520,4680,4840,5000,5200,5240,5320,5400,5960,6000,6080,6120,6440,6480,6840,6920,6960,7040,7120,7160,7200,7480,7520,7560,7600,7680,7880,8000,8040,8080,8120,8200,8240,8280,8400,8480,8520,8560,8600,8640,9000,9040,9080,9120,9160,9200,9520,9560,9760,9800,9840,9920,9960,10000,10640,10760,10800,10920,10960,11040,11120,11200,11280,11400,11440,11480,11520,11560,11600,11680,11720,11800,11840,11960,12440,12520,13160,13200,13320,13440,13480,13560,13720,13815,13859,13920,14000,14040,14080,14120,14260,14360,14560,14660],[3280,3320,3920,3960,4040,4080,4480,4520,5640,5680,5920,5960,6160,6200,6760,6840,7720,7760,7840,7880,8080,8120,8640,8680,8760,8800,9320,9360,9600,9640,10000,10040,10400,10440,10600,10640,11400,11440],[40,80,200,240,440,480,1840,1880,2000,2040,2480,2520,2560,2600,2640,2680,2800,2840,3200,3240,3360,3480,3560,3600,3960,4000,4080,4120,4200,4240,4280,4320,4360,4400,4680,4720,5040,5080,5160,5200,5280,5320,5400,5520,5560,5640,5720,5880,6000,6080,6120,6160,6200,6360,6400,6440,6480,6600,6680,6760,7480,7520,7680,7720,7760,7840,8000,8040,8360,8400,8680,8760,8800,9000,9040,9080,9280,9320,9360,9400,9440,9520,9560,9600,9680,9760,9800,9840,9920,9960,10040,10280,10320,10400,10520,10600,11480,11520,11800,11840,11960,12000,12040,12080,12160,12280,12320,12360,12400,12440,12520,12600,12680,12920,12960,13000,13040,13160,13200,13320,13560,13640,13815,13859,13920,13960,14360,14460],[]],"recording":"eNrFU7ERwjAMlB3gKBggJRW4oMgC3DGCSjooUlBSULjMABSM4A1oGSElIzACJSWxFDsSGYCcT6e8pZf0StYQn-cCHMDeRosQ7c1Ee5xE-yakJVvZGHAuhkjG5yKXfc46mcEGQj50exHpnfOYRX9ZgE9hnI7p-FSIb3OtkE4r4ivRzC41gCKAGUrTO4y3VMVpfkcgCjyPIw9XaUe5je05vR4HdS2ZhSn-RT03tn_NDN2wB4ANwFY3dgWoqYfOrv6x00YolklwOiCPkW5eEHohNSOoxXR6cbtRDGqdw2h3QZfmsKf9_a6C2GlplCbS-dk1ap_tWzSWRS7NMLvTnTvNlhmkXJ7A7uqePgNebk3_8hf5vWTK","addedAt":"2026-11-11"},"8ede9706-1690":{"name":"Summer 1","finishFrames":26961,"toggles":[[0,3400,3440,6540,6580,6620,6660,6700,6780,9650,9690,9930,9970,10090,10170,10370,10450,10610,10640,10720,10760,10840,10880,10920,10960,11080,11120,11440,11480,11520,11560,11600,11640,11760,11840,12320,12360,12400,12440,12480,12560,12890,12930,13050,13090,13330,13370,13530,13570,14930,14970,15310,15390,15590,15630,15670,15710,15750,15870,16110,16150,16190,16270,16310,16350,16430,16470,16910,16950,17070,17110,19330,19370,20530,20570,20690,20770,20930,20970,21010,21090,21130,21170,21210,21290,21370,21410],[0,120,280,320,360,400,440,480,520,560,720,760,800,880,920,960,1280,1320,1440,1520,1600,1640,1680,1720,1880,1960,2120,2320,3120,3160,3680,3720,3800,3840,4120,4280,4320,4440,4480,4520,4720,4760,6660,6700,6820,6860,7620,7660,7820,7940,7980,8020,8580,8620,8940,8970,9290,9330,9490,9650,9690,9810,9850,9930,9970,10090,10250,10290,10490,10610,10640,10680,10880,10920,10960,11080,11120,11200,11240,11440,11480,11520,11560,11600,11640,11680,11840,12200,12240,12320,12360,12400,12440,12480,12560,12650,12730,12810,12850,12890,12930,12970,13010,13050,13130,13330,13370,13530,13570,13650,13690,13930,13970,14010,14050,14290,14330,14450,14490,14610,14650,14810,14890,14930,14970,15010,15050,15130,15170,15210,15270,15310,15390,15430,15470,15510,15710,15750,15990,16070,16150,16190,16270,16310,16350,16390,16470,16750,16790,16910,16950,17070,17110,17150,17190,17750,17830,17930,18010,18050,18210,18530,18570,18690,19370,19490,20450,20490,20770,20810,20890,20930,21090,21130,21410,21490,21810,21890,21930,22010,22050,22130,22210,22290,22330,22370,22410,22530,22570,22650,22690,22730,22850,22930,23050,23090,23410,23490,23680,23760,23800,23840,23920,24040,24080,24280,24320,24400,24440,24480,24520,24560,24586,24599,24600,24800,24840,24880,25000,25080,25120,25240,25281,25285,25400,25480,25520,25573,25577,25645,25820,26020,26110,26600],[3400,3440,6540,6580,6620,6660,6700,6780,9650,9690,9930,9970,10090,10170,10370,10450,10610,10640,10720,10760,10840,10880,10920,10960,11080,11120,11440,11480,11520,11560,11600,11640,11760,11840,12320,12360,12400,12440,12480,12560,12890,12930,13050,13090,13330,13370,13530,13570,14930,14970,15310,15390,15590,15630,15670,15710,15750,15870,16110,16150,16190,16270,16310,16350,16430,16470,16910,16950,17070,17110,19330,19370,20530,20570,20690,20770,20930,20970,21010,21090,21130,21170,21210,21290,21370,21410],[200,240,880,920,1240,1280,1360,1440,1520,1560,1800,1840,2080,2120,2360,2480,2520,2560,2640,2760,2800,2840,2880,2920,3000,3040,3280,3360,3440,3480,3560,3680,4080,4120,4440,4480,4520,4600,6580,6620,6780,6820,7140,7180,7660,7780,8100,8140,8180,8260,8300,8380,8460,8580,8620,8660,8820,8940,9130,9290,9330,9410,9450,9490,9810,9850,10210,10250,10680,10720,11680,11720,12200,12240,12810,12850,13090,13130,13650,13690,13930,13970,14010,14050,14450,14490,14610,14650,15010,15050,15630,15670,16070,16110,16750,16790,17930,17970,18530,18570,18690,18810,19170,19290,19970,20010,20290,20450,20490,20530,20570,20650,20810,20850,21330,21370,22010,22050,22730,22770,22970,23050,23170,23250,23490,23530,24280,24320,24400,24440,24560,24586,24599,24600,24800,24840,24880,24920,25240,25280,25320,25360],[]],"recording":"eNrtVK1OBDEQnvaW3CZwnhByQS4OA4IgTpwgqAoCyWnECRyISiSK3CNUIghYBCHIfYzTJ8hKJO3Mtp22yxuwaSbT2a_fdP56De47n0ADsL_jZFgK4GTbKR1uNVpalAZgikrjZeMxVs5EwhPOrkXOfyHiKfJi6NeWk5ei95hRdYyBK--M7aV28rGK3k1xinTabjAPmsGyVR6fiUiuUiS5szc_GDlLLePBXdFTaY-nAG_H0fgje56AOZK9x6n3ayDhUV43nlNjjRqWQI5s_4hxKfIU0XZRhMn_trx2rJoNJP0TpBlyQcpZUaPWk6ihllOY0ow_JM3-vfF4w0r2LJ38GvUVaRiGLArB3J0qMqDTy1AnhBGw-mfaopqFk4W_BzABEGmxQk0PASqAO285xu0c4A3xtjQbAVf_Uwzw5B09yBgCL1yXSl1UJ2vIrOssZiWS5FjjxziGTHabIp1iwjU0mzWNHWKGXhUaw1eU1KWU9lMZ71_LfNBWLHXEMJfRTjm5r-J7onEtRT8R_HUKN6ftmjEQsvXhKH-Hb5k8RGVLZ01lv19VWKss","addedAt":"2026-11-11"},"95a8a6cc-3151":{"name":"Summer 3","finishFrames":24858,"toggles":[[0,3360,3400,3440,3480,4200,4240,4960,5000,5080,5160,5280,5360,5720,5800,5960,6000,6440,6480,7320,7360,8440,8480,8800,8840,9040,9080,9200,9240,9280,9320,9400,9440,9680,9720,10200,10240,10600,10640,11520,11600,11640,11680,12240,12280,12440,12480,13000,13040,14360,14560,15520,15600,18640,18680,21200,21240,21720,21760,24600,24840],[80,160,200,240,280,320,720,760,1440,1480,2480,2520,2640,2680,2840,2880,2960,3000,3400,3440,3560,3640,3680,3760,3840,3920,4000,4040,4080,4120,4240,4320,4440,4480,4640,4680,5520,5600,5800,5840,5880,5920,6360,6400,7280,7320,7520,7560,8080,8240,8280,8360,9160,9200,9240,9280,9480,9520,9720,9840,9960,10040,10120,10200,10720,10760,10880,10960,11080,11120,11360,11400,11720,11760,12320,12360,12400,12440,12480,12560,12640,12800,12840,13000,13040,13080,13120,13240,13280,13360,13400,13440,13520,13600,13680,13720,14120,14200,15600,15640,16040,16080,16440,16520,16800,16880,17960,18000,18280,18360,18400,18440,18680,18800,18880,19040,19160,19200,19440,19480,19520,19560,19640,19680,20040,20080,21120,21160,21320,21360,21520,21640,21680,21720,21760,22080,22160,22200,22240,22280,22320,22440,22480,22560,22600,22640,22680,22760,22800,22840,22920,22960,23040,23080,23160,23200,23280,23360,23400,23440,23480,23520,23720,23820,23920,24020,24360,24600],[3360,3400,3440,3480,4200,4240,4960,5000,5080,5160,5280,5360,5720,5800,5960,6000,6440,6480,7320,7360,8440,8480,8800,8840,9040,9080,9200,9240,9280,9320,9400,9440,9680,9720,10200,10240,10600,10640,11520,11600,11640,11680,12240,12280,12440,12480,13000,13040,14360,14560,15520,15600,18640,18680,21200,21240,21720,21760,24600,24840],[0,40,240,280,760,800,920,960,1240,1320,1920,1960,2040,2120,2160,2200,2400,2480,2520,2560,2600,2640,3040,3120,3160,3240,3320,3360,3800,3840,4320,4360,4600,4640,4680,4720,4800,4840,4880,4920,5000,5080,5160,5280,5400,5520,5680,5720,5840,5880,6000,6040,6120,6160,6200,6360,6400,6440,6480,6600,6640,6760,6800,6840,7000,7280,7400,7520,7560,7640,7680,7720,7840,8000,8040,8080,8360,8400,8480,8520,8640,8720,9080,9120,9600,9680,9840,9880,10080,10120,10960,11000,11040,11080,11200,11240,11320,11360,11440,11520,11680,11720,11760,11800,11840,11880,12000,12120,12160,12200,12360,12400,12560,12600,12800,12840,13440,13520,13800,13920,13960,14120,15840,15960,16080,16160,16240,16320,16360,16440,16520,16600,16640,16800,16960,17000,17080,17120,17200,17280,17320,17400,17440,17520,17760,17840,18040,18120,18160,18280,18360,18400,18600,18640,19040,19120,19240,19320,19600,19640,19680,19720,19840,19960,20080,20120,20200,20240,20440,20480,20640,20720,21000,21040,21080,21120,21240,21280,21480,21520,21640,21680,22080,22120,22200,22240,22280,22320,22760,22800,23440,23480,23520,23620,24120,24360],[]],"recording":"eNrVVKFywzAMtZt2111vd4OBhYGDA9tdYaHBwD5goHBQcJ-QTzDsJwQODBgWDgYOBuwDZkuRrcj9geV079Jalp70pDyb9OzvTGdmu6wKOjRAPNmEHn0Gm_DYJHxcJzzgPwFPwZRoDnFCHNHnhPjezEfRHjAXRd7ie7dJoT7RZ9ylf75vS4R2lwKemV4nrEeHMwb5aQoZL8iQD_BPJyzHAS483z0imSB8Bi4kFx7J50T7pngGRuDIZFSszEWNomZSW2Qnc__9kmonyMtaepQMNqVqErFFJOHovePswFkkHyklyXe_LjT8UvGD1aIohoptjep67Nsb24tNlJ7-58R-4a7lpKMtqUmF15XuQLg24apRVBpFm641WU4FsHlRuBKoni4QR5EqVFdA3GptOcpCEMMsRzBFjnpI5KirQYIlSRktds8xPToabvTGqQXxyy-Dq0ZxMvPWy3Jyxnm_zJxX8ZQVBU5Xe6oh7K3WjvT94K9B3IJf3IL4_AEQGKAa","addedAt":"2026-11-15"},"68b0e957-3050":{"name":"Summer 6","finishFrames":47655,"toggles":[[0,5340,5700,8760,9000,9180,9360,14100,14220,14940,15300,16860,17040,18480,18660,18720,18780,24300,24600,24720,25020,26700,26820,27120,27180,27360,27660,30840,31140,31740,31860,32160,32340,34140,34200,41880,41940,42180,42240,44040,44100,44260,44396],[2220,2580,4020,4380,4560,5340,5880,6180,12840,13080,15900,16020,17040,17940,18120,18480,18660,18720,20160,20340,22320,22860,25020,25560,30060,30120,31140,31560,33960,34140,35760,35940,36300,36960,37920,38640,41760,41880,41940,42180,42360,42540,43080,43140,43740,43839,43847,44040,44100,44260,44396,44400,45672,45725,46380,46860],[5340,5700,8760,9000,9180,9360,14100,14220,14940,15300,16860,17040,18480,18660,18720,18780,24300,24600,24720,25020,26700,26820,27120,27180,27360,27660,30840,31140,31740,31860,32160,32340,34140,34200,41880,41940,42180,42240,44040,44100,44260,44396],[660,720,2640,3000,4380,4560,5700,5760,6180,6960,7200,7260,7620,7860,8100,8760,9000,9180,9360,9600,10320,11220,11640,12540,13080,13860,14220,14940,15300,15660,18900,19020,19080,19260,19500,19680,20640,22140,22860,23460,23760,24300,25560,25740,27180,27360,28500,28980,29160,29400,29460,30060,30120,30300,30540,30840,31560,31740,32340,33960,34200,35760,35940,36300,36960,37920,38640,38880,39540,39720,41640,41760,43320,43740,45000,45540,45660,45672,45725,45900,47174,47273,47400,47580],[]],"recording":"eNrFUSFOA0EUfTs73V3SNRBIGtJwAKjAkCD2GBWVTUBUIBCIOhArcFT0ABUIBAlmJQJuwAEqegDECgRpELz3Z7cVHIDJ5Gfmzfv_v__mBFrLfUwifHVRA5Xtcg9T4MMJ7yVCFh3FwvbsAINIBMZZ0hwKS-ThKlccuQYnmKV6xZFibRUCsgDugXPgOVMjtpgYP4_Rd8r1h-L7rkr9xChjvQZO0Up6TUW-zhTnu8LJfIww3tHrMGlS5g5vsSY6zVUtKAnDMpFXCr6gMOAdW20e-PY4Ax4cVhGO_9urITQIr3ep2l1aoxsvhCPTt5DCp9rSSd7orE1kaeaU5jD5ZAbl3E-tM1VrDh1bdkQY2Xcw5dNvB2TfVdSQg4Gb3IGVrQzkFxDp_fmIIK-yWaZGoDDW75sbOWT7C7D2-pdbq8z1C1v7cf8","addedAt":"2026-11-15"},"34211fb8-1808":{"name":"Winter 1","finishFrames":19547,"toggles":[[0,4800,4840,5200,5240,5760,5800,6760,6800,6880,6920,7040,7080,7680,7720,7920,7960,8200,8360,8520,8600,8880,8920,9120,9160,11320,11360,11640,11680,11760,11800,11920,11960,12120,12160,12240,12280,12760,12800,14040,14080,14160,14200,14280,14289,14520,14560,15164,15195],[80,120,280,320,440,480,520,560,640,720,800,880,1400,1440,1560,1640,2200,2240,3600,3640,3920,3960,4240,4320,4440,4520,4560,4600,4760,4800,4840,5000,5160,5200,5240,5320,5360,5400,5440,5600,5640,5760,5880,5920,6160,6200,6440,6480,6560,6680,6720,6760,7000,7040,7200,7280,7440,7640,7720,7800,7840,7920,8000,8200,8360,8520,8680,8760,8800,8880,8920,9120,9160,9320,9360,9720,9760,9800,9840,9880,10040,10200,10240,10440,10520,10600,10920,10960,11000,11040,11200,11240,11440,11480,11560,11600,11800,11840,11880,11920,11960,12120,12160,12240,12280,12360,12400,12560,12600,12760,12800,12880,12920,12960,13000,13040,13080,13800,13840,13920,13960,14040,14200,14280,14289,14332,14400,14480,14560,14600,14612,14629,14640,15040,15080,15164,15195,15480,15560,16038,16065,16240,16280,16400,16440,16600,16680,16760,16800,16920,16975,17000,17040,17120,17240,17280,17320,17360,17640,17674,18080,18160,18200,18240],[4800,4840,5200,5240,5760,5800,6760,6800,6880,6920,7040,7080,7680,7720,7920,7960,8200,8360,8520,8600,8880,8920,9120,9160,11320,11360,11640,11680,11760,11800,11920,11960,12120,12160,12240,12280,12760,12800,14040,14080,14160,14200,14280,14289,14520,14560,15164,15195],[0,80,120,240,1080,1200,1760,1800,2080,2120,2280,2320,2960,3000,3640,3680,3800,3840,3880,3920,4080,4120,4160,4200,4400,4440,4600,4640,5120,5160,5400,5440,5600,5640,5800,5880,5960,6160,6240,6360,6480,6560,6960,7000,7080,7200,7280,7360,7800,7840,7960,8000,9320,9360,11240,11280,11520,11560,11840,11880,12960,13000,13800,13840,14332,14360,14480,14520,14600,14612,14629,14640,15480,15535,16038,16065,16240,16280,16760,16800,16920,16975,17400,17440,17836,17871,17955,17985],[]],"recording":"eNrNU6FSA0EMfXulQztgqIIBCgNmZzBFgUQgKlcgTvQDKpEn-QAECr0Cg8IiK08iUUwdBnEOy24y2c11f4BO5k0mmyYveblLxN9qAgssTcRRFXE1iOgQsSGsKd6S3wGeLCTsmxy_H0XkiP6vR46s6fVzK0cCjoFv8hcVToAXefKqiJXkZEy1IX9GvhtmAgGdvFpVzQp5q1jZfrtGxkzoFI1Okh1hK3wSvVZaeBVPW-IuvG1bUErVbswmsbYotZGge_kiru2j6uV7UeECuFXj7AJ7wA7wRGTuENU5psV-GRwCb32VndL9CjgoVse6nAHPJrOa_b8LrOm7SBXmg4h8Y1ycCz5UGZtCDluIzq27vkDpZpzcnpOFpwMO9m5UF7rzejtXY1bXNNQpre7H4EjynZIyzBKk-VXyrU2W7JX8R4NzkntKe_gD5v5zKA","addedAt":"2026-11-15"}};
  const loadLocal = (id) => { try { return JSON.parse(localStorage.getItem(cacheKey(id)) || 'null'); } catch { return null; } };
  /** 本地缓存与内置方案里取更快的那个(都要求已通过 Verify;没有 verified 标记的本地方案也保留,但排在内置之后) */
  const loadPlan = (id) => {
    const loc = loadLocal(id); const b = BUNDLED[id] ? { ...BUNDLED[id], verified: true, bundled: true } : null;
    if (loc && b) return loc.verified && loc.finishFrames < b.finishFrames ? loc : b;
    return b ?? loc;
  };
  const savePlan = (id, p) => { try { localStorage.setItem(cacheKey(id), JSON.stringify(p)); } catch { /* 无痕等场景下存不了:本次仍可用 */ } };
  const clearPlan = (id) => { try { localStorage.removeItem(cacheKey(id)); } catch { /* ignore */ } };

  const curTrackId = () => { const i = primaryIdx(); if (i < 0) return null; const m = PT.meta[i]; return hashTrack(m.creates[m.creates.length - 1].trackData); };

  // ================= 5. 求解 =================
  async function solve(ui, { polishSeconds = 30 } = {}) {
    const src = primaryIdx(); if (src < 0) throw new Error('游戏还没准备好(先选好赛道、看到起点画面)');
    const id = curTrackId(); const g = makeG(src); const t0 = Date.now();
    const workers = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 2));
    S.solving = true; S.cancel = false;
    try {
      const solver = new SOLVER.Solver(g, { workers, potential: POTENTIAL, seed: 1, commitN: 6, pop: 96, iters: 3, segs: [...Array(6).fill(40), ...Array(6).fill(100), ...Array(4).fill(240)], log: (m) => ui.log(m), cancel: () => S.cancel, stallRetries: 2, stallTotalMax: 2, slowSegs: null }); // 页面里求解:规划停滞最多重试 2 次,还不行就改用探索式规划(下面),别让人干等
      ui.status(`求解中:建立赛道势能,启动 ${workers} 个评估线程…`);
      await solver.init();
      ui.status('求解中:阶段 A 滚动时域规划(几分钟,期间游戏画面会卡一些)');
      let A; // 先用滚动时域规划(圈速更好);它停滞 / 失败(新赛道里的墙、环、长跳常见)就改用 Go-Explore 式探索找一条能冲线的路线,后面照样打磨 + Verify
      try { A = await solver.plan(); } catch (e) {
        if (S.cancel || /已取消/.test(e.message)) throw e;
        ui.log('规划失败:' + e.message.slice(0, 80) + ' → 改用探索式规划'); ui.status('求解中:规划失败,改用探索式规划(最多 10 分钟)');
        A = await SOLVER.exploreLap(solver, { seconds: 600, log: (m) => ui.log(m) });
      }
      let masks = A.masks, fin = await solver.finishOf(A.masks);
      ui.log(`规划完成: ${fin} 帧 (${(fin / 1000).toFixed(3)} s)`);
      if (polishSeconds > 0 && !S.cancel) {
        ui.status(`求解中:阶段 B 打磨 ${polishSeconds} s`);
        const P = await solver.polish(masks, fin, { seconds: polishSeconds });
        masks = P.masks; fin = P.finishFrames; ui.log(`打磨完成: ${fin} 帧 (${(fin / 1000).toFixed(3)} s)`);
      }
      const toggles = SOLVER.masksToToggles(masks);
      const recording = await encodeRecordingWeb(toggles);
      ui.status('求解中:用游戏自带 Verify 复核…');
      const v = await g.verify(recording, fin, 1); const vm = await g.verify(recording, fin - 1, 1);
      const verified = v[0].result === true && vm[0].result === false;
      const plan = { v: 1, finishFrames: fin, toggles, recording, verified, solvedAt: Date.now(), solveSeconds: Math.round((Date.now() - t0) / 1000) };
      savePlan(id, plan);
      ui.log(`Verify ${verified ? '通过' : '未通过'}(完成帧 ${v[0].result}, 少 1 帧 ${vm[0].result})`);
      return plan;
    } finally {
      for (const p of PT.pool) p.w.terminate(); PT.pool = []; S.solving = false;
    }
  }

  // ================= 6. 自动驾驶 =================
  // 引导线用的"前方轨迹":方案是确定性的,在评估引擎里整圈跑一遍(每 GUIDE_STEP 帧采一个状态)就知道车接下来会走哪;按方案缓存在内存里
  const guideCache = new Map();
  async function prepareGuide(plan) {
    const key = plan.recording || (plan.finishFrames + ':' + JSON.stringify(plan.toggles).length);
    if (guideCache.has(key)) return guideCache.get(key);
    const src = primaryIdx(); if (src < 0) throw new Error('游戏还没准备好');
    const g = makeG(src); await g.makePool(1);
    try {
      const masks = SOLVER.togglesToMasks(plan.toggles, plan.finishFrames + 60);
      const [r] = await g.evalBatch([Array.from(masks)], { seg: 1, tail: 1, maxFrames: masks.length + 200, sampleEvery: GUIDE.GUIDE_STEP });
      const pts = r.smp.slice(); if (r.last && (!pts.length || pts[pts.length - 1][0] < r.last[0])) pts.push(r.last);
      const path = GUIDE.buildGuidePath(pts, masks); guideCache.set(key, path); return path;
    } finally { for (const p of PT.pool) p.w.terminate(); PT.pool = []; }
  }
  const KEYMAP = { up: ['KeyW', 'w'], right: ['KeyD', 'd'], down: ['KeyS', 's'], left: ['KeyA', 'a'], reset: ['KeyR', 'r'] };
  // 注入的按键带 __ptai 标记:自动驾驶期间的输入锁靠它区分"自己发的"和"玩家按的"
  const fireKey = (type, code, key) => { const ev = new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true }); ev.__ptai = true; window.dispatchEvent(ev); };
  // 方案里某一帧按住了哪些键(位掩码:1 W、2 D、4 S、8 A、16 R,与物理侧 ctl 同编码)。toggles[ki] 是翻转帧列表:偶数下标按下,奇数下标松开
  const plannedMask = (toggles, f) => { let m = 0; for (let ki = 0; ki < 5; ki++) { const t = toggles[ki] || []; let n = 0; while (n < t.length && t[n] <= f) n++; if (n & 1) m |= 1 << ki; } return m; };
  async function drive(plan, ui) {
    const ctl = (S.drive = { stop: false }); S.driving = true;
    const held = new Set();
    const press = (k, down) => { const [code, key] = KEYMAP[k]; if (down) held.add(k); else held.delete(k); fireKey(down ? 'keydown' : 'keyup', code, key); };
    const releaseAll = () => { for (const k of [...held]) press(k, false); };
    try {
      // 玩家可能正按住某个键:先全松一次,清掉游戏侧残留的"按下"状态,免得锁了输入后卡在按下
      for (const k of Object.keys(KEYMAP)) press(k, false);
      let w = primaryIdx(); if (w < 0) throw new Error('游戏还没准备好');
      const guideFor = async () => { try { return await prepareGuide(plan); } catch (e) { ui.log('引导线不可用:' + String(e.message).slice(0, 80)); return null; } };
      let guidePath = null;
      if (S.guideOn && GUIDE && GUIDEUI) { ui.status('自动驾驶:生成引导线…'); guidePath = await guideFor(); w = primaryIdx(); }
      let p0 = PT.peek(w);
      if (p0 && (p0.started || p0.frames > 0)) { // 已经开过:T = 回到起点重来(新建一辆车)
        const n0 = PT.meta[w].creates.length;
        fireKey('keydown', 'KeyT', 't'); await sleep(40); fireKey('keyup', 'KeyT', 't');
        for (let t = 0; t < 80 && PT.meta[w].creates.length === n0; t++) await sleep(50);
        if (PT.meta[w].creates.length === n0) throw new Error('没能回到起点;请先手动按 T 重来,再点自动驾驶');
        w = primaryIdx();
      }
      const evs = [];
      Object.keys(KEYMAP).forEach((k, ki) => (plan.toggles[ki] || []).forEach((f, j) => evs.push({ f, k, down: j % 2 === 0 })));
      evs.sort((a, b) => a.f - b.f);
      const frames = () => PT.peek(w)?.frames ?? 0;
      let i = 0;
      const flush = (F) => { while (i < evs.length && evs[i].f <= F) { press(evs[i].k, evs[i].down); i++; } };
      flush(0);
      for (let t = 0; t < 400; t++) { // 第一次按键后,主线程的 rAF 循环才会发 StartCar;边等边把虚拟时间推 1 ms
        await sleep(10); await PT.advance(w, 1, 1);
        if (PT.peek(w)?.started) break;
      }
      if (!PT.peek(w)?.started) throw new Error('车没有起步(游戏没有响应键盘事件)');
      const guideFrames = () => PT.peek(w)?.frames ?? null;
      if (guidePath) GUIDEUI.start(guidePath, guideFrames);
      S.guideStart = async () => { guidePath ??= await guideFor(); if (guidePath) GUIDEUI.start(guidePath, guideFrames); }; // 驾驶途中才打开"引导线"开关时用
      const t0 = performance.now() - frames(); const endFrame = plan.finishFrames + 1500; let lastUi = 0;
      for (;;) {
        if (ctl.stop) { ui.log('已停止:交还给你'); break; }
        const p = PT.peek(w);
        if (p && p.fin !== null) { ui.log(`冲线!游戏计时 ${(p.fin / 1000).toFixed(3)} s`); return { finished: p.fin }; }
        const f = frames();
        ui.keys(plan.toggles, f, p?.ctl ?? 0); // 按键显示:键帽 = 物理侧实际收到的按键,时间轴 = 方案(过去 2 s / 未来 1 s)
        if (S.debugKeys) (S.keyLog ??= []).push([f, p?.ctl ?? 0, plannedMask(plan.toggles, f)]);
        if (f > endFrame) { ui.log('超过预期完成帧仍未冲线,已停止'); break; }
        flush(f);
        const nf = i < evs.length ? evs[i].f : Infinity;
        if (nf - f <= 3) { await PT.advance(w, 1, 1); continue; } // 精确落到事件帧(最多几步,不等实时)
        const want = Math.floor(Math.min(performance.now() - t0, nf - 3, f + 100) - f);
        if (want < 1) { await nextFrame(); continue; }
        await PT.advance(w, want, 1000 / 60);
        const now = performance.now(); if (now - lastUi > 120) { lastUi = now; ui.drive(frames(), plan.finishFrames); }
      }
      return { finished: null };
    } finally { releaseAll(); S.driving = false; S.drive = null; S.guideStart = null; ui.keys(null); if (GUIDEUI) GUIDEUI.stop(); }
  }

  // ================= 7. 面板 =================
  function makePanel() {
    const host = document.createElement('div'); host.id = 'ptai-panel';
    host.style.cssText = 'position:fixed;top:64px;right:12px;z-index:2147483647;all:initial;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial}
      .box{position:fixed;top:64px;right:12px;width:268px;box-sizing:border-box;padding:10px 12px;border-radius:10px;background:rgba(14,20,40,.86);color:#e8ecff;font:12px/1.45 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45);user-select:none;pointer-events:auto}
      .t{display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:13px;margin-bottom:6px}
      .t small{font-weight:400;opacity:.6}
      button{all:unset;box-sizing:border-box;display:block;width:100%;text-align:center;cursor:pointer;border-radius:8px;padding:8px 0;font-weight:600;font-size:14px;background:#3b82f6;color:#fff}
      button:hover{filter:brightness(1.1)} button.stop{background:#ef4444} button.busy{background:#6b7280}
      .row button.off{background:#1a2040;color:#7f89bd}
      .row{display:flex;gap:6px;margin-top:6px} .row button{font-size:11px;font-weight:500;padding:4px 0;background:#2a3358}
      .st{margin:6px 0 2px;min-height:17px;color:#ffe08a} .bar{height:4px;border-radius:2px;background:#2a3358;overflow:hidden;margin:4px 0}
      .bar i{display:block;height:100%;width:0;background:#34d399}
      .log{max-height:84px;overflow:auto;font-size:11px;opacity:.78;white-space:pre-wrap;word-break:break-all}
      .ft{margin-top:6px;font-size:10px;opacity:.55;white-space:pre-line}
      .hk{margin-top:4px;font-size:10px;opacity:.72;color:#9fb4ff}
      .keys{display:none;margin:6px 0 2px} .keys.on{display:block}
      .kr{display:flex;align-items:center;gap:10px}
      .kb{display:grid;grid-template-columns:repeat(3,26px);grid-template-rows:repeat(2,24px);gap:3px;flex:none}
      .k{box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:5px;background:#2a3358;color:#7f89bd;border:1px solid #3a4572;font-weight:700;font-size:12px;transition:background .05s}
      .k.on{background:#34d399;color:#06281c;border-color:#6ee7b7;box-shadow:0 0 8px rgba(52,211,153,.75)}
      .k.r{grid-column:3;grid-row:1;font-size:10px} .k.r.off{visibility:hidden}
      .kt{font-size:13px;font-weight:600;color:#bff3df;min-height:18px}
      #tl{display:block;width:100%;height:50px;margin-top:5px;border-radius:5px;background:#10162e}
    </style>
    <div class="box"><div class="t"><span>PolyTrack AI</span><small id="ver">0.6.3 · 本地研究用</small></div>
      <button id="go" tabindex="-1">▶ 一键自动驾驶</button>
      <div class="st" id="st">待命</div><div class="bar"><i id="bar"></i></div>
      <div class="keys" id="keys"><div class="kr"><div class="kb"><b class="k r off" id="k_reset">R</b><b class="k" id="k_up" style="grid-column:2;grid-row:1">W</b><b class="k" id="k_left" style="grid-column:1;grid-row:2">A</b><b class="k" id="k_down" style="grid-column:2;grid-row:2">S</b><b class="k" id="k_right" style="grid-column:3;grid-row:2">D</b></div><div class="kt" id="kt">&nbsp;</div></div>
        <canvas id="tl" width="244" height="50"></canvas></div>
      <div class="row"><button id="gd" tabindex="-1">引导线:开</button></div>
      <div class="row"><button id="clr" tabindex="-1">清除本赛道缓存</button><button id="cp" tabindex="-1">复制回放串</button></div>
      <div class="log" id="log"></div>
      <div class="hk" id="hk"></div>
      <div class="ft" id="ft">成绩是否上传由游戏结算界面决定,扩展不介入网络请求。</div></div>`;
    document.documentElement.appendChild(host);
    const $ = (id) => root.getElementById(id);
    for (const b of root.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢键盘焦点(否则 Enter / 空格会触发按钮)
    const lines = [];
    const ui = {
      status: (t) => { $('st').textContent = t; },
      log: (t) => { lines.push(t); if (lines.length > 40) lines.shift(); $('log').textContent = lines.slice(-6).join('\n'); $('log').scrollTop = 1e9; },
      drive: (f, total) => { $('bar').style.width = Math.min(100, (100 * f) / total) + '%'; $('st').textContent = `自动驾驶中 ${(f / 1000).toFixed(2)} s / ${(total / 1000).toFixed(2)} s`; },
      busy: (mode) => { const b = $('go'); b.className = mode === 'idle' ? '' : mode === 'solve' ? 'busy' : 'stop'; b.textContent = mode === 'idle' ? '▶ 一键自动驾驶' : mode === 'solve' ? '■ 取消求解' : '■ 停止(交还给我)'; },
      foot: () => { $('ft').textContent = '成绩是否上传由游戏结算界面决定,扩展不介入网络请求。'; },
      bar: (p) => { $('bar').style.width = p + '%'; },
      hint: (t) => { $('hk').textContent = t; },
      setPanel: (on) => { host.style.display = on ? '' : 'none'; },
      panelVisible: () => host.style.display !== 'none',
      /** 自动驾驶时的按键显示。keys(toggles, 当前帧, 物理侧按键位) 更新状态;keys(null) 隐藏。真正的绘制放在 rAF 里(每帧最多一次) */
      keys: (toggles, f, mask) => { ks = toggles ? { toggles, f, mask, drawn: false } : null; if (!toggles) { $('keys').classList.remove('on'); $('tl').getContext('2d').clearRect(0, 0, 1e4, 1e4); } },
      root, $, host,
    };
    // ---- 按键显示的绘制 ----
    let ks = null;
    const CAPS = [['k_up', 0], ['k_right', 1], ['k_down', 2], ['k_left', 3], ['k_reset', 4]];
    const NAMES = ['油门', '右转', '刹车', '左转', '重置'];
    const ROWS = [['W', 0], ['A', 3], ['S', 2], ['D', 1]]; // 时间轴从上到下
    const PAST = 2000, FUT = 1000; // 毫秒;1 帧 = 1 ms
    const drawKeys = ({ toggles, f, mask }) => {
      $('keys').classList.add('on');
      for (const [id, bit] of CAPS) $(id).classList.toggle('on', ((mask >> bit) & 1) === 1);
      $('k_reset').classList.toggle('off', !(toggles[4] || []).length && !(mask & 16));
      $('kt').textContent = [0, 2, 1, 3, 4].filter((b) => (mask >> b) & 1).map((b) => NAMES[b]).join(' + ') || '松开';
      const cv = $('tl'), dpr = Math.min(3, window.devicePixelRatio || 1), W = 244, H = 50;
      if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
      const x0 = 14, pw = W - x0 - 2, rh = H / ROWS.length, t0 = f - PAST, xf = (t) => x0 + ((t - t0) / (PAST + FUT)) * pw;
      c.font = '9px -apple-system,sans-serif'; c.textBaseline = 'middle';
      ROWS.forEach(([label, ki], r) => {
        const y = r * rh;
        if (r % 2) { c.fillStyle = 'rgba(255,255,255,.04)'; c.fillRect(0, y, W, rh); }
        c.fillStyle = '#7f89bd'; c.fillText(label, 3, y + rh / 2);
        const t = toggles[ki] || [];
        for (let j = 0; j < t.length; j += 2) {
          const a = t[j], b = j + 1 < t.length ? t[j + 1] : Infinity; // 最后一次按下没有松开 = 按到结束
          if (b < t0 || a > f + FUT) continue;
          const xa = Math.max(x0, xf(a)), xb = Math.min(x0 + pw, xf(b));
          c.fillStyle = a <= f && b > f ? '#34d399' : b <= f ? '#3b6f8f' : '#93c5fd'; // 正在按 / 已按过 / 将要按
          c.fillRect(xa, y + 2, Math.max(1.5, xb - xa), rh - 4);
        }
      });
      const xn = xf(f); c.fillStyle = '#ffe08a'; c.fillRect(xn - 0.5, 0, 1, H);
    };
    const tick = () => { requestAnimationFrame(tick); if (ks && !ks.drawn) { ks.drawn = true; drawKeys(ks); } };
    requestAnimationFrame(tick);
    return ui;
  }

  // ================= 8. 快捷键与输入锁 =================
  // 自动驾驶:反引号 ` (Backquote)——Mac 笔记本上 F8 是媒体键,要 fn+F8 才发得出去,所以主键用不需要 fn 的。
  // 面板显隐:反斜杠 \ (Backslash)。F8 / F9 作为别名保留,两种都能用。
  // 自动驾驶期间锁死移动键(捕获阶段吞掉玩家的按键),只有面板上的「停止」/快捷键能把控制权拿回去。
  const HOTKEYS = (() => {
    const def = { drive: ['Backquote', 'F8'], panel: ['Backslash', 'F9'] };
    try {
      const u = JSON.parse(localStorage.getItem('ptai:hotkeys') || 'null');
      if (!u || typeof u !== 'object') return def;
      const norm = (v, d) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : typeof v === 'string' && v ? [v] : d);
      return { drive: norm(u.drive, def.drive), panel: norm(u.panel, def.panel) };
    } catch { return def; }
  })();
  const isHot = (e, k) => HOTKEYS[k].includes(e.code);
  // 游戏里能改变车行为的键:WASD、方向键、R(重生)、T(回到起点)
  const LOCK_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyT', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  function installInputLock() {
    const onKey = (e) => {
      if (e.__ptai || !S.driving) return; // 自己注入的按键、以及没在自动驾驶时:完全放行
      if (isHot(e, 'drive') || isHot(e, 'panel')) return; // 快捷键始终可用
      if (!LOCK_CODES.has(e.code)) return;
      e.preventDefault(); e.stopImmediatePropagation(); // 捕获阶段吞掉,游戏侧收不到,玩家按键不影响自动驾驶
    };
    for (const t of ['keydown', 'keyup', 'keypress']) window.addEventListener(t, onKey, true);
  }

  function installHotkeys(ui, onToggle) {
    window.addEventListener('keydown', (e) => {
      if (e.__ptai || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isHot(e, 'drive')) { e.preventDefault(); e.stopImmediatePropagation(); onToggle(); return; }
      if (isHot(e, 'panel')) { e.preventDefault(); e.stopImmediatePropagation(); ui.setPanel(!ui.panelVisible()); }
    }, true);
  }

  function boot() {
    const ui = makePanel(); let running = false; let sticky = null; // sticky:最近一次结果,留在面板上直到再次点击或换赛道
    const refresh = () => {
      ui.foot();
      if (running) return;
      const id = curTrackId();
      if (!id) { ui.status('等待游戏就绪:请先选好赛道,看到起点画面'); return; }
      if (sticky && sticky.id === id) { ui.status(sticky.text); return; }
      const p = loadPlan(id);
      ui.status(p ? `本赛道已有方案:${(p.finishFrames / 1000).toFixed(3)} s${p.bundled ? '(内置方案' + (p.name ? ':' + p.name : '') + ',已通过游戏 Verify)' : p.source ? '(本地导入:' + p.source + (p.verified ? ',已通过游戏 Verify)' : ',未验证)') : p.verified ? '(已通过游戏 Verify)' : ''}` : '本赛道还没有方案:点击后先求解(几分钟),再自动驾驶');
    };
    setInterval(refresh, 1000);
    ui.hint('` 自动驾驶 · \\ 显示/隐藏面板   (Mac 上也可 fn+F8 / fn+F9)');
    let lastTrigger = 0;
    const trigger = async () => {
      if (S.solving) { S.cancel = true; ui.log('正在取消求解…'); return; }
      if (S.driving) { if (S.drive) S.drive.stop = true; ui.log('已请求停止:把按键交还给你'); return; } // 停止不设防抖:按了立刻生效
      const now = Date.now(); if (now - lastTrigger < 1500) return; lastTrigger = now; // 只有重复启动才防连点,免得双击一下就把求解取消了
      if (running) return;
      running = true; sticky = null; // 面板状态保持原样:隐藏着启动自动驾驶就不弹出来,用快捷键照样能停
      try {
        const id = curTrackId(); if (!id) { ui.status('游戏还没准备好'); return; }
        let plan = loadPlan(id);
        if (!plan) {
          ui.busy('solve'); ui.bar(0);
          try { plan = await solve(ui); } catch (e) { ui.status('求解失败:' + e.message); ui.log('求解失败: ' + e.message); sticky = { id, text: '求解失败:' + e.message }; ui.busy('idle'); return; }
        }
        ui.busy('drive'); ui.status('自动驾驶:回到起点并出发…');
        const r = await drive(plan, ui);
        const text = r.finished != null ? `完成:${(r.finished / 1000).toFixed(3)} s(方案 ${(plan.finishFrames / 1000).toFixed(3)} s)` : '已停止';
        sticky = { id, text }; ui.status(text);
        ui.bar(r.finished != null ? 100 : 0);
      } catch (e) { ui.status('出错:' + e.message); ui.log('出错: ' + e.message); sticky = { id: curTrackId(), text: '出错:' + e.message }; }
      finally { running = false; ui.busy('idle'); }
    };
    const paintGd = () => { const b = ui.$('gd'); b.textContent = '引导线:' + (S.guideOn ? '开' : '关'); b.classList.toggle('off', !S.guideOn); };
    paintGd();
    ui.$('gd').addEventListener('click', () => {
      S.guideOn = !S.guideOn; try { localStorage.setItem('ptai:guide', S.guideOn ? '1' : '0'); } catch { /* ignore */ }
      if (GUIDEUI) GUIDEUI.setEnabled(S.guideOn); if (S.guideOn && S.driving && S.guideStart) S.guideStart(); paintGd();
    });
    if (GUIDEUI) GUIDEUI.setEnabled(S.guideOn);
    ui.$('go').addEventListener('click', () => trigger());
    installHotkeys(ui, () => trigger());
    installInputLock();
    ui.$('clr').addEventListener('click', () => { const id = curTrackId(); if (id) { clearPlan(id); ui.log('已清除本赛道缓存'); } });
    ui.$('cp').addEventListener('click', async () => { const id = curTrackId(); const p = id && loadPlan(id); if (!p) { ui.log('本赛道还没有方案'); return; } try { await navigator.clipboard.writeText(p.recording); ui.log('回放串已复制'); } catch { ui.log('复制失败(浏览器不允许)'); } });
    window.__ptai = { PT, S, prepareGuide, solve: (o) => solve(ui, o), drive: (p) => drive(p, ui), loadPlan, savePlan, curTrackId, primaryIdx, ui };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

})();
