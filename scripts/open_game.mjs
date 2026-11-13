// 开一个"已经装好扩展"的独立浏览器窗口,打开正版 PolyTrack 0.6.3 页面。
// 为什么需要它:没有任何脚本能往你日常的 Chrome 配置里装扩展("加载已解压的扩展程序"只能手动点);
// 而且正式版 Google Chrome(≥137,实测 157)已经忽略命令行的 --load-extension,所以这里默认用 Playwright 自带的 Chromium
// (需要先 `npx playwright install chromium` 下载一次)。用单独的配置目录(默认 ~/Library/Application Support/PolytrackAI-Chrome,
// 不碰你日常的 Chrome 配置、登录和扩展),把 extension/ 加载进去。窗口关掉,脚本就退出。
// PT_CHROME=1 改用本机 Google Chrome —— 实测它不会加载扩展(--check 会报失败),仅留作对照。
// 用法:node scripts/open_game.mjs [--check] [--profile 目录] [--url 地址]
//   --check  只检查扩展是否注入成功(面板、Worker 包装),打印结果后自动关闭
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../extension');
function loadPlaywright() { for (const base of [process.cwd() + '/', '/opt/homebrew/lib/node_modules/@playwright/mcp/', import.meta.url]) { try { return createRequire(base)('playwright'); } catch { /* next */ } } throw new Error('找不到 playwright(npm i -g playwright 或设 NODE_PATH)'); }
const { chromium } = loadPlaywright();

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const profile = a.profile && a.profile !== true ? a.profile : path.join(os.homedir(), 'Library/Application Support/PolytrackAI-Chrome');
const url = a.url && a.url !== true ? a.url : 'https://app-polytrack.kodub.com/0.6.3/';
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error('找不到 ' + EXT + '/manifest.json');
fs.mkdirSync(profile, { recursive: true });

let ctx; try { ctx = await chromium.launchPersistentContext(profile, {
  ...(process.env.PT_CHROME ? { channel: 'chrome' } : {}), headless: false, viewport: null,
  ignoreDefaultArgs: ['--disable-extensions'], // Playwright 默认会禁用扩展
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--autoplay-policy=no-user-gesture-required'],
}); } catch (e) { console.error('启动失败:' + String(e.message).split('\n')[0] + '\n(没装 Chromium 的话先运行:npx playwright install chromium)'); process.exit(2); }
const page = ctx.pages()[0] ?? await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
await page.goto(url, { waitUntil: 'load', timeout: 90000 });

if (a.check) {
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({ ptai: typeof window.__ptai, panel: !!document.getElementById('ptai-panel'), workerPatched: !/\[native code\]/.test(String(window.Worker)), cfg: !!window.__ptCfg, primary: window.__ptai ? window.__ptai.primaryIdx() : null }));
  console.log(JSON.stringify({ ...r, pageErrors: errs.slice(0, 3), extensions: ctx.serviceWorkers().length }));
  await ctx.close();
  process.exit(r.ptai === 'object' && r.panel ? 0 : 1);
}
console.log('已打开带扩展的 Chrome 窗口(独立配置:' + profile + ')。关掉窗口即退出。');
ctx.on('close', () => process.exit(0));
await new Promise(() => {});
