// PolyTrack AI — 页面内自动驾驶(扩展的 MAIN world 脚本,构建时与 page_shim / solver 拼成一个 autopilot.js)。
// 仅个人学习研究;只支持 PolyTrack 0.6.3(https://app-polytrack.kodub.com/0.6.3/)。
//
// 做了什么:
//  1. 把游戏自己的物理 Worker 换成"打过补丁的 blob"(补丁 = 虚拟时钟 + 批量评估引擎,在你自己的浏览器里内存中完成,不写盘);
//  2. 时钟推进器:没开自动驾驶时,按真实时间把虚拟时钟推进给 Worker,游戏照常可玩;
//  3. 规划(第一次点击时,按这个顺序,谁先成谁用):
//       a. 已有现成方案(内置 / 本机导入 / 浏览器缓存)而且不慢于榜单第 1 名 → 直接用,什么都不算;
//       b. 否则取榜单第 1 名的回放(只读),过游戏自带 Verify,再在页面里微调(每次接受都用真实完成帧、最后再过 Verify),结果存进本赛道缓存,下次直接用;
//       c. 榜单读不到 / 没有第 1 名 / 回放校验不过 → 从零求解(滚动时域规划 + 探索式兜底 + 打磨 + Verify),同样存缓存;
//     面板上可以改成"目标名次 / 目标秒数"(整数):按榜单算出对应的完成时间 / 名次;自己的方案比目标快得多时调不慢(逐帧打磨过的方案一动就跑不到终点),
//     所以改用榜单上那一名的回放(只读取得、过游戏 Verify,不存进缓存,界面上标明是别人的成绩);
//  4. 自动驾驶:在精确的物理帧注入键盘事件(帧号来自求解结果),所以每次开的结果和求解时逐帧一致;
//  5. 网络:扩展只做两种只读 GET(vps.kodub.com 的榜单 / 回放接口,不带令牌,和游戏自己看榜单发的同类请求),从不 POST、不上传任何成绩,
//     也不包装游戏的任何网络 API;成绩是否上传完全由游戏结算界面决定。
(() => {
  const PT = window.__pt;
  const SOLVER = window.__ptSolver; // { Solver }
  const GUIDE = window.__ptGuideMath, GUIDEUI = window.__ptGuideUI; // 引导线(见 extension/src/guide.js)
  const RANK = window.__ptRank; // 名次 <-> 完成时间:{ resolveTarget, chooseForTarget, … }(见 scripts/lib/rank.mjs)
  const GAME_BASE = 'https://app-polytrack.kodub.com/0.6.3/';
  const WORKER_SHIM = __WORKER_SHIM__;
  const EVAL_CASES = __EVAL_CASES__;
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

  /** 回放串 -> 5 个键的翻转帧列表(与 pt_codec.decodeRecording 同格式;解不开就抛错,调用方当作"这条回放不能用") */
  async function decodeRecordingWeb(str) {
    const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/')); const z = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) z[i] = bin.charCodeAt(i);
    const raw = new Uint8Array(await new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const lists = []; let off = 0;
    for (let k = 0; k < 5; k++) {
      if (off + 3 > raw.length) throw new Error('回放数据不完整');
      const n = raw[off] | (raw[off + 1] << 8) | (raw[off + 2] << 16); off += 3;
      if (off + 3 * n > raw.length) throw new Error('回放数据不完整');
      const list = []; for (let j = 0; j < n; j++) { const d = raw[off] | (raw[off + 1] << 8) | (raw[off + 2] << 16); off += 3; list.push(j === 0 ? d : list[j - 1] + d); }
      lists.push(list);
    }
    return lists;
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
  const BUNDLED = __BUNDLED_PLANS__;
  const loadLocal = (id) => { try { return JSON.parse(localStorage.getItem(cacheKey(id)) || 'null'); } catch { return null; } };
  /** 本地缓存与内置方案里取更快的那个(都要求已通过 Verify;没有 verified 标记的本地方案也保留,但排在内置之后) */
  // 只在本机用的方案(例如榜单第 1 名回放打底的):由 extension/plans/local.json 在本机构建时内联;该文件被 .gitignore,不进仓库,公开构建(--public)里是空的。
  const LOCAL_SEED = __LOCAL_PLANS__;
  const BUILD = __BUILD_INFO__; // { v: 版本号(来自 manifest.json), t: 构建时间, local: 本机方案条数 }
  const isPlan = (p) => !!p && Number.isFinite(p.finishFrames) && p.finishFrames > 0 && typeof p.recording === 'string'; // 缓存损坏 / 旧格式的不参与比较,免得 sort 的比较器出 NaN
  /** 这条赛道所有可用来源的方案(内置 / 本机导入 / 浏览器缓存),按完成帧从快到慢;同帧数时内置优先(sort 稳定) */
  const planCandidates = (id) => {
    const loc = loadLocal(id);
    const b = BUNDLED[id] ? { ...BUNDLED[id], verified: true, bundled: true, from: '内置' } : null;
    const sd = LOCAL_SEED[id] ? { v: 1, ...LOCAL_SEED[id], verified: true, from: '本机导入' } : null;
    const lc = loc && loc.verified ? { ...loc, from: '浏览器缓存' } : null;
    return [b, sd, lc].filter(isPlan).sort((x, y) => x.finishFrames - y.finishFrames);
  };
  const loadPlan = (id) => planCandidates(id)[0] ?? loadLocal(id);
  const savePlan = (id, p) => { try { localStorage.setItem(cacheKey(id), JSON.stringify(p)); } catch { /* 无痕等场景下存不了:本次仍可用 */ } };
  const clearPlan = (id) => { try { localStorage.removeItem(cacheKey(id)); } catch { /* ignore */ } };

  const curTrackId = () => { const i = primaryIdx(); if (i < 0) return null; const m = PT.meta[i]; return hashTrack(m.creates[m.creates.length - 1].trackData); };

  // ================= 4b. 进度条:把几个阶段按权重折成 0~100%,并估计剩余时间 =================
  // stages: [{ key, label, short(阶段条上的短名), w(权重), dur(按时间走的阶段:总秒数), est(之后才轮到的阶段:估计秒数) }]。
  // enter(key[, label]):进入阶段(阶段内进度归零,总进度回到该阶段起点);set(frac):阶段内进度 0~1(只增不减);done():全部完成 = 100%。
  // 剩余时间 = 当前阶段剩余(按时间的阶段:dur - 已用;按比例的阶段:已用 × (1 - f) / f,f < 4% 或不到 6 s 时不估)+ 后面各阶段的 dur / est。
  function makeProgress(ui, stages) {
    const sum = stages.reduce((a, x) => a + x.w, 0), t0 = Date.now(), steps = stages.map((x) => x.short ?? x.label);
    let idx = -1, ts = t0, frac = 0, last = 0;
    const before = (i) => (100 * stages.slice(0, i).reduce((a, x) => a + x.w, 0)) / sum;
    const rest = () => {
      const st = stages[idx], el = (Date.now() - ts) / 1000; let cur;
      if (st.dur != null) cur = Math.max(0, st.dur - el); else if (frac >= 0.04 && el >= 6) cur = (el * (1 - frac)) / frac; else return null;
      return cur + stages.slice(idx + 1).reduce((a, x) => a + (x.dur ?? x.est ?? 0), 0);
    };
    const paint = (force) => {
      const now = Date.now(); if (!force && now - last < 150) return; last = now;
      const st = stages[idx];
      ui.progress({ pct: Math.min(99.9, before(idx) + ((100 * st.w) / sum) * frac), label: st.label, steps, step: idx, elapsed: (now - t0) / 1000, rest: rest() });
    };
    return {
      enter(key, label) { const i = stages.findIndex((x) => x.key === key); if (i < 0) return; idx = i; frac = 0; ts = Date.now(); if (label) stages[i].label = label; paint(true); },
      set(f) { if (idx < 0) return; frac = Math.max(frac, Math.max(0, Math.min(1, f))); paint(false); },
      done(label = '完成') { ui.progress({ pct: 100, label, steps, step: stages.length, elapsed: (Date.now() - t0) / 1000, rest: null }); },
    };
  }

  // ================= 5. 求解 =================
  async function solve(ui, { polishSeconds = 30 } = {}) {
    const src = primaryIdx(); if (src < 0) throw new Error('游戏还没准备好(先选好赛道、看到起点画面)');
    const id = curTrackId(); const g = makeG(src); const t0 = Date.now();
    const workers = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 2));
    S.solving = true; S.cancel = false; ui.busy('solve');
    const PG = makeProgress(ui, [ // 权重 = 大致的时间占比;打磨按时间走,规划按"沿中线走了多远 / 中线总长"走
      { key: 'init', label: '建立赛道势能', short: '准备', w: 3, est: 10 },
      { key: 'plan', label: '规划路线', short: '规划', w: 72 },
      ...(polishSeconds > 0 ? [{ key: 'polish', label: '打磨', short: '打磨', w: 20, dur: polishSeconds }] : []),
      { key: 'verify', label: '游戏 Verify 复核', short: '复核', w: 5, est: 5 },
    ]);
    try {
      const solver = new SOLVER.Solver(g, { workers, potential: POTENTIAL, seed: 1, commitN: 6, pop: 96, iters: 3, segs: [...Array(6).fill(40), ...Array(6).fill(100), ...Array(4).fill(240)], log: (m) => ui.log(m), cancel: () => S.cancel, onProgress: (p) => PG.set(p.frac), stallRetries: 2, stallTotalMax: 2, slowSegs: null }); // 页面里求解:规划停滞最多重试 2 次,还不行就改用探索式规划(下面),别让人干等
      PG.enter('init'); ui.status(`求解中:建立赛道势能,启动 ${workers} 个评估线程…`);
      await solver.init();
      PG.enter('plan'); ui.status('求解中:阶段 A 滚动时域规划(几分钟,期间游戏画面会卡一些)');
      let A; // 先用滚动时域规划(圈速更好);它停滞 / 失败(新赛道里的墙、环、长跳常见)就改用 Go-Explore 式探索找一条能冲线的路线,后面照样打磨 + Verify
      try { A = await solver.plan(); } catch (e) {
        if (S.cancel || /已取消/.test(e.message)) throw e;
        ui.log('规划失败:' + e.message.slice(0, 80) + ' → 改用探索式规划'); ui.status('求解中:规划失败,改用探索式规划(最多 10 分钟)'); PG.enter('plan', '探索式规划(备用)');
        A = await SOLVER.exploreLap(solver, { seconds: 600, log: (m) => ui.log(m), onProgress: (p) => PG.set(p.frac) });
      }
      let masks = A.masks, fin = await solver.finishOf(A.masks);
      ui.log(`规划完成: ${fin} 帧 (${(fin / 1000).toFixed(3)} s)`);
      if (polishSeconds > 0 && !S.cancel) {
        PG.enter('polish'); ui.status(`求解中:阶段 B 打磨 ${polishSeconds} s`);
        const P = await solver.polish(masks, fin, { seconds: polishSeconds });
        masks = P.masks; fin = P.finishFrames; ui.log(`打磨完成: ${fin} 帧 (${(fin / 1000).toFixed(3)} s)`);
      }
      const toggles = SOLVER.masksToToggles(masks);
      const recording = await encodeRecordingWeb(toggles);
      PG.enter('verify'); ui.status('求解中:用游戏自带 Verify 复核…');
      const v = await g.verify(recording, fin, 1); const vm = await g.verify(recording, fin - 1, 1);
      const verified = v[0].result === true && vm[0].result === false;
      const plan = { v: 1, finishFrames: fin, toggles, recording, verified, solvedAt: Date.now(), solveSeconds: Math.round((Date.now() - t0) / 1000) };
      savePlan(id, plan);
      ui.log(`Verify ${verified ? '通过' : '未通过'}(完成帧 ${v[0].result}, 少 1 帧 ${vm[0].result})`);
      PG.done('求解完成');
      return plan;
    } finally {
      for (const p of PT.pool) p.w.terminate(); PT.pool = []; S.solving = false;
    }
  }

  // ================= 5b. 规划总入口:现成方案 → 榜单第 1 名回放 + 微调 → 从零求解 =================
  // 只读:GET vps.kodub.com/v6/leaderboard 与 /v6/recordings(游戏自己看榜单时发的同类请求),不带任何令牌 / cookie,从不 POST。
  const LB_BASE = 'https://vps.kodub.com/v6/';
  const POLISH_DEFAULT_S = 120;
  /** 微调预算(秒):S.polishSeconds > localStorage['ptai:polish'] > 默认 120;0 = 只取榜单回放、不微调 */
  const polishBudget = () => { if (Number.isFinite(S.polishSeconds) && S.polishSeconds >= 0) return S.polishSeconds; try { const v = localStorage.getItem('ptai:polish'); if (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v); } catch { /* ignore */ } return POLISH_DEFAULT_S; };
  const secStr = (frames) => (frames / 1000).toFixed(3) + ' s';
  async function lbGet(path) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 12000);
    try { const r = await fetch(LB_BASE + path, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ac.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(to); }
  }
  const trackId64Cache = new Map();
  /** 榜单用的赛道编号(64 位十六进制):由游戏自己的赛道解析器(Worker 里的 Track.getId())算出,按赛道指纹缓存 */
  async function trackId64(src, id) {
    if (trackId64Cache.has(id)) return trackId64Cache.get(id);
    const ti = await makeG(src).trackInfo(); const tid = ti && !ti.error && /^[0-9a-f]{64}$/.test(ti.trackId || '') ? ti.trackId : null;
    if (tid) trackId64Cache.set(id, tid); return tid;
  }
  /** 榜单(只看已验证的、完成帧升序)的第 skip 条,0 起;每次一个只读 GET。返回 { total 榜单总条数, entry: { frames, id } | null }(只取这两个字段,不碰昵称等) */
  async function lbAt(tid, skip) {
    const lb = await lbGet(`leaderboard?version=0.6.3&trackId=${tid}&skip=${skip}&amount=1&onlyVerified=true`);
    const e = lb && Array.isArray(lb.entries) ? lb.entries[0] : null;
    return { total: lb && Number.isFinite(lb.total) ? lb.total : 0, entry: e && Number.isInteger(e.frames) && e.frames > 0 && e.id != null ? { frames: e.frames, id: e.id } : null };
  }
  /** 榜单上某一条的回放串(只读 GET);没有 / 格式不对返回 null */
  async function fetchRecording(entryId) {
    const rec = await lbGet(`recordings?version=0.6.3&ids=${encodeURIComponent(String(entryId))}`);
    const r = Array.isArray(rec) && rec[0] ? rec[0].recording : null; return typeof r === 'string' && r ? r : null;
  }
  /** 榜单第 1 名(只看已验证的)的完成帧 + 回放串;没有 / 数据不对就返回 null */
  async function fetchTop1(tid) {
    const { entry } = await lbAt(tid, 0); if (!entry) return null;
    const recording = await fetchRecording(entry.id);
    return recording ? { frames: entry.frames, recording } : null;
  }
  const verifyExact = async (g, rec, fin) => { const at = await g.verify(rec, fin, 1); const m1 = await g.verify(rec, fin - 1, 1); const p1 = await g.verify(rec, fin + 1, 1); return at[0].result === true && m1[0].result === false && p1[0].result === false; };

  /** 榜单第 1 名回放当起点:先过游戏 Verify 并立刻存进缓存,再在页面里微调(预算 polishBudget() 秒),改进过 Verify 后覆盖缓存。返回方案;回放不能用就返回 null */
  async function deriveFromTop(ui, id, src, top, existing) {
    const g = makeG(src); const secs = polishBudget(); const t0 = Date.now();
    S.solving = true; S.cancel = false; ui.busy('solve');
    const PG = makeProgress(ui, [
      { key: 'v1', label: '复核榜单回放', short: '复核回放', w: 6, est: 4 },
      ...(secs > 0 ? [{ key: 'polish', label: '微调榜单回放', short: '微调', w: 90, dur: secs }, { key: 'v2', label: '复核微调结果', short: '复核结果', w: 4, est: 5 }] : []),
    ]);
    try {
      PG.enter('v1'); ui.status(`榜单第 1 名 ${secStr(top.frames)}:用游戏自带 Verify 复核它的回放…`);
      let toggles; try { toggles = await decodeRecordingWeb(top.recording); } catch (e) { ui.log('回放解码失败:' + String(e.message).slice(0, 60)); return null; }
      const v0 = await g.verify(top.recording, top.frames, 1); const v1 = await g.verify(top.recording, top.frames - 1, 1);
      if (!(v0[0].result === true && v1[0].result === false)) { ui.log('这条回放在当前赛道上没通过游戏的 Verify,不用'); return null; }
      let plan = { v: 1, finishFrames: top.frames, toggles, recording: top.recording, verified: true, source: '榜单第 1 名回放(只读取得)', solvedAt: Date.now() };
      if (!existing || plan.finishFrames < existing.finishFrames) savePlan(id, plan); // 先存下来:微调到一半关页面也不会白等
      ui.log(`回放通过 Verify:${secStr(top.frames)},已存进缓存`);
      if (secs > 0 && !S.cancel) {
        const workers = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2)); const tP = Date.now(); let now = top.frames;
        PG.enter('polish');
        const paint = () => { const el = (Date.now() - tP) / 1000; PG.set(el / secs); ui.status(`微调榜单第 1 名的回放:${secStr(now)}(榜单 ${secStr(top.frames)},已快 ${top.frames - now} 帧)`); };
        paint(); const timer = setInterval(paint, 400);
        try {
          const r = await SOLVER.polishPlan(g, toggles, top.frames, { seconds: secs, workers, order: 'backward', random: false, log: (m) => ui.log(m), shouldStop: () => S.cancel, onImprove: (x) => { now = x.finishFrames; } });
          if (r.finishFrames < top.frames) {
            PG.enter('v2'); ui.status('微调完成,用游戏自带 Verify 复核…');
            const rec = await encodeRecordingWeb(r.toggles);
            if (await verifyExact(g, rec, r.finishFrames)) {
              plan = { v: 1, finishFrames: r.finishFrames, toggles: r.toggles, recording: rec, verified: true, source: `榜单第 1 名回放 + 页面内微调(快 ${top.frames - r.finishFrames} 帧)`, solvedAt: Date.now(), solveSeconds: Math.round((Date.now() - t0) / 1000) };
              savePlan(id, plan); ui.log(`微调:${secStr(top.frames)} → ${secStr(r.finishFrames)}(快 ${top.frames - r.finishFrames} 帧),Verify 通过,已存进缓存`);
            } else ui.log('微调结果没通过 Verify,仍用榜单回放原样(已存)');
          } else ui.log(`微调 ${secs} s 没找到更快的改法,用榜单回放原样(已存)`);
        } finally { clearInterval(timer); }
      }
      PG.done('回放就绪');
      return plan;
    } finally { for (const p of PT.pool) p.w.terminate(); PT.pool = []; S.solving = false; }
  }

  /**
   * 规划总入口(点击时调用):
   *  1. 已有现成方案,且不慢于榜单第 1 名(或者榜单读不到)→ 直接用,不算;
   *  2. 否则取榜单第 1 名回放,过 Verify 后微调,存缓存(下次走 1);
   *  3. 榜单没有 / 回放不能用 / 出错 → 已有方案就用它,没有就从零求解(solve)。
   */
  async function obtainPlan(ui, id) {
    const src = primaryIdx(); if (src < 0) throw new Error('游戏还没准备好(先选好赛道、看到起点画面)');
    const have = planCandidates(id)[0] ?? null; let top = null, note = '';
    ui.status('对照榜单第 1 名,看现成方案够不够快…'); ui.wait('对照榜单第 1 名');
    try { const tid = await trackId64(src, id); if (!tid) note = '读不到赛道编号'; else { top = await fetchTop1(tid); if (!top) note = '榜单上没有可用的第 1 名'; } } catch (e) { note = '榜单读取失败(' + String(e.message || e).slice(0, 40) + ')'; }
    if (have && (!top || have.finishFrames <= top.frames)) { ui.log(top ? `现成方案 ${secStr(have.finishFrames)}(${have.from})不慢于榜单第 1 名 ${secStr(top.frames)},不用重算` : `${note};直接用现成方案 ${secStr(have.finishFrames)}`); return { plan: have, canceled: false }; }
    if (top) {
      ui.log(`榜单第 1 名 ${secStr(top.frames)},${have ? '比现成方案 ' + secStr(have.finishFrames) + ' 快' : '本赛道还没有方案'} → 取它的回放来微调`);
      let p = null; try { p = await deriveFromTop(ui, id, src, top, have); } catch (e) { if (S.cancel) throw e; ui.log('取榜单回放出错:' + String(e.message || e).slice(0, 80)); }
      const canceled = S.cancel;
      if (p && (!have || p.finishFrames < have.finishFrames)) return { plan: p, canceled };
      if (have) return { plan: have, canceled };
    } else ui.log(note + ',改用现成方案或从零求解');
    if (have) return { plan: have, canceled: false };
    const old = loadLocal(id); if (isPlan(old)) return { plan: old, canceled: false }; // 以前求解但没通过 Verify 的方案:和过去一样照用
    ui.busy('solve');
    return { plan: await solve(ui), canceled: false };
  }

  // ================= 5c. 目标名次 / 目标秒数 =================
  // 面板上填一个整数名次(或秒数),这里按榜单(只读)算出对应的完成时间(或名次),再决定开哪条方案(规则见 scripts/lib/rank.mjs 的 chooseForTarget)。
  // 自己的方案调不慢:逐帧打磨过的方案一动就跑不到终点(实测:整体后移 / 起点多等 / 插入刹车或松油门,几乎都冲不了线),
  // 所以比目标快得多时用榜单上那一名的回放(过游戏 Verify;不存缓存,界面上标明是别人的成绩)。
  const fmtN = (n) => Number(n).toLocaleString('en-US');
  /** 目标(名次或秒数)按榜单算成 { rank, frames, entry, idx, total, … };榜单读不到 / 数据不对就抛错 */
  async function resolveTargetFor(id, src, tgt) {
    const tid = await trackId64(src, id); if (!tid) throw new Error('读不到赛道编号');
    const memo = new Map(); const at = (i) => { let p = memo.get(i); if (!p) { p = lbAt(tid, i); memo.set(i, p); } return p; };
    return RANK.resolveTarget(at, tgt);
  }
  /** 目标换成一句话:"第 50 名 ≈ 22.303 s" / "23 s ≈ 第 1,234 名" */
  const targetText = (r) => r.mode === 'rank'
    ? `第 ${fmtN(r.rank)} 名 ≈ ${secStr(r.frames)}${r.clamped ? `(榜单只有 ${fmtN(r.total)} 人,取最后一名)` : ''}`
    : `${r.frames / 1000} s ≈ ${r.rank > r.total ? `比榜单最后一名(${fmtN(r.total)})还慢` : `第 ${fmtN(r.rank)} 名`}`;
  /** 这个目标下会用哪条方案(面板预览和点击时的日志共用) */
  function targetPlanText(how, r, have) {
    const mine = have ? `本机方案 ${secStr(have.finishFrames)}` : '本赛道还没有方案';
    if (how === 'own') return `${mine},就在目标附近 → 用它`;
    if (how === 'replay') return `${mine}${have ? ',比目标快' : ''} → 用榜单第 ${fmtN(r.idx + 1)} 名(${secStr(r.entry.frames)})的回放,不是自己的方案`;
    return `${mine},比目标慢 → 先尽量提速,到不了就按能到的开`;
  }
  /** 榜单上某一条(r.entry)的回放当方案:只读取回放,过游戏自带 Verify(完成帧恰好对、少 1 帧不行)才用;不存缓存(缓存里只放自己最快的方案)。不能用就返回 null */
  async function replayFromEntry(ui, src, r) {
    const g = makeG(src), e = r.entry, nth = r.idx + 1;
    ui.status(`取榜单第 ${fmtN(nth)} 名的回放(只读)…`); ui.wait('取回放');
    const recording = await fetchRecording(e.id); if (!recording) { ui.log('榜单没给出这条回放'); return null; }
    let toggles; try { toggles = await decodeRecordingWeb(recording); } catch (err) { ui.log('回放解码失败:' + String(err.message).slice(0, 60)); return null; }
    if (S.cancel) return null;
    ui.status(`榜单第 ${fmtN(nth)} 名 ${secStr(e.frames)}:用游戏自带 Verify 复核它的回放…`); ui.wait('复核回放');
    const v0 = await g.verify(recording, e.frames, 1); const v1 = await g.verify(recording, e.frames - 1, 1);
    if (!(v0[0].result === true && v1[0].result === false)) { ui.log('这条回放在当前赛道上没通过游戏的 Verify,不用'); return null; }
    ui.log(`回放通过 Verify:${secStr(e.frames)}(榜单第 ${fmtN(nth)} 名;不存缓存)`);
    return { v: 1, finishFrames: e.frames, toggles, recording, verified: true, ghost: true, rank: nth, source: `榜单第 ${fmtN(nth)} 名的回放(只读取得;别人的成绩,不是自己的方案)`, solvedAt: Date.now() };
  }
  /**
   * 带目标的规划总入口(点击时,面板上的目标不是"最快"时调用):
   *  1. 按榜单(只读)把目标算成完成帧 + 榜单上最接近的那一条;读不到就抛错(不悄悄改成"最快");
   *  2. chooseForTarget:own = 现成方案就在目标附近,直接用;replay = 现成方案比目标快很多(或没有方案),取榜单那一条的回放、过 Verify 后开;
   *     improve = 现成方案比目标慢,走原来的 obtainPlan(取榜单第 1 名回放微调 / 从零求解)尽量提速;回放不能用也退回这一步。
   * 返回 { plan, canceled, targetText };canceled 时 plan 可能为 null。
   */
  async function obtainPlanTarget(ui, id, tgt) {
    const src = primaryIdx(); if (src < 0) throw new Error('游戏还没准备好(先选好赛道、看到起点画面)');
    const have = planCandidates(id)[0] ?? null; let r;
    S.solving = true; S.cancel = false; ui.busy('solve'); ui.status('按目标算榜单上的位置…'); ui.wait('读榜单');
    try { r = await resolveTargetFor(id, src, tgt); }
    catch (e) { throw new Error(`读榜单失败(${String(e.message || e).slice(0, 40)}),没法按${tgt.mode === 'rank' ? '名次' : '秒数'}算;可以切回「最快」`); }
    finally { S.solving = false; }
    if (S.cancel) return { plan: have, canceled: true };
    const how = RANK.chooseForTarget(have ? have.finishFrames : null, r); const tt = `目标 ${targetText(r)}`;
    ui.log(`${tt};${targetPlanText(how, r, have)}`);
    if (how === 'own') return { plan: have, canceled: false, targetText: tt };
    if (how === 'replay') {
      let p = null; S.solving = true; S.cancel = false; ui.busy('solve');
      try { p = await replayFromEntry(ui, src, r); } catch (e) { ui.log('取回放出错:' + String(e.message || e).slice(0, 80)); }
      finally { S.solving = false; for (const w of PT.pool) w.w.terminate(); PT.pool = []; }
      if (S.cancel) return { plan: have, canceled: true };
      if (p) return { plan: p, canceled: false, targetText: tt };
      ui.log(have ? '这条回放用不了,改用现成方案 / 最快流程' : '这条回放用不了,改走"最快"流程');
    }
    const rr = await obtainPlan(ui, id);
    return { ...rr, targetText: `${tt}(做不到,按能到的最快开)` };
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
    const ICON_PLAY = '<svg viewBox="0 0 12 12"><path d="M3 1.6v8.8c0 .4.4.6.8.4l7-4.4c.3-.2.3-.6 0-.8l-7-4.4c-.4-.2-.8 0-.8.4z"/></svg>', ICON_STOP = '<svg viewBox="0 0 12 12"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.6"/></svg>';
    root.innerHTML = `<style>
      :host{all:initial}
      *{box-sizing:border-box}
      .box{--ink:#e9ecf8;--dim:#a0a9cc;--mute:#6c7699;--line:rgba(255,255,255,.075);--acc:#8b9dff;--ok:#5eead4;--warn:#fbbf24;--bad:#fb7185;
        position:fixed;top:64px;right:12px;width:296px;color:var(--ink);font:12px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;
        background:radial-gradient(130% 62% at 0% 0%,rgba(112,128,255,.18),transparent 60%),linear-gradient(180deg,rgba(22,25,41,.87),rgba(11,13,23,.91));
        -webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6);border:1px solid rgba(255,255,255,.1);border-radius:18px;
        box-shadow:0 32px 72px -20px rgba(0,0,0,.7),0 0 0 .5px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.08);user-select:none;pointer-events:auto;overflow:hidden;animation:in .4s cubic-bezier(.2,.8,.2,1)}
      @keyframes in{from{opacity:0;transform:translateY(-6px) scale(.985)}}
      button{all:unset;box-sizing:border-box;cursor:pointer;text-align:center}
      .hd{display:flex;align-items:center;gap:10px;padding:13px 11px 12px 15px;cursor:grab;touch-action:none}
      .hd:active{cursor:grabbing}
      .logo{flex:none;width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(145deg,#90a2ff,#46c8f0);box-shadow:inset 0 0 0 1px rgba(255,255,255,.2),0 6px 18px -4px rgba(112,132,255,.65)}
      .logo svg{width:15px;height:15px}
      .nm{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
      .nm b{font-size:13.5px;font-weight:650;letter-spacing:.1px;white-space:nowrap}
      .nm small{font:600 10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);padding:0 7px;border-radius:99px;background:rgba(255,255,255,.06);border:1px solid var(--line);white-space:nowrap}
      .hp{display:none;font-size:12px;font-weight:650;color:var(--ok);font-variant-numeric:tabular-nums}
      .col .hp:not(:empty){display:block}
      .ic{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;color:var(--mute);transition:background .15s,color .15s}
      .ic:hover{background:rgba(255,255,255,.09);color:#fff}
      .ic svg{width:14px;height:14px;transition:transform .25s cubic-bezier(.3,.9,.3,1)}
      .col .ic svg{transform:rotate(180deg)}
      .mini{height:2px;background:rgba(255,255,255,.05)}
      .mini i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--ok));box-shadow:0 0 10px rgba(94,234,212,.55);transition:width .25s}
      .bd{padding:2px 16px 14px}
      .col .bd{display:none}
      .go{position:relative;display:flex;align-items:center;justify-content:center;gap:9px;width:100%;margin-top:12px;padding:11px 0;border-radius:12px;font-weight:650;font-size:14px;letter-spacing:.3px;color:#0d1226;
        background:linear-gradient(180deg,#fff,#dde2fb);box-shadow:inset 0 1px 0 #fff,0 0 0 1px rgba(255,255,255,.3),0 10px 26px -8px rgba(139,157,255,.6);transition:transform .14s,box-shadow .2s,filter .2s}
      .go:hover{transform:translateY(-1px);filter:brightness(1.03);box-shadow:inset 0 1px 0 #fff,0 0 0 1px rgba(255,255,255,.35),0 14px 30px -8px rgba(139,157,255,.78)}
      .go:active{transform:translateY(0) scale(.99)}
      .gi{display:grid;place-items:center}
      .gi svg{width:12px;height:12px;fill:currentColor}
      .go kbd{position:absolute;right:11px;top:50%;transform:translateY(-50%);font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(13,18,38,.5);padding:3px 6px;border-radius:5px;background:rgba(13,18,38,.07);border:1px solid rgba(13,18,38,.12)}
      .go.busy{color:#fde9a8;background:linear-gradient(180deg,rgba(251,191,36,.22),rgba(251,191,36,.1));box-shadow:inset 0 0 0 1px rgba(251,191,36,.5),0 10px 26px -10px rgba(251,191,36,.55)}
      .go.stop{color:#ffd0d6;background:linear-gradient(180deg,rgba(251,113,133,.24),rgba(251,113,133,.1));box-shadow:inset 0 0 0 1px rgba(251,113,133,.5),0 10px 26px -10px rgba(251,113,133,.55)}
      .go.busy kbd,.go.stop kbd{color:inherit;opacity:.7;background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.16)}
      .stw{display:flex;gap:10px;align-items:flex-start;margin-top:13px;padding:0 2px}
      .dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:6px;background:#566087;box-shadow:0 0 0 3px rgba(255,255,255,.045);transition:background .2s}
      .dot[data-s=work]{background:var(--warn);box-shadow:0 0 0 3px rgba(251,191,36,.16);animation:pulse 1.3s ease-in-out infinite}
      .dot[data-s=drive]{background:var(--ok);box-shadow:0 0 0 3px rgba(94,234,212,.16);animation:pulse 1.3s ease-in-out infinite}
      .dot[data-s=ok]{background:var(--ok);box-shadow:0 0 0 3px rgba(94,234,212,.18),0 0 10px var(--ok)}
      .dot[data-s=err]{background:var(--bad);box-shadow:0 0 0 3px rgba(251,113,133,.18)}
      .dot[data-s=warn]{background:var(--warn);box-shadow:0 0 0 3px rgba(251,191,36,.16)}
      @keyframes pulse{50%{opacity:.4;transform:scale(.8)}}
      .st{flex:1;min-width:0;min-height:18px;color:var(--ink);word-break:break-word;white-space:pre-line;user-select:text}
      .st[data-s=ok]{color:#aaf3e6}
      .st[data-s=err]{color:#ffb4bf}
      .st[data-s=warn]{color:#fde9a8}
      .pg{display:grid;grid-template-rows:1fr;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .25s}
      .pg.idle{grid-template-rows:0fr;opacity:0}
      .pgi{overflow:hidden;min-height:0}
      .pgx{padding:14px 2px 0}
      .pr{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;min-height:26px}
      .pl{font-size:11px;color:var(--dim);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding-bottom:2px}
      .pc{flex:none;font-size:26px;line-height:1;font-weight:600;letter-spacing:-.03em;color:#fff;font-variant-numeric:tabular-nums}
      .trk{height:5px;border-radius:99px;background:rgba(255,255,255,.07);margin-top:10px;position:relative}
      .trk i{display:block;height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,#7c8cff,var(--ok));box-shadow:0 0 14px rgba(94,234,212,.5);transition:width .25s ease;position:relative;overflow:hidden}
      .trk.act i::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.5) 50%,transparent 70%);background-size:200% 100%;animation:sheen 1.5s linear infinite}
      @keyframes sheen{from{background-position:200% 0}to{background-position:-200% 0}}
      .trk.ind i{width:38%!important;animation:ind 1.1s ease-in-out infinite alternate}
      @keyframes ind{from{margin-left:0}to{margin-left:62%}}
      .chips{display:flex;margin-top:12px}
      .chip{position:relative;flex:1;text-align:center;font-size:10px;color:var(--mute);padding-top:13px;white-space:nowrap}
      .chip::before{content:'';position:absolute;top:0;left:50%;width:7px;height:7px;margin-left:-3.5px;border-radius:50%;background:#262d4d;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);z-index:1;transition:background .2s}
      .chip+.chip::after{content:'';position:absolute;top:3px;left:calc(-50% + 7px);right:calc(50% + 7px);height:1px;background:rgba(255,255,255,.12)}
      .chip.ok{color:var(--dim)}
      .chip.ok::before{background:var(--ok);box-shadow:none}
      .chip.ok+.chip::after{background:var(--ok);opacity:.7}
      .chip.on{color:#fff;font-weight:600}
      .chip.on::before{background:#fff;box-shadow:0 0 0 3px rgba(139,157,255,.4)}
      .pt{margin-top:9px;font-size:10.5px;color:var(--mute);font-variant-numeric:tabular-nums;text-align:center}
      .pt:empty,.chips:empty{display:none}
      .keys{display:none;margin-top:14px;padding:11px 12px 10px;border-radius:13px;background:rgba(0,0,0,.24);border:1px solid var(--line)}
      .keys.on{display:block}
      .kr{display:flex;align-items:center;gap:14px}
      .kb{display:grid;grid-template-columns:repeat(3,27px);grid-template-rows:repeat(2,25px);gap:4px;flex:none}
      .k{display:flex;align-items:center;justify-content:center;border-radius:7px;background:linear-gradient(180deg,rgba(255,255,255,.1),rgba(255,255,255,.04));color:var(--mute);box-shadow:inset 0 0 0 1px rgba(255,255,255,.09),0 2px 0 rgba(0,0,0,.4);font-weight:700;font-size:12px;transition:background .06s,transform .06s,box-shadow .06s}
      .k.on{background:linear-gradient(180deg,#86f5e3,#34d4be);color:#032720;box-shadow:inset 0 0 0 1px #b4f7ec,0 0 14px rgba(94,234,212,.6);transform:translateY(2px)}
      .k.r{grid-column:3;grid-row:1;font-size:10px}
      .k.r.off{visibility:hidden}
      .kt{font-size:13px;font-weight:600;color:#c4f6ec;min-height:18px}
      #tl{display:block;width:100%;height:50px;margin-top:9px;border-radius:7px;background:rgba(0,0,0,.26)}
      .sec{margin-top:16px}
      .tg{margin-top:0;display:grid;grid-template-rows:1fr;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .25s}
      .tgi{overflow:hidden;min-height:0}
      .tgx{padding:16px 0 0}
      .cap{margin:0 3px 7px;font-size:10px;font-weight:650;letter-spacing:.09em;color:var(--mute)}
      .grp{border-radius:13px;background:rgba(255,255,255,.035);border:1px solid var(--line);overflow:hidden}
      .seg{position:relative;display:grid;grid-template-columns:repeat(3,1fr);margin:7px;padding:2px;border-radius:9px;background:rgba(0,0,0,.32);box-shadow:inset 0 0 0 1px var(--line)}
      .seg .thumb{position:absolute;top:2px;bottom:2px;left:2px;width:calc((100% - 4px)/3);border-radius:7px;background:linear-gradient(180deg,rgba(139,157,255,.42),rgba(139,157,255,.22));box-shadow:inset 0 0 0 1px rgba(160,175,255,.42),inset 0 1px 0 rgba(255,255,255,.18),0 3px 12px rgba(80,100,255,.25);transform:translateX(calc(var(--i,0)*100%));transition:transform .3s cubic-bezier(.3,.9,.3,1)}
      .seg button{position:relative;z-index:1;padding:5px 0;font-size:11.5px;color:var(--dim);transition:color .2s}
      .seg button:hover{color:#fff}
      .seg button.on{color:#fff;font-weight:650}
      .tbody{display:none;border-top:1px solid var(--line);padding:10px 12px 11px}
      .tg.m-rank .tbody,.tg.m-sec .tbody{display:block}
      .tin{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dim)}
      .tin input{all:unset;box-sizing:border-box;flex:none;width:92px;padding:5px 9px;border-radius:8px;background:rgba(0,0,0,.34);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);color:#fff;font:700 13px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right;user-select:text;transition:box-shadow .15s}
      .tin input:focus{box-shadow:inset 0 0 0 1px var(--acc),0 0 0 3px rgba(139,157,255,.22)}
      .tin input::placeholder{color:#4b5478}
      .tn{margin-top:8px;font-size:10.5px;line-height:1.55;color:var(--dim);white-space:pre-line;word-break:break-word;user-select:text}
      .tn:empty{display:none}
      .tg.dis{grid-template-rows:0fr;opacity:0;pointer-events:none}
      .row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:40px;padding:0 12px;border-top:1px solid var(--line);color:var(--ink);font-size:12px}
      .row:first-child{border-top:0}
      .acts{display:flex;gap:2px;margin-right:-6px}
      .lnk{padding:4px 7px;border-radius:7px;font-size:11px;color:var(--acc);transition:background .15s,color .15s}
      .lnk:hover{background:rgba(139,157,255,.14);color:#c4ceff}
      #clr:hover{background:rgba(251,113,133,.14);color:#ffb4bf}
      .gd{position:relative;flex:none;width:36px;height:21px;border-radius:99px;background:linear-gradient(180deg,#3fd9c3,var(--ok));box-shadow:inset 0 0 0 1px rgba(255,255,255,.25),0 0 12px rgba(94,234,212,.28);transition:background .2s,box-shadow .2s}
      .gd::after{content:'';position:absolute;top:2px;left:17px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4);transition:left .22s cubic-bezier(.3,.9,.3,1)}
      .gd.off{background:#353d60;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
      .gd.off::after{left:2px}
      .dt{display:none;align-items:center;gap:5px;margin-top:12px;padding:2px 3px;font-size:10.5px;color:var(--mute);transition:color .15s}
      .dt.has{display:inline-flex}
      .dt:hover{color:var(--dim)}
      .dt svg{width:10px;height:10px;transition:transform .25s cubic-bezier(.3,.9,.3,1)}
      .dt.open svg{transform:rotate(180deg)}
      .log{display:none;margin-top:7px;max-height:150px;overflow:auto;padding:7px 9px;border-radius:10px;background:rgba(0,0,0,.3);box-shadow:inset 0 0 0 1px var(--line);font:10.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);white-space:pre-wrap;word-break:break-all;user-select:text;scrollbar-width:thin}
      .log.show{display:block}
      .hk{margin-top:13px;font-size:10px;color:var(--mute);padding:0 2px}
      .ft{margin-top:5px;font-size:9.5px;color:#535c80;white-space:pre-line;line-height:1.5;padding:0 2px}
      @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
    </style>
    <div class="box" id="box">
      <div class="hd" id="hd">
        <span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19c4 0 4-7 8-7s4-7 8-7"/><circle cx="4" cy="19" r="1.3" fill="#fff"/><circle cx="20" cy="5" r="1.3" fill="#fff"/></svg></span>
        <span class="nm"><b>PolyTrack AI</b><small id="ver" title="适配 PolyTrack 0.6.3 · 本地研究用">0.6.3</small></span>
        <span class="hp" id="hp"></span>
        <button class="ic" id="min" tabindex="-1" title="折叠 / 展开"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg></button>
      </div>
      <div class="mini"><i id="mbar"></i></div>
      <div class="bd" id="bd">
        <button class="go" id="go" tabindex="-1"><span class="gi" id="gi"></span><span id="gt">一键自动驾驶</span><kbd id="kk">\`</kbd></button>
        <div class="stw"><i class="dot" id="dot" data-s="idle"></i><div class="st" id="st">待命</div></div>
        <div class="pg idle" id="pg"><div class="pgi"><div class="pgx">
          <div class="pr"><span class="pl" id="pl"></span><span class="pc" id="pc"></span></div>
          <div class="trk" id="trk"><i id="bar"></i></div>
          <div class="chips" id="chips"></div>
          <div class="pt" id="pt"></div>
        </div></div></div>
        <div class="keys" id="keys"><div class="kr"><div class="kb"><b class="k r off" id="k_reset">R</b><b class="k" id="k_up" style="grid-column:2;grid-row:1">W</b><b class="k" id="k_left" style="grid-column:1;grid-row:2">A</b><b class="k" id="k_down" style="grid-column:2;grid-row:2">S</b><b class="k" id="k_right" style="grid-column:3;grid-row:2">D</b></div><div class="kt" id="kt">&nbsp;</div></div>
          <canvas id="tl" width="264" height="50"></canvas></div>
        <div class="sec tg m-fast" id="tg"><div class="tgi"><div class="tgx">
          <div class="cap">目标</div>
          <div class="grp">
            <div class="seg" id="seg"><i class="thumb"></i><button data-m="fast" tabindex="-1" title="尽量快(默认)">最快</button><button data-m="rank" tabindex="-1" title="填一个整数名次:跑完大约排这个名次">名次</button><button data-m="sec" tabindex="-1" title="填一个整数秒数:跑完大约是这个时间">秒数</button></div>
            <div class="tbody">
              <div class="tin"><span id="tp">跑完约第</span><input id="tv" type="text" inputmode="numeric" maxlength="7" autocomplete="off" spellcheck="false" placeholder="50"><span id="ts">名</span></div>
              <div class="tn" id="tn"></div>
            </div>
          </div>
        </div></div></div>
        <div class="sec"><div class="grp">
          <div class="row"><span>引导线</span><button class="gd" id="gd" tabindex="-1"></button></div>
          <div class="row"><span>本赛道方案</span><span class="acts"><button class="lnk" id="clr" tabindex="-1">清除缓存</button><button class="lnk" id="cp" tabindex="-1">复制回放串</button></span></div>
        </div></div>
        <button class="dt" id="dt" tabindex="-1" title="展开 / 收起运行详情(取方案 / Verify / 微调的过程)">运行详情<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
        <div class="log" id="log"></div>
        <div class="hk" id="hk"></div>
        <div class="ft" id="ft">只读榜单、从不上传成绩;成绩是否上传由游戏结算界面决定。</div>
      </div>
    </div>`;
    document.documentElement.appendChild(host);
    const $ = (id) => root.getElementById(id);
    for (const b of root.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢键盘焦点(否则 Enter / 空格会触发按钮)
    // ---- 折叠 / 拖动(位置和折叠状态记在 localStorage,存不了也不影响使用) ----
    const box = $('box');
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
    if (lsGet('ptai:collapsed') === '1') box.classList.add('col');
    $('min').addEventListener('click', () => lsSet('ptai:collapsed', box.classList.toggle('col') ? '1' : '0'));
    const dtPaint = (open) => { $('log').classList.toggle('show', open); $('dt').classList.toggle('open', open); $('log').scrollTop = 1e9; }; // 运行详情:默认折叠,展开状态记住
    dtPaint(lsGet('ptai:logopen') === '1');
    $('dt').addEventListener('click', () => { const open = !$('log').classList.contains('show'); lsSet('ptai:logopen', open ? '1' : '0'); dtPaint(open); });
    const place = (x, y) => { const w = box.offsetWidth || 296; box.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, x)) + 'px'; box.style.top = Math.max(4, Math.min(window.innerHeight - 44, y)) + 'px'; box.style.right = 'auto'; };
    try { const p = JSON.parse(lsGet('ptai:pos') || 'null'); if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) place(p.x, p.y); } catch { /* ignore */ }
    let drag = null;
    $('hd').addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('button')) return; const r = box.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; $('hd').setPointerCapture(e.pointerId); e.preventDefault(); });
    $('hd').addEventListener('pointermove', (e) => { if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy); });
    const endDrag = () => { if (!drag) return; drag = null; const r = box.getBoundingClientRect(); lsSet('ptai:pos', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); };
    $('hd').addEventListener('pointerup', endDrag); $('hd').addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', () => { if (box.style.left) { const r = box.getBoundingClientRect(); place(r.left, r.top); } });
    // ---- 状态 / 进度 ----
    const lines = []; let mode = 'idle', tone = '', chipKey = '';
    // ---- 目标(最快 / 名次 / 秒数):选择和填的数字都记在 localStorage;只允许 1~7 位整数。真正的计算在 boot() 里(按榜单算,见 obtainPlanTarget) ----
    const TG = { mode: 'fast', rank: '', sec: '' }, digits = (v) => String(v ?? '').replace(/\D/g, '').slice(0, 7);
    try { const t = JSON.parse(lsGet('ptai:target') || 'null'); if (t && ['fast', 'rank', 'sec'].includes(t.mode)) { TG.mode = t.mode; TG.rank = digits(t.rank); TG.sec = digits(t.sec); } } catch { /* ignore */ }
    const tgSave = () => lsSet('ptai:target', JSON.stringify(TG));
    const tgPaint = () => {
      $('tg').className = 'sec tg m-' + TG.mode + (mode !== 'idle' ? ' dis' : '');
      for (const b of $('seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === TG.mode);
      $('seg').style.setProperty('--i', ['fast', 'rank', 'sec'].indexOf(TG.mode)); // 滑块位置
      $('tp').textContent = TG.mode === 'rank' ? '跑完约第' : '跑完约'; $('ts').textContent = TG.mode === 'rank' ? '名' : '秒'; $('tv').placeholder = TG.mode === 'rank' ? '50' : '23';
      if (TG.mode !== 'fast' && $('tv').value !== TG[TG.mode]) $('tv').value = TG[TG.mode];
    };
    $('seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.dataset.m === TG.mode) return; TG.mode = b.dataset.m; tgSave(); tgPaint(); ui.onTarget && ui.onTarget(); });
    $('tv').addEventListener('input', () => { const v = digits($('tv').value); if (v !== $('tv').value) $('tv').value = v; if (TG.mode !== 'fast') TG[TG.mode] = v; tgSave(); ui.onTarget && ui.onTarget(); });
    // 在输入框里打字时不让按键冒泡到游戏(游戏在 window 上监听 WASD / R / T 等);Enter / Esc 退出输入、把键盘还给游戏
    for (const t of ['keydown', 'keyup', 'keypress']) $('tv').addEventListener(t, (e) => { if (t === 'keydown' && (e.key === 'Enter' || e.key === 'Escape')) $('tv').blur(); e.stopPropagation(); });
    const fmtT = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const dotPaint = () => { $('dot').dataset.s = mode === 'solve' ? 'work' : mode === 'drive' ? 'drive' : tone || 'idle'; $('st').dataset.s = mode === 'idle' ? tone : ''; };
    /** 画进度条。p = 0~100;o = { label 阶段名, steps 阶段名列表, step 当前阶段序号(超过末尾 = 全部完成), time 底部小字 } */
    const setBar = (p, o = {}) => {
      const pct = Math.max(0, Math.min(100, p || 0)), w = pct + '%', has = pct > 0 || !!o.label;
      $('bar').style.width = w; $('mbar').style.width = w;
      $('trk').classList.remove('ind'); $('trk').classList.toggle('act', mode !== 'idle' && pct > 0 && pct < 100);
      $('pg').classList.toggle('idle', !has);
      $('pl').textContent = o.label ?? ''; $('pc').textContent = has && pct > 0 ? Math.floor(pct) + '%' : ''; $('hp').textContent = pct > 0 ? Math.floor(pct) + '%' : '';
      const key = o.steps ? o.steps.join('|') + '#' + o.step : '';
      if (key !== chipKey) { chipKey = key; $('chips').innerHTML = o.steps ? o.steps.map((t, i) => `<span class="chip ${i < o.step ? 'ok' : i === o.step ? 'on' : ''}">${t}</span>`).join('') : ''; }
      $('pt').textContent = o.time ?? '';
    };
    const ui = {
      status: (t) => { $('st').textContent = t; tone = /^完成/.test(t) ? 'ok' : /失败|出错/.test(t) ? 'err' : /^已(停止|取消)/.test(t) ? 'warn' : ''; dotPaint(); },
      log: (t) => { lines.push(t); if (lines.length > 40) lines.shift(); $('log').textContent = lines.join('\n'); $('log').scrollTop = 1e9; $('dt').classList.add('has'); },
      drive: (f, total) => { setBar((100 * f) / total, { label: '自动驾驶', time: `${(f / 1000).toFixed(2)} s / ${(total / 1000).toFixed(2)} s` }); $('st').textContent = `自动驾驶中 ${(f / 1000).toFixed(2)} s / ${(total / 1000).toFixed(2)} s`; },
      /** 目标:{ mode: 'fast' | 'rank' | 'sec', value: 整数(fast 时为 null;没填 / 不是数字为 NaN) } */
      getTarget: () => ({ mode: TG.mode, value: TG.mode === 'fast' ? null : parseInt(TG[TG.mode], 10) }),
      targetNote: (t) => { $('tn').textContent = t || ''; },
      onTarget: null,
      busy: (m) => { mode = m; if (m !== 'idle') $('tv').blur(); tgPaint(); const b = $('go'); b.className = 'go' + (m === 'solve' ? ' busy' : m === 'drive' ? ' stop' : ''); $('gi').innerHTML = m === 'idle' ? ICON_PLAY : ICON_STOP; $('gt').textContent = m === 'idle' ? '一键自动驾驶' : m === 'solve' ? '取消求解' : '停止(交还给我)'; dotPaint(); },
      foot: () => { $('ft').textContent = `v${BUILD.v} · 构建 ${BUILD.t} · ${BUILD.local ? '本机方案 ' + BUILD.local + ' 条' : '公开版'} · 只读榜单、从不上传成绩;成绩是否上传由游戏结算界面决定。`; $('ver').textContent = `v${BUILD.v}`; },
      /** 简单进度条(自动驾驶 / 清零用):0 = 收起,100 = 完成 */
      bar: (p) => setBar(p, p >= 100 ? { label: '完成' } : {}),
      /** 分阶段进度(求解 / 微调用):pct 总百分比,label 当前阶段,steps / step 阶段条,elapsed 已用秒,rest 估计还需秒(未知为 null) */
      progress: ({ pct, label, steps, step, elapsed, rest }) => setBar(pct, { label, steps, step, time: `已用 ${fmtT(elapsed)}${rest != null ? ` · 预计还需 ${fmtT(rest)}` : ''}` }),
      /** 不定长等待(读榜单、建势能):来回扫的条 */
      wait: (label) => { setBar(0, { label }); $('trk').classList.add('ind'); },
      hint: (t) => { $('hk').textContent = t; },
      setPanel: (on) => { host.style.display = on ? '' : 'none'; },
      panelVisible: () => host.style.display !== 'none',
      /** 自动驾驶时的按键显示。keys(toggles, 当前帧, 物理侧按键位) 更新状态;keys(null) 隐藏。真正的绘制放在 rAF 里(每帧最多一次) */
      keys: (toggles, f, mask) => { ks = toggles ? { toggles, f, mask, drawn: false } : null; if (!toggles) { $('keys').classList.remove('on'); $('tl').getContext('2d').clearRect(0, 0, 1e4, 1e4); } },
      root, $, host,
    };
    tgPaint(); $('gi').innerHTML = ICON_PLAY;
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
      const cv = $('tl'), dpr = Math.min(3, window.devicePixelRatio || 1), W = 264, H = 50;
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
          c.fillStyle = a <= f && b > f ? '#5eead4' : b <= f ? '#39477c' : '#8b9dff'; // 正在按 / 已按过 / 将要按
          c.fillRect(xa, y + 2, Math.max(1.5, xb - xa), rh - 4);
        }
      });
      const xn = xf(f); c.fillStyle = 'rgba(255,255,255,.9)'; c.fillRect(xn - 0.5, 0, 1, H);
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
    const ui = makePanel(); let running = false; let pvId = null; let sticky = null; // sticky:最近一次结果,留在面板上直到再次点击或换赛道
    const refresh = () => {
      ui.foot();
      if (running) return;
      const id = curTrackId();
      if (!id) { ui.status('等待游戏就绪:请先选好赛道,看到起点画面'); return; }
      if (id !== pvId) { pvId = id; if (ui.onTarget) ui.onTarget(); } // 换了赛道 / 游戏刚就绪:目标预览重算一次
      if (sticky && sticky.id === id) { ui.status(sticky.text); return; }
      const cands = planCandidates(id); const p = cands[0] ?? loadLocal(id); const others = cands.slice(1).map((x) => `${x.from} ${(x.finishFrames / 1000).toFixed(3)} s`);
      ui.status(p ? `本赛道已有方案:${(p.finishFrames / 1000).toFixed(3)} s${p.bundled ? '(内置方案' + (p.name ? ':' + p.name : '') + ',已通过游戏 Verify)' : p.source ? '(本地导入:' + p.source + (p.verified ? ',已通过游戏 Verify)' : ',未验证)') : p.verified ? '(已通过游戏 Verify)' : ''}${others.length ? ' · 另有 ' + others.join('、') : ''}` : '本赛道还没有方案:点击后先取榜单第 1 名的回放并微调(约 ' + Math.max(1, Math.round(polishBudget() / 60)) + ' 分钟),取不到再从零求解;之后自动驾驶,下次直接开');
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
        const tgt = ui.getTarget(); // 目标:最快(默认)/ 名次 / 秒数
        if (tgt.mode !== 'fast' && !(tgt.value >= 1)) { const text = `目标要填 ≥ 1 的整数(${tgt.mode === 'rank' ? '名次' : '秒数'}),或者切回「最快」`; sticky = { id, text }; ui.status(text); return; }
        let plan, tText = ''; // 现成方案够快就直接用;否则取榜单第 1 名回放微调;再不行从零求解(见 obtainPlan);带目标时见 obtainPlanTarget
        try {
          const r = tgt.mode === 'fast' ? await obtainPlan(ui, id) : await obtainPlanTarget(ui, id, tgt); plan = r.plan; tText = r.targetText || '';
          if (r.canceled) { const text = plan ? `已取消微调:方案 ${(plan.finishFrames / 1000).toFixed(3)} s 已存好,再点一次直接开` : '已取消'; sticky = { id, text }; ui.status(text); ui.bar(0); ui.busy('idle'); return; }
        } catch (e) { ui.status('求解失败:' + e.message); ui.log('求解失败: ' + e.message); sticky = { id, text: '求解失败:' + e.message }; ui.bar(0); ui.busy('idle'); return; }
        S.lastPlan = plan; ui.bar(0); ui.busy('drive'); ui.status(plan.ghost ? `自动驾驶:回到起点并出发(用的是${plan.source})` : '自动驾驶:回到起点并出发…');
        const r = await drive(plan, ui);
        const text = r.finished != null ? `完成:${(r.finished / 1000).toFixed(3)} s(方案 ${(plan.finishFrames / 1000).toFixed(3)} s)${plan.ghost ? `\n开的是榜单第 ${fmtN(plan.rank)} 名的回放(别人的成绩,不是自己的方案)` : ''}${tText ? '\n' + tText : ''}` : '已停止';
        sticky = { id, text }; ui.status(text);
        ui.bar(r.finished != null ? 100 : 0);
      } catch (e) { ui.status('出错:' + e.message); ui.log('出错: ' + e.message); sticky = { id: curTrackId(), text: '出错:' + e.message }; ui.bar(0); }
      finally { running = false; ui.busy('idle'); }
    };
    // ---- 目标预览:改了名次 / 秒数(或切换类型)后过一会儿按榜单算一下,告诉用户对应多少秒 / 第几名、会用哪条方案(榜单读不到就只提示) ----
    let pvSeq = 0, pvTimer = 0;
    ui.onTarget = () => {
      clearTimeout(pvTimer); const my = ++pvSeq, t = ui.getTarget();
      if (t.mode === 'fast') { ui.targetNote(''); return; }
      if (!(t.value >= 1)) { ui.targetNote(t.mode === 'rank' ? '填一个整数名次,例如 50' : '填一个整数秒数,例如 23'); return; }
      ui.targetNote('算榜单上的位置…');
      pvTimer = setTimeout(async () => {
        try {
          const id = curTrackId(), src = primaryIdx(); if (!id || src < 0) { ui.targetNote('等游戏就绪(选好赛道、看到起点画面)后点开始时再算'); return; }
          if (running || S.solving || S.driving) { ui.targetNote(''); return; }
          const r = await resolveTargetFor(id, src, t); if (my !== pvSeq) return;
          const have = planCandidates(id)[0] ?? null;
          ui.targetNote(`${targetText(r)}\n${targetPlanText(RANK.chooseForTarget(have ? have.finishFrames : null, r), r, have)}`);
        } catch (e) { if (my === pvSeq) ui.targetNote('榜单读不到(' + String(e.message || e).slice(0, 40) + '),点开始时会再试'); }
      }, 700);
    };
    ui.onTarget();
    const paintGd = () => { const b = ui.$('gd'); b.title = '引导线:' + (S.guideOn ? '开(点击关闭)' : '关(点击打开)'); b.classList.toggle('off', !S.guideOn); };
    paintGd();
    ui.$('gd').addEventListener('click', () => {
      S.guideOn = !S.guideOn; try { localStorage.setItem('ptai:guide', S.guideOn ? '1' : '0'); } catch { /* ignore */ }
      if (GUIDEUI) GUIDEUI.setEnabled(S.guideOn); if (S.guideOn && S.driving && S.guideStart) S.guideStart(); paintGd();
    });
    if (GUIDEUI) GUIDEUI.setEnabled(S.guideOn);
    { const nm = (c) => ({ Backquote: '`', Backslash: '\\', Space: '␣' }[c] ?? String(c).replace(/^(Key|Digit)/, '')); ui.$('kk').textContent = nm(HOTKEYS.drive[0]); } // 按钮右侧的热键提示跟着 HOTKEYS 走
    ui.$('go').addEventListener('click', () => trigger());
    installHotkeys(ui, () => trigger());
    installInputLock();
    ui.$('clr').addEventListener('click', () => { const id = curTrackId(); if (id) { clearPlan(id); ui.log('已清除本赛道缓存'); } });
    ui.$('cp').addEventListener('click', async () => { const id = curTrackId(); const p = id && loadPlan(id); if (!p) { ui.log('本赛道还没有方案'); return; } try { await navigator.clipboard.writeText(p.recording); ui.log('回放串已复制'); } catch { ui.log('复制失败(浏览器不允许)'); } });
    window.__ptai = { PT, S, prepareGuide, solve: (o) => solve(ui, o), obtainPlan: (id) => obtainPlan(ui, id ?? curTrackId()), obtainPlanTarget: (tgt, id) => obtainPlanTarget(ui, id ?? curTrackId(), tgt), resolveTargetFor: (tgt, id) => resolveTargetFor(id ?? curTrackId(), primaryIdx(), tgt), fetchTop1, trackId64: () => trackId64(primaryIdx(), curTrackId()), planCandidates, drive: (p) => drive(p, ui), loadPlan, savePlan, curTrackId, primaryIdx, ui };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
