// 端到端测试"页面内自动驾驶":用本机 Chrome 打开正版页面(https://app-polytrack.kodub.com/0.6.3/),
// 像扩展一样在文档开始时注入 extension/autopilot.js,点面板上的按钮,等结果。
// 用法:node scripts/test_extension.mjs [--track scripts/data/slalom.txt | --game-track summer3] [--plan out/mac_slalom.json] [--headed] [--shots 目录 [--shot-every 4]] [--timeout 600] [--no-click]
//   --track  用我们自己的赛道替换官方默认赛道(只在内存里替换);不给则用官方 Summer 1
//   --plan   把这份结果 JSON 预先放进缓存(跳过求解,直接测自动驾驶);不给则点击后在页面里求解
// 为了不向游戏服务器发任何东西:测试里对 vps.kodub.com 的全部请求一律 abort,并统计页面**尝试**发出的写入类请求(扩展本身不拦截网络,所以游戏自己的成绩上传会被尝试,但全部被这里的 route.abort() 拦下,没有一个真的到达服务器)。
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
const ctx = await browser.newContext({ viewport: { width: Number(a.width ?? 1280), height: Number(a.height ?? 720) } });
let vpsWrites = 0; const vpsSeen = [];
await ctx.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url());
  if (u.hostname === 'vps.kodub.com') { vpsSeen.push(req.method() + ' ' + u.pathname); if (req.method() !== 'GET') vpsWrites++; return route.abort(); }
  if (!req.url().startsWith(GAME_BASE)) return route.abort();
  if (track && req.url().split('?')[0].endsWith('tracks/official/summer1.track')) return route.fulfill({ status: 200, contentType: 'text/plain', body: track });
  if (a['game-track'] && req.url().split('?')[0].endsWith('tracks/official/summer1.track')) return route.fulfill({ response: await route.fetch({ url: GAME_BASE + 'tracks/official/' + a['game-track'] + '.track' }) }); // 用官方的另一条赛道顶替 summer1(只在内存里转手)
  return route.continue();
});
await ctx.addInitScript({ content: fs.readFileSync(path.join(ROOT, 'extension/autopilot.js'), 'utf8') });
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
await shot('00_ready');
if (a.plan) {
  const j0 = JSON.parse(fs.readFileSync(a.plan, 'utf8')); const j = j0.plan ?? j0; // make_local_plan.mjs 的输出({key, plan})或 solve.mjs 的结果 JSON 都行
  await page.evaluate((p) => window.__ptai.savePlan(window.__ptai.curTrackId(), { v: 1, finishFrames: p.finishFrames, toggles: p.toggles, recording: p.recording, verified: true, solvedAt: Date.now(), ...(p.source ? { source: p.source } : {}) }), j);
  console.log('已把', a.plan, '放进缓存(', j.finishFrames, '帧 )');
}
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
    if (a.shots && n++ % Number(a['shot-every'] ?? 4) === 0) await shot(label.replace(/\W/g, '') + 'run_' + String(n).padStart(3, '0'));
    if (/^完成|^求解失败|^出错|^已停止/.test(st.st)) return st.st;
    if ((Date.now() - tStart) / 1000 > timeoutS) return 'timeout';
  }
}
await page.evaluate(() => { window.__ptai.S.debugKeys = true; }); // 记录每个循环里 物理侧按键位 与 方案按键位,结束后核对按键显示的数据源
let outcome = await clickAndWait('');
if (a.twice && /^完成/.test(outcome)) { await new Promise((r2) => setTimeout(r2, 1500)); const o2 = await clickAndWait('(第二次:先按 T 回起点)'); outcome = outcome + ' | 第二次: ' + o2; }
await shot('99_final');
// 按键显示核对:物理侧实际收到的按键位 ctl 应当和方案在该帧(允许 ±1 帧的边沿)按住的键一致
const kd = await ui(() => { const id = window.__ptai.curTrackId(); const p = window.__ptai.loadPlan(id); return { log: window.__ptai.S.keyLog || [], toggles: p ? p.toggles : null }; });
const pm = (tg, f) => { let m = 0; for (let ki = 0; ki < 5; ki++) { const t = tg[ki] || []; let n = 0; while (n < t.length && t[n] <= f) n++; if (n & 1) m |= 1 << ki; } return m; };
let keyOk = 0, keyBad = 0, keyUsed = new Set(), badEx = [];
if (kd.toggles) for (const [f, ctl] of kd.log) { if ([-2, -1, 0, 1].some((d) => pm(kd.toggles, f + d) === ctl)) keyOk++; else { keyBad++; if (badEx.length < 5) badEx.push([f, ctl, pm(kd.toggles, f)]); } keyUsed.add(ctl); }
const kp = await ui(() => { const r = window.__ptai.ui.root; return { keyCaps: ['up', 'right', 'down', 'left'].map((k) => r.getElementById('k_' + k) ? 1 : 0).join(''), boxHidden: !r.getElementById('keys').classList.contains('on') }; });
console.log('按键显示:循环采样', kd.log.length, '次,与方案一致', keyOk, '不一致', keyBad, '出现过的按键组合', [...keyUsed].sort((x, y) => x - y).join(','), '键帽元素', kp.keyCaps, '结束后已隐藏', kp.boxHidden, badEx.length ? JSON.stringify(badEx) : '');
console.log(JSON.stringify({ outcome, pageErrors: errors.slice(0, 3), vpsWriteRequestsAttemptedAllAborted: vpsWrites, vpsSeen: vpsSeen.slice(0, 6) }));
await new Promise((r2) => setTimeout(r2, Number(a.hold ?? 3) * 1000));
await browser.close();
process.exit(/^完成/.test(outcome) && !/第二次: (?!完成)/.test(outcome) ? 0 : 1);
