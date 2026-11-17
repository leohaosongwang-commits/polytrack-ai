// 端到端测试"页面内自动驾驶":用本机 Chrome 打开正版页面(https://app-polytrack.kodub.com/0.6.3/),
// 像扩展一样在文档开始时注入 extension/autopilot.js,点面板上的按钮,等结果。
// 用法:node scripts/test_extension.mjs [--track scripts/data/slalom.txt | --game-track summer3] [--plan out/mac_slalom.json] [--headed] [--shots 目录 [--shot-every 4]] [--timeout 600] [--no-click]
//   --track  用我们自己的赛道替换官方默认赛道(只在内存里替换);不给则用官方 Summer 1
//   --plan   把这份结果 JSON 预先放进缓存(跳过求解,直接测自动驾驶);不给则点击后在页面里求解
//   --lb-mock 方案.json   扩展的"取榜单第 1 名回放"读到的是这份方案(完成帧 + 回放串),不联网;不给则榜单请求照旧全部 abort(= 榜单读不到,走旧流程)
//   --lb-live             榜单两个只读接口(/v6/leaderboard、/v6/recordings 的 GET)放行到真实服务器,其余一律 abort
//   --build 路径          用另一份构建产物(例如 build_extension.mjs --public --no-bundled --out 生成的"没有任何现成方案"版)
//   --polish 秒           把页面内微调的预算改成这么多秒(默认 120);0 = 只取榜单回放、不微调
//   --dsf N               截图的设备像素比(默认 1;看面板细节用 2)。--shots 目录 时每个阶段额外截一张只含面板的图(panel_*.png)
//   --lb-total N          配合 --lb-mock:榜单假装有 N 个人、每个人的成绩 = 这份方案的完成帧(全部并列);按下标取(skip / amount)都能答,用来测"目标名次 / 目标秒数"。默认 1
//   --target 名次:50 | 秒数:23 | rank:50 | sec:23   点击前在面板上选好目标(走真实的 DOM:点「名次」/「秒数」、往输入框里填数、触发 input),并打印预览文字和目标流程结束后缓存里的方案(带目标时不该改缓存)
//   --twice               第一次完成后在同一页再点一次(回起点后再开):应当直接用刚存进缓存的方案、不再取榜单 / 微调;并打印缓存里的方案
// 为了不向游戏服务器发任何东西:测试里对 vps.kodub.com 的请求一律 abort(只有上面两个榜单只读 GET 在 --lb-mock / --lb-live 下例外),并统计页面**尝试**发出的写入类请求(扩展本身不拦截网络,所以游戏自己的成绩上传会被尝试,但全部被这里的 route.abort() 拦下,没有一个真的到达服务器)。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GAME_BASE = 'https://app-polytrack.kodub.com/0.6.3/';
function loadPlaywright() { for (const base of [process.cwd() + '/', '/home/user/', import.meta.url]) { try { return createRequire(base)('playwright'); } catch { /* next */ } } throw new Error('playwright not found'); }
const { chromium } = loadPlaywright();

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const track = a.track ? fs.readFileSync(a.track, 'utf8').trim() : null;
const timeoutS = Number(a.timeout ?? 600);

const browser = await chromium.launch({ ...(process.env.PT_CHROME === '' ? {} : { channel: 'chrome' }), headless: !a.headed, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: Number(a.width ?? 1280), height: Number(a.height ?? 720) }, deviceScaleFactor: Number(a.dsf ?? 1) });
let vpsWrites = 0; const vpsSeen = [];
const lbMock = a['lb-mock'] ? (() => { const j0 = JSON.parse(fs.readFileSync(a['lb-mock'], 'utf8')); return j0.plan ?? j0; })() : null;
const CORS = { 'access-control-allow-origin': '*' };
await ctx.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url());
  if (u.hostname === 'vps.kodub.com') {
    vpsSeen.push(req.method() + ' ' + u.pathname + (u.pathname.endsWith('/leaderboard') ? ' trackId=' + (u.searchParams.get('trackId') || '').slice(0, 12) : ''));
    if (req.method() !== 'GET') vpsWrites++;
    const readOnlyLb = req.method() === 'GET' && (u.pathname === '/v6/leaderboard' || u.pathname === '/v6/recordings');
    if (readOnlyLb && lbMock) {
      if (u.pathname === '/v6/leaderboard') { const total = Math.max(1, Number(a['lb-total'] ?? 1)), skip = Math.max(0, Number(u.searchParams.get('skip') || 0)), amt = Math.max(1, Math.min(10, Number(u.searchParams.get('amount') || 1))); const entries = []; for (let i = skip; i < Math.min(total, skip + amt); i++) entries.push({ id: 'mock-' + (i + 1), nickname: 'mock', frames: lbMock.finishFrames, verifiedState: 1 }); return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ total, entries, userEntry: null }) }); }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify([{ recording: lbMock.recording }]) });
    }
    if (readOnlyLb && a['lb-live']) return route.continue();
    return route.abort();
  }
  if (!req.url().startsWith(GAME_BASE)) return route.abort();
  if (track && req.url().split('?')[0].endsWith('tracks/official/summer1.track')) return route.fulfill({ status: 200, contentType: 'text/plain', body: track });
  if (a['game-track'] && req.url().split('?')[0].endsWith('tracks/official/summer1.track')) return route.fulfill({ response: await route.fetch({ url: GAME_BASE + 'tracks/official/' + a['game-track'] + '.track' }) }); // 用官方的另一条赛道顶替 summer1(只在内存里转手)
  return route.continue();
});
await ctx.addInitScript({ content: fs.readFileSync(a.build && a.build !== true ? a.build : path.join(ROOT, 'extension/autopilot.js'), 'utf8') });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error' || /ptai|PolyTrack AI/.test(m.text())) console.log('[console.' + m.type() + ']', m.text().slice(0, 200)); });
await page.goto(GAME_BASE, { waitUntil: 'load', timeout: 90000 });
const ui = async (js) => page.evaluate(js);
const t0 = Date.now();
for (;;) { // 等面板和游戏就绪
  const r = await ui(() => window.__ptai ? { id: window.__ptai.curTrackId(), idx: window.__ptai.primaryIdx() } : null).catch(() => null);
  if (r && r.idx >= 0) { console.log('面板已注入,游戏就绪,赛道 id', r.id); break; }
  if (Date.now() - t0 > 90000) { console.log('游戏没有就绪', JSON.stringify(errors)); await browser.close(); process.exit(1); }
  await new Promise((r2) => setTimeout(r2, 300));
}
if (a.shots) fs.mkdirSync(a.shots, { recursive: true });
const shot = async (name) => { if (a.shots) await page.screenshot({ path: path.join(a.shots, name + '.png') }).catch(() => {}); };
const shotPanel = async (name) => { if (!a.shots) return; const r = await ui(() => { const b = window.__ptai.ui.$('box').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }).catch(() => null); if (r) await page.screenshot({ path: path.join(a.shots, 'panel_' + name + '.png'), clip: { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.width + 12, height: r.height + 12 } }).catch(() => {}); };
await shot('00_ready'); await shotPanel('00_ready');
if (a.plan) {
  const j0 = JSON.parse(fs.readFileSync(a.plan, 'utf8')); const j = j0.plan ?? j0; // make_local_plan.mjs 的输出({key, plan})或 solve.mjs 的结果 JSON 都行
  await page.evaluate((p) => window.__ptai.savePlan(window.__ptai.curTrackId(), { v: 1, finishFrames: p.finishFrames, toggles: p.toggles, recording: p.recording, verified: true, solvedAt: Date.now(), ...(p.source ? { source: p.source } : {}) }), j);
  console.log('已把', a.plan, '放进缓存(', j.finishFrames, '帧 )');
}
await new Promise((r2) => setTimeout(r2, 1500)); // 等面板的 1 s 刷新一轮
console.log('面板:', JSON.stringify(await page.evaluate(() => ({ status: window.__ptai.ui.$('st').textContent, footer: window.__ptai.ui.$('ft').textContent }))));
if (a['no-click']) { await browser.close(); process.exit(0); }
async function clickAndWait(label) {
  await page.locator('#ptai-panel button#go').click();
  console.log('已点击「一键自动驾驶」' + label);
  let lastSt = ''; let n = 0; const tStart = Date.now();
  for (;;) {
    await new Promise((r2) => setTimeout(r2, 1500));
    const st = await ui(() => ({ st: window.__ptai.ui.$('st').textContent, log: window.__ptai.ui.$('log').textContent.split('\n').slice(-2).join(' | ') })).catch(() => null);
    if (!st) continue;
    if (st.st !== lastSt) { console.log(`[${((Date.now() - tStart) / 1000).toFixed(0)}s] ${st.st}   (${st.log})`); lastSt = st.st; }
    if (a.shots && n++ % Number(a['shot-every'] ?? 4) === 0) { await shot(label.replace(/\W/g, '') + 'run_' + String(n).padStart(3, '0')); await shotPanel(label.replace(/\W/g, '') + 'run_' + String(n).padStart(3, '0')); }
    if (/^完成|^求解失败|^出错|^已停止|^已取消/.test(st.st)) return st.st;
    if ((Date.now() - tStart) / 1000 > timeoutS) return 'timeout';
  }
}
if (a.target) { // 在面板上选好目标:点「名次」/「秒数」,往输入框里填数(和真人操作走同一条 DOM 路径)
  const [m0, v] = String(a.target).split(':'); const m = { 名次: 'rank', 秒数: 'sec' }[m0] ?? m0;
  { // 真实鼠标 + 键盘:点「名次」、点输入框、打 a1x2w3(字母要被滤掉;按键不能冒泡到游戏在 window 上的监听),Enter 退出输入
    await page.evaluate(() => { window.__gotKeys = []; window.addEventListener('keydown', (e) => window.__gotKeys.push(e.key)); });
    await page.locator('#ptai-panel #seg button[data-m="rank"]').click(); await page.locator('#ptai-panel #tv').click(); await page.keyboard.type('a1x2w3'); 
    const typed = await page.evaluate(() => ({ value: window.__ptai.ui.$('tv').value, saved: localStorage.getItem('ptai:target'), reachedWindow: window.__gotKeys.join('') }));
    await page.keyboard.press('Enter'); const afterEnter = await page.evaluate(() => ({ focused: !!window.__ptai.ui.root.activeElement, gotKeys: window.__gotKeys.join('') }));
    console.log('真实键盘输入:', JSON.stringify(typed), '期望 value=123 且没有按键冒泡到 window;Enter 后', JSON.stringify(afterEnter), '(期望 focused=false)');
  }
  await page.evaluate(([m, v]) => { const u = window.__ptai.ui; u.$('seg').querySelector(`[data-m=${m}]`).click(); if (m !== 'fast') { const inp = u.$('tv'); inp.value = v; inp.dispatchEvent(new Event('input')); } }, [m, v]);
  await new Promise((r2) => setTimeout(r2, 4000)); // 等预览(700 ms 防抖 + 榜单请求)
  console.log('目标预览:', JSON.stringify(await page.evaluate(() => ({ target: window.__ptai.ui.getTarget(), note: window.__ptai.ui.$('tn').textContent, panel: window.__ptai.ui.$('tg').className })))); 
}
await page.evaluate((p) => { window.__ptai.S.debugKeys = true; if (p != null) window.__ptai.S.polishSeconds = Number(p); }, a.polish ?? null); // 记录每个循环里 物理侧按键位 与 方案按键位,结束后核对按键显示的数据源
await page.evaluate(() => { const u = window.__ptai.ui; window.__pgLog = []; const t0 = performance.now(); setInterval(() => window.__pgLog.push({ t: Math.round(performance.now() - t0), pc: u.$('pc').textContent, pl: u.$('pl').textContent, pt: u.$('pt').textContent, chips: u.$('chips').textContent, ind: u.$('trk').classList.contains('ind'), w: u.$('bar').style.width, dot: u.$('dot').dataset.s, st: u.$('st').textContent }), 250); });
let outcome = await clickAndWait('');
if (a.twice && /^完成/.test(outcome)) {
  const cached = await ui(() => { const id = window.__ptai.curTrackId(); const raw = localStorage.getItem('ptai1:' + id); const p = raw ? JSON.parse(raw) : null; return p ? { finishFrames: p.finishFrames, verified: p.verified, source: p.source } : null; });
  console.log('第一次之后缓存里的方案:', JSON.stringify(cached)); vpsSeen.length = 0;
  await new Promise((r2) => setTimeout(r2, 1500)); const o2 = await clickAndWait('(第二次:先按 T 回起点)'); outcome = outcome + ' | 第二次: ' + o2;
  console.log('第二次的日志:', (await ui(() => window.__ptai.ui.$('log').textContent)).replace(/\n/g, ' | '), '| 第二次期间的榜单请求:', JSON.stringify(vpsSeen));
}
if (a.target) console.log('目标流程之后缓存里的方案:', JSON.stringify(await ui(() => { const id = window.__ptai.curTrackId(); const raw = localStorage.getItem('ptai1:' + id); const p = raw ? JSON.parse(raw) : null; return p ? { finishFrames: p.finishFrames, source: p.source, ghost: !!p.ghost } : null; })), '| 状态栏:', JSON.stringify(await ui(() => window.__ptai.ui.$('st').textContent)));
await shot('99_final'); await shotPanel('99_final');
{ // 进度条核对:阶段内百分比不倒退、读榜单时是不定长条、求解 / 微调结束到 100%、结束后收起
  const L = await ui(() => window.__pgLog.slice()); const num = (x) => (x.pc ? parseInt(x.pc, 10) : null);
  const seg = []; for (const x of L) { const k = x.ind ? '不定长:' + x.pl : x.pl; if (!k) continue; const last = seg[seg.length - 1]; if (last && last.k === k) { last.n++; last.hi = Math.max(last.hi, num(x) ?? -1); last.lo = Math.min(last.lo, num(x) ?? 1e9); last.pt = x.pt || last.pt; last.chips = x.chips || last.chips; last.back = last.back || (num(x) != null && last.prev != null && num(x) < last.prev); last.prev = num(x) ?? last.prev; } else seg.push({ k, n: 1, lo: num(x) ?? 1e9, hi: num(x) ?? -1, pt: x.pt, chips: x.chips, back: false, prev: num(x) }); }
  console.log('进度条采样(250 ms 一次,共 ' + L.length + ' 次),按阶段:'); for (const g of seg) console.log(`  ${g.k.padEnd(18)} ${String(g.n).padStart(4)} 次  ${g.lo > 1e8 ? '-' : g.lo}% ~ ${g.hi < 0 ? '-' : g.hi}%${g.back ? '  (有倒退!)' : ''}  ${g.chips ? '[' + g.chips + ']' : ''} ${g.pt ? '「' + g.pt + '」' : ''}`);
  const dots = [...new Set(L.map((x) => x.dot))]; console.log('状态点出现过:', dots.join(','), '| 最后一次采样:', JSON.stringify(L[L.length - 1] ?? null));
}
// 按键显示核对:物理侧实际收到的按键位 ctl 应当和方案在该帧(允许 ±1 帧的边沿)按住的键一致
const kd = await ui(() => { const id = window.__ptai.curTrackId(); const p = window.__ptai.loadPlan(id); return { log: window.__ptai.S.keyLog || [], toggles: (window.__ptai.S.lastPlan ?? p)?.toggles ?? null }; });
const pm = (tg, f) => { let m = 0; for (let ki = 0; ki < 5; ki++) { const t = tg[ki] || []; let n = 0; while (n < t.length && t[n] <= f) n++; if (n & 1) m |= 1 << ki; } return m; };
let keyOk = 0, keyBad = 0, keyUsed = new Set(), badEx = [];
if (kd.toggles) for (const [f, ctl] of kd.log) { if ([-2, -1, 0, 1].some((d) => pm(kd.toggles, f + d) === ctl)) keyOk++; else { keyBad++; if (badEx.length < 5) badEx.push([f, ctl, pm(kd.toggles, f)]); } keyUsed.add(ctl); }
const kp = await ui(() => { const r = window.__ptai.ui.root; return { keyCaps: ['up', 'right', 'down', 'left'].map((k) => r.getElementById('k_' + k) ? 1 : 0).join(''), boxHidden: !r.getElementById('keys').classList.contains('on') }; });
console.log('按键显示:循环采样', kd.log.length, '次,与方案一致', keyOk, '不一致', keyBad, '出现过的按键组合', [...keyUsed].sort((x, y) => x - y).join(','), '键帽元素', kp.keyCaps, '结束后已隐藏', kp.boxHidden, badEx.length ? JSON.stringify(badEx) : '');
console.log(JSON.stringify({ outcome, pageErrors: errors.slice(0, 3), vpsWriteRequestsAttemptedAllAborted: vpsWrites, vpsSeen: vpsSeen.slice(0, 6) }));
await new Promise((r2) => setTimeout(r2, Number(a.hold ?? 3) * 1000));
await browser.close();
process.exit(/^完成/.test(outcome) && !/第二次: (?!完成)/.test(outcome) ? 0 : 1);
