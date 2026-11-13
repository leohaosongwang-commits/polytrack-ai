// 命令行:对一条赛道做离线搜索,输出回放串 + JSON 报告,并用游戏自带的 Verify 校验。
// 用法:node scripts/solve.mjs --track scripts/data/slalom.txt --out out/slalom [--seconds 60] [--workers 4] [--seed 1]
//        [--segs 40x6,100x6,240x4] [--crash 0] [--pop 96] [--iters 3] [--commit 6] [--polish-iters N] [--no-polish] [--resume prev.json] [--tumble 30] [--max-rollbacks 12] [--slow] [--prefix 失败现场.json --prefix-frames N] [--look 0.6] [--actions W,WL,WR,S,SL,SR] [--trace]
//        [--crash-stop 窗口帧,掉速km/h,最低速km/h](默认开 50,25,60;--no-crash-stop 关)  [--carry-mass 0.8](默认 0.8;旧版 0.55)
//        实验性(默认关):[--repair 4](停滞时屏蔽势场认为走得通的路线)  [--local-rollback 90](停滞时按进度局部回退 N 米,而不是固定退 8000 帧)  [--refine 2 [--refine-window 250](压圈速:窗口版 = 按弧长每 250 m 一个窗口重规划、接回原路线尾巴、不比原来快就丢弃,N 遍;不给窗口 = 整圈重规划 N 轮;把当前最好的一圈当势场 + 速度门槛,用规划器重规划,最多 N 轮;--ref-lap 结果.json 直接用已有的一圈当起点;--ref-halfwidth 6 --speed-pen 0.3 --speed-slack 0.9)] [--explore [--explore-seconds 600 --explore-pop 96 --explore-h 24 --explore-seg 60 --explore-extra 0 --explore-resume 上次的.frontier.json]](Go-Explore 式探索代替滚动时域规划,找任意一条冲线路线再打磨)  [--recover-extra 250x8](停滞重规划后的 --stall-recover 帧内多看这些时长的视野)
// 注意:本工具只在本地离线运行,不会向游戏服务器上传任何成绩(harness 拒绝所有非静态资源请求)。
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { launchGame } from './lib/pt_harness.mjs';
import { Solver, masksToToggles, togglesToMasks } from './lib/solver.mjs';
import { encodeRecording } from './lib/pt_codec.mjs';
import { exploreLap } from './lib/explorer.mjs';
import { refineWindows, lapPath } from './lib/refine.mjs';

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--no-')) o[a.slice(5)] = false;
    else if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = isNaN(Number(v)) ? v : Number(v); i++; } }
    else o._.push(a);
  }
  return o;
}

/** 从失败现场 / 结果 JSON 里取 committed+durs 的前 F 帧(按整个动作截断),作为"前缀" */
function loadPrefix(file, F) {
  if (!file) return null; const j = JSON.parse(fs.readFileSync(file, 'utf8')); const committed = [], durs = [];
  if (!j.committed) { // 已完成的结果 JSON(只有翻转帧):逐帧掩码截到 F 帧,再按"相同动作的连续段(最长 60 帧)"压成 committed/durs
    const m = togglesToMasks(j.toggles, j.finishFrames); const n = Math.min(F, m.length);
    for (let f = 0; f < n;) { let e = f + 1; while (e < n && m[e] === m[f] && e - f < 60) e++; committed.push(m[f]); durs.push(e - f); f = e; }
    return { committed, durs };
  }
  let f = 0;
  for (let i = 0; i < j.committed.length; i++) { if (f + j.durs[i] > F) break; committed.push(j.committed[i]); durs.push(j.durs[i]); f += j.durs[i]; }
  return { committed, durs };
}

const KEYS = { W: 1, R: 2, S: 4, L: 8, '0': 0 };
/** 'W,WL,WR,S,SL,SR' -> [1,9,3,4,12,6](W=上 R=右 S=下 L=左,可组合) */
export function parseActions(str) { return String(str).split(',').map((t) => [...t.trim().toUpperCase()].reduce((m, c) => m | (KEYS[c] ?? 0), 0)); }

/** '40x8,100x8,200x6' -> [40,...,100,...,200,...] */
export function parseSegs(str) { return str.split(',').flatMap((p) => { const [d, n] = p.split('x'); return Array(Number(n ?? 1)).fill(Number(d)); }); }

export async function solveTrack({ trackFile, gameTrack = null, outBase, seconds = 60, workers = 4, seed = 1, seg = 40, horizon = 20, segs = parseSegs('40x6,100x6,240x4'), pop = 96, iters = 3, commit = 6, polish = true, polishIters = Infinity, crash = 0, potential = 'polyline', halfWidth = 8.5, offPenalty = 15, trace = false, resume = null, slow = false, stallRetries = 6, tumble = 30, maxRollbacks = 12, prefix = null, prefixFrames = Infinity, look = 0.6, actions = null, crashStop = undefined, repair = 0, localRollback = 0, carryMass = undefined, recoverExtra = [], stallRecover = undefined, explore = null, refine = 0, refineWindow = 0, refFlatAir = false, refLap = null, refHalfWidth = 6, speedPen = 0.3, speedSlack = 0.9, log = console.log }) {
  const t0 = Date.now();
  const track = trackFile ? fs.readFileSync(trackFile, 'utf8').trim() : null;
  const g = await launchGame({ exposeTrack: true, mainVirtual: true, customTrack: track, officialTrack: gameTrack });
  try {
    const mkSolver = (extra = {}) => new Solver(g, { workers, seed, seg, horizon, segs, pop, iters, commitN: commit, trace, crashPenalty: crash, potential, halfWidth, offPenalty, stallRetries, tumblePenalty: tumble, maxRollbacks, lookAhead: look, ...(crashStop !== undefined ? { crashStop } : {}), ...(carryMass !== undefined ? { carryMass } : {}), repairMax: repair, localRollback, recoverExtra, ...(stallRecover !== undefined ? { stallRecoverFrames: stallRecover } : {}), prefix: loadPrefix(prefix, prefixFrames), ...(actions ? { actions } : {}), ...(slow ? {} : { slowSegs: null }), ...extra, log });
    let S = mkSolver();
    await S.init();
    // 基线:一直按住油门
    const [base] = await g.evalBatch([[1]], { seg: 1, tail: 1, maxFrames: 30000, minY: S.minY });
    const baseline = { holdW: { finishFrames: base.fin >= 0 ? base.fin : null, dead: base.dead, progress: S.prog.query(base.last[5], base.last[7], base.last[6], base.last[4]).s } };
    log(`基线(一直按住 W): ${baseline.holdW.finishFrames ?? '未完成(掉出赛道或超时)'}${baseline.holdW.finishFrames ? '' : `, 到达中线进度 ${baseline.holdW.progress.toFixed(0)} m`}`);
    const tPlan = Date.now();
    let A;
    if (resume || refLap) { // 从之前输出的 JSON 里的翻转帧继续(打磨 / 沿参考轨迹压圈速),跳过规划
      const f = resume ?? refLap; const j = JSON.parse(fs.readFileSync(f, 'utf8')); A = { masks: togglesToMasks(j.toggles, j.finishFrames), finishFrames: j.finishFrames };
      log(`跳过规划,从 ${f} 继续(${j.finishFrames} 帧)`);
    } else if (explore) {
      log('阶段 A:Go-Explore 式探索(档案 + 随机展开,不依赖势场的"可行"判断)');
      A = await exploreLap(S, { ...explore, log, onFrontier: outBase ? (j) => { fs.mkdirSync(path.dirname(outBase), { recursive: true }); fs.writeFileSync(outBase + '.frontier.json', JSON.stringify(j)); } : null });
    } else {
      log('阶段 A:滚动时域规划(CEM + WASM 快照)');
      A = await S.plan();
    }
    const finA = await S.finishOf(A.masks);
    log(`规划结果: ${A.finishFrames} 帧 (从起点整圈复核: ${finA}), 用时 ${((Date.now() - tPlan) / 1000).toFixed(1)}s`);
    let masks = A.masks, fin = finA, polished = null; const refineLog = [];
    // 压圈速:把当前最好的一圈的轨迹当势场(+ 速度门槛),用滚动时域规划器重新规划一遍;更快就换成它,再来一轮(以新的一圈为参考)。
    if (refine > 0 && refineWindow > 0 && fin > 0) { // 窗口版(不会变差;长赛道 / 有长跳的赛道用这个)
      const S2 = mkSolver({ potential: 'trajectory', refPath: await lapPath(g, masks), speedPen, speedSlack, halfWidth: refHalfWidth, refFlatAir });
      await S2.init(); const tR = Date.now();
      const R = await refineWindows(g, S2, masks, fin, { windowM: refineWindow, passes: refine, log, cancel: null });
      log(`  [压圈速] 窗口版结束:${fin} -> ${R.fin} 帧(${((fin - R.fin) / 1000).toFixed(3)} s),用时 ${((Date.now() - tR) / 1000).toFixed(0)}s`);
      refineLog.push(...R.log); masks = R.masks; fin = R.fin; S = S2;
    }
    for (let round = 1; round <= refine && fin > 0 && !refineWindow; round++) {
      const tR = Date.now();
      const refPts = await lapPath(g, masks);
      const S2 = mkSolver({ potential: 'trajectory', refPath: refPts, speedPen, speedSlack, halfWidth: refHalfWidth, refFlatAir, stallRetries: 2, stallTotalMax: 2 });
      let A2 = null, fin2 = -1;
      try { await S2.init(); A2 = await S2.plan(); fin2 = await S2.finishOf(A2.masks); } catch (e) { log(`  [压圈速] 第 ${round} 轮规划失败:${String(e.message).slice(0, 100)}`); if (e.partial && outBase) { fs.mkdirSync(path.dirname(outBase), { recursive: true }); fs.writeFileSync(outBase + `.refine${round}.failed.json`, JSON.stringify({ error: e.message, ...e.partial })); } }
      refineLog.push({ round, fin: fin2 > 0 ? fin2 : null, seconds: (Date.now() - tR) / 1000 });
      if (fin2 > 0 && fin2 < fin) { log(`  [压圈速] 第 ${round} 轮:${fin} -> ${fin2} 帧(${((fin - fin2) / 1000).toFixed(3)} s),用时 ${((Date.now() - tR) / 1000).toFixed(0)}s`); masks = A2.masks; fin = fin2; S = S2; }
      else { log(`  [压圈速] 第 ${round} 轮:${fin2 > 0 ? fin2 + ' 帧,不比 ' + fin + ' 帧快' : '没有结果'},停止`); break; }
    }
    if (polish && seconds > 0) {
      log(`阶段 B:窗口爬山打磨 ${Number.isFinite(polishIters) ? polishIters + ' 轮' : seconds + 's'}`);
      polished = await S.polish(masks, fin, { seconds, maxIters: polishIters });
      masks = polished.masks; fin = polished.finishFrames;
      log(`打磨结果: ${fin} 帧 (${polished.generations} 代)`);
    }
    // 校验:游戏自带 Verify(恰好在目标帧完成才为 true)重复 3 次 + ±1 帧对照
    const rec = encodeRecording(Object.fromEntries(['up', 'right', 'down', 'left', 'reset'].map((k, i) => [k, masksToToggles(masks)[i]])));
    const v = await g.verify(rec, fin, 3);
    const vm = await g.verify(rec, fin - 1, 1); const vp = await g.verify(rec, fin + 1, 1);
    const verify = { atFinish: v.map((x) => x.result), minus1: vm[0].result, plus1: vp[0].result };
    const ok = verify.atFinish.every((x) => x === true) && verify.minus1 === false && verify.plus1 === false;
    log(`游戏 Verify: ${JSON.stringify(verify)} => ${ok ? '通过' : '失败'}`);
    const out = {
      track: trackFile ?? '(官方默认赛道)', finishFrames: fin, finishSeconds: fin / 1000, verify, verifyOk: ok,
      baseline, phaseA: { finishFrames: finA, seconds: (Date.now() - tPlan) / 1000 }, refine: refineLog.length ? refineLog : undefined, phaseB: polished ? { finishFrames: fin, generations: polished.generations, history: polished.history } : null,
      params: { workers, seed, seg, horizon, pop, iters, commit, seconds }, wallSeconds: (Date.now() - t0) / 1000, recording: rec,
      toggles: masksToToggles(masks),
    };
    if (outBase) {
      fs.mkdirSync(path.dirname(outBase), { recursive: true });
      fs.writeFileSync(outBase + '.recording.txt', rec + '\n');
      fs.writeFileSync(outBase + '.json', JSON.stringify(out, null, 1));
      log(`已写出 ${outBase}.recording.txt / .json`);
    }
    return out;
  } catch (e) {
    if (e.partial && outBase) { fs.mkdirSync(path.dirname(outBase), { recursive: true }); fs.writeFileSync(outBase + '.failed.json', JSON.stringify({ error: e.message, ...e.partial })); log(`失败现场已写出 ${outBase}.failed.json`); }
    throw e;
  } finally { await g.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = args(process.argv.slice(2));
  if (!a.track && !a.official && !a['game-track']) { console.error('用法: node scripts/solve.mjs --track <导出串文件> | --official | --game-track summer3|winter2|desert4…  --out <输出前缀> [--seconds 60] [--potential polyline|field]'); process.exit(2); }
  const r = await solveTrack({ trackFile: a.official || a['game-track'] ? null : a.track, gameTrack: a['game-track'] ?? null, outBase: a.out, seconds: a.seconds ?? 60, workers: a.workers ?? 4, seed: a.seed ?? 1, seg: a.seg ?? 40, horizon: a.horizon ?? 20, segs: a.segs ? parseSegs(String(a.segs)) : parseSegs('40x6,100x6,240x4'), pop: a.pop ?? 96, iters: a.iters ?? 3, commit: a.commit ?? 6, polish: a.polish !== false, polishIters: a['polish-iters'] ?? Infinity, crash: a.crash ?? 0, potential: a.potential ?? 'field', halfWidth: a['half-width'] ?? 8.5, offPenalty: a['off-penalty'] ?? 15, trace: !!a.trace, resume: a.resume ?? null, slow: a.slow === true, stallRetries: a['stall-retries'] ?? 6, tumble: a.tumble ?? 30, maxRollbacks: a['max-rollbacks'] ?? 12, prefix: a.prefix ?? null, prefixFrames: a['prefix-frames'] ?? Infinity, look: a.look ?? 0.6, actions: a.actions ? parseActions(a.actions) : null, crashStop: a['crash-stop'] === false ? null : a['crash-stop'] ? (([w, drop, minV]) => ({ w, drop, minV }))(String(a['crash-stop']).split(',').map(Number)) : undefined, repair: a.repair ?? 0, localRollback: a['local-rollback'] ?? 0, carryMass: a['carry-mass'], recoverExtra: a['recover-extra'] ? parseSegs(String(a['recover-extra'])) : [], stallRecover: a['stall-recover'], refine: a.refine ?? 0, refFlatAir: !!a['ref-flat-air'],  refineWindow: a['refine-window'] ?? 0, refLap: a['ref-lap'] ?? null, refHalfWidth: a['ref-halfwidth'] ?? 6, speedPen: a['speed-pen'] ?? 0.3, speedSlack: a['speed-slack'] ?? 0.9, explore: a.explore ? { seconds: a['explore-seconds'] ?? 600, pop: a['explore-pop'] ?? 96, H: a['explore-h'] ?? 24, seg: a['explore-seg'] ?? 60, T: a['explore-t'] ?? 60, pNovel: a['explore-novel'] ?? 0.25, airCap: a['explore-air-cap'] ?? 8, staleExp: a['explore-stale'] ?? 1, pStale: a['explore-pstale'] ?? 1, resume: a['explore-resume'] ? JSON.parse(fs.readFileSync(a['explore-resume'], 'utf8')) : null, persist: a['explore-persist'] ?? 0.7, extraSeconds: a['explore-extra'] ?? 0 } : null });
  console.log(`\n结果: ${r.finishFrames} ms (${r.finishSeconds.toFixed(3)} s), Verify ${r.verifyOk ? '通过' : '失败'}`);
  process.exit(r.verifyOk ? 0 : 1);
}
