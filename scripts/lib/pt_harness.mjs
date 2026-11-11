// PolyTrack 0.6.3 阶段 0 harness:Playwright + Chromium + 虚拟时钟 + Worker 旁路观察。
// 不保存、不分发任何游戏文件:物理 Worker 脚本在运行时从官网拉取,在内存里前置我们的时钟垫片后交给浏览器。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { EVAL_CASES } from './eval_patch.js';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const base of [process.cwd() + '/', '/home/user/', import.meta.url]) {
    try { return createRequire(base)('playwright'); } catch { /* try next */ }
  }
  throw new Error('playwright not found');
}
const { chromium } = loadPlaywright();
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GAME_BASE = 'https://app-polytrack.kodub.com/0.6.3/';
const WORKER_SHIM = fs.readFileSync(path.join(HERE, 'worker_shim.js'), 'utf8');
const PAGE_SHIM = fs.readFileSync(path.join(HERE, 'page_shim.js'), 'utf8');

let workerSrcCache = null;
function fetchWorkerSource() {
  if (workerSrcCache) return workerSrcCache;
  // 用 curl(已配置好代理/CA)在内存里取一次,不写盘
  workerSrcCache = execFileSync('curl', ['-sS', '--fail', '-m', '120', GAME_BASE + 'simulation_worker.bundle.js'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  return workerSrcCache;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 仅分析用:在内存里给 Worker 脚本打两处小补丁,把赛道解析类 Ko 与部件表 ho 暴露到 self,便于用游戏自己的解析器读取赛道。 */
function exposeInternals(src) {
  const a = 'const Ko=class{constructor(t,e){Oo.add(this)';
  const b = 'const uo=ho.filter(';
  if (!src.includes(a) || !src.includes(b)) throw new Error('worker source layout changed; update exposeInternals');
  return src.replace(a, 'const Ko=self.__Ko=class{constructor(t,e){Oo.add(this)').replace(b, 'self.__ho=ho;const uo=ho.filter(');
}

/** 批量评估引擎补丁(内存中):给 Worker 增加 Prepare/Eval 两条消息,见 eval_patch.js */
function addEvalEngine(src) {
  const a = 'case Ki.TestDeterminism:{';
  if (src.split(a).length !== 2) throw new Error('worker source layout changed; update addEvalEngine');
  return src.replace(a, EVAL_CASES + a);
}

export async function launchGame({ viewport = { width: 640, height: 360 }, mainVirtual = false, sampleEvery = 0, keepAll = false, keepRecording = true, patchWorker = true, quiet = true, exposeTrack = false, customTrack = null } = {}) {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => { if (!quiet && m.type() === 'error') console.log('[page console.error]', m.text().slice(0, 200)); });
  // 只允许访问游戏静态资源主机;排行榜/用户服务(vps.kodub.com)一律拒绝——实验永远不上传任何成绩。
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.startsWith(GAME_BASE)) return route.abort();
    // 可选:用我们自己生成的赛道导出串替换首次自动加载的官方赛道文件(仅内存中,不落盘游戏数据)
    if (customTrack && url.split('?')[0].endsWith('tracks/official/summer1.track')) return route.fulfill({ status: 200, contentType: 'text/plain', body: customTrack });
    if (patchWorker && url.split('?')[0].endsWith('simulation_worker.bundle.js')) {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: WORKER_SHIM + '\n' + addEvalEngine(exposeTrack ? exposeInternals(fetchWorkerSource()) : fetchWorkerSource()) });
    }
    return route.continue();
  });
  await page.addInitScript({ content: `window.__ptCfg = ${JSON.stringify({ mainVirtual, sampleEvery, keepAll, keepRecording })};\n${PAGE_SHIM}` });
  await page.goto(GAME_BASE, { waitUntil: 'load', timeout: 90000 });
  const g = new Game(browser, page, errors); g.mainVirtual = mainVirtual;
  await g.waitReady();
  return g;
}

class Game {
  constructor(browser, page, errors) { this.browser = browser; this.page = page; this.errors = errors; this.rt = null; }
  async waitReady(timeoutMs = 90000) {
    const t0 = Date.now();
    for (;;) {
      const r = await this.page.evaluate(() => {
        const P = window.__pt; if (!P) return null;
        const i = P.meta.findIndex((m) => m.realtime === true && m.creates.length > 0);
        return i >= 0 ? { idx: i, carId: P.meta[i].creates[P.meta[i].creates.length - 1].carId, nWorkers: P.meta.length } : null;
      });
      if (r) { this.rt = r.idx; this.carId = r.carId; return r; }
      if (Date.now() - t0 > timeoutMs) throw new Error('game not ready: ' + JSON.stringify(this.errors));
      await sleep(250);
    }
  }
  /** 以固定步长 step(ms) 推进 Worker 虚拟时钟 ms 毫秒;返回 {wallMs} */
  async advance(ms, step = 1000 / 60) {
    const t = performance.now();
    await this.page.evaluate(([i, ms, step]) => window.__pt.advance(i, ms, step), [this.rt, ms, step]);
    return { wallMs: performance.now() - t };
  }
  async mainTick(n, dtMs = 1000 / 60) { return this.page.evaluate(([n, d]) => window.__pt.mainTick(n, d), [n, dtMs]); }
  async car() { return this.page.evaluate((i) => window.__pt.getCar(i), this.rt); }
  async latestCarId() { return this.page.evaluate((i) => window.__pt.cur(i), this.rt); }
  async runsCount() { return this.page.evaluate((i) => window.__pt.meta[i].creates.length, this.rt); }
  async peek() { return this.page.evaluate((i) => window.__pt.peek(i), this.rt); }
  async last() { const c = await this.car(); return c?.last ?? null; }
  async snapshot() { return this.page.evaluate((i) => window.__pt.snapshot(i), this.rt); }
  async keyDown(code) { await this.page.keyboard.down(code); }
  async keyUp(code) { await this.page.keyboard.up(code); }
  async controlLog() { return this.page.evaluate((i) => window.__pt.meta[i].ctl, this.rt); }
  async metaOf(idx) { return this.page.evaluate((i) => { const m = window.__pt.meta[i]; return { realtime: m.realtime, nCreates: m.creates.length, cars: Object.keys(m.cars) }; }, idx); }
  /** 用游戏自带 Verify 离线重放一份回放字符串;返回 [{result, wallMs}] */
  async verify(recording, targetFrames, repeat = 1) { return this.page.evaluate(([i, r, t, n]) => window.__pt.verify(i, r, t, n), [this.rt, recording, targetFrames, repeat]); }
  /** 用游戏的非实时回放路径重放,返回逐帧状态行 [frames,x,y,z,speed,cp,ctl,fin](需要 keepAll) */
  async replayStates(recording, targetFrames) { return this.page.evaluate(([i, r, t]) => window.__pt.replay(i, r, t), [this.rt, recording, targetFrames]); }
  async testDeterminism() { return this.page.evaluate((i) => window.__pt.testDeterminism(i), this.rt); }
  /** 需要 exposeTrack:用游戏自己的解析器把赛道存档字符串解析成部件表(位置为格子坐标,世界坐标 = 格子 x 5) */
  async trackInfo() {
    return this.page.evaluate(([i]) => new Promise((resolve) => {
      const P = window.__pt; const id = P.nextId++; P.waiters.set(id, resolve);
      const m = P.meta[i]; const c = m.creates[m.creates.length - 1];
      P.workers[i].postRaw({ __vt: 'track', id, trackData: c.trackData });
    }), [this.rt]);
  }
  /** 需要 exposeTrack:按部件清单生成一条自制赛道;返回 { save, exportString, start } */
  async buildTrack(parts, name = 'Phase0 test') {
    return this.page.evaluate(([i, parts, name]) => new Promise((resolve) => {
      const P = window.__pt; const id = P.nextId++; P.waiters.set(id, resolve);
      const m = P.meta[i]; const c = m.creates[m.creates.length - 1];
      P.workers[i].postRaw({ __vt: 'build', id, baseTrackData: c.trackData, parts, name });
    }), [this.rt, parts, name]);
  }
  /** 需要 exposeTrack:列出全部部件配置(用于设计赛道) */
  async catalog() {
    return this.page.evaluate(([i]) => new Promise((resolve) => {
      const P = window.__pt; const id = P.nextId++; P.waiters.set(id, resolve);
      P.workers[i].postRaw({ __vt: 'catalog', id });
    }), [this.rt]);
  }
  /** 建 n 个离线评估 Worker(各自 Init + Prepare 当前赛道) */
  async makePool(n) { return this.page.evaluate(([i, n]) => window.__pt.makePool(i, n), [this.rt, n]); }
  /** 批量评估控制计划;opts: {seg, tail, maxFrames, sampleEvery};返回与 plans 等长的结果数组 */
  async evalBatch(plans, opts = {}) { return this.page.evaluate(([plans, opts]) => window.__pt.evalBatch(plans, opts), [plans, opts]); }
  /** 把动作序列提交为所有池 Worker 的新基准状态(WASM 快照);返回 {frames, fin, last} */
  async commit(actions, seg, segs = null, reset = false) { return this.page.evaluate(([a, s, ss, r]) => window.__pt.commit(a, s, ss, r), [actions, seg, segs, reset]); }
  async probe() { return this.page.evaluate(() => window.__pt.probe()); }
  async close() { await this.browser.close(); }
}
export { Game };
