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
  const S = { driving: false, solving: false, cancel: false, drive: null };
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
  const BUNDLED = __BUNDLED_PLANS__;
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
    } finally { releaseAll(); S.driving = false; S.drive = null; ui.keys(null); }
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
    ui.$('go').addEventListener('click', () => trigger());
    installHotkeys(ui, () => trigger());
    installInputLock();
    ui.$('clr').addEventListener('click', () => { const id = curTrackId(); if (id) { clearPlan(id); ui.log('已清除本赛道缓存'); } });
    ui.$('cp').addEventListener('click', async () => { const id = curTrackId(); const p = id && loadPlan(id); if (!p) { ui.log('本赛道还没有方案'); return; } try { await navigator.clipboard.writeText(p.recording); ui.log('回放串已复制'); } catch { ui.log('复制失败(浏览器不允许)'); } });
    window.__ptai = { PT, S, solve: (o) => solve(ui, o), drive: (p) => drive(p, ui), loadPlan, savePlan, curTrackId, primaryIdx, ui };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
