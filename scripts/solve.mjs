// 命令行:对一条赛道做离线搜索,输出回放串 + JSON 报告,并用游戏自带的 Verify 校验。
// 用法:node scripts/solve.mjs --track scripts/data/slalom.txt --out out/slalom [--seconds 60] [--workers 4] [--seed 1]
//        [--segs 40x6,100x6,240x4] [--crash 0] [--pop 96] [--iters 3] [--commit 6] [--polish-iters N] [--no-polish] [--resume prev.json] [--trace]
// 注意:本工具只在本地离线运行,不会向游戏服务器上传任何成绩(harness 拒绝所有非静态资源请求)。
import fs from 'node:fs';
import path from 'node:path';
import { launchGame } from './lib/pt_harness.mjs';
import { Solver, masksToToggles, togglesToMasks } from './lib/solver.mjs';
import { encodeRecording } from './lib/pt_codec.mjs';

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

/** '40x8,100x8,200x6' -> [40,...,100,...,200,...] */
export function parseSegs(str) { return str.split(',').flatMap((p) => { const [d, n] = p.split('x'); return Array(Number(n ?? 1)).fill(Number(d)); }); }

export async function solveTrack({ trackFile, outBase, seconds = 60, workers = 4, seed = 1, seg = 40, horizon = 20, segs = parseSegs('40x6,100x6,240x4'), pop = 96, iters = 3, commit = 6, polish = true, polishIters = Infinity, crash = 0, potential = 'polyline', halfWidth = 8.5, offPenalty = 15, trace = false, resume = null, log = console.log }) {
  const t0 = Date.now();
  const track = trackFile ? fs.readFileSync(trackFile, 'utf8').trim() : null;
  const g = await launchGame({ exposeTrack: true, mainVirtual: true, customTrack: track });
  try {
    const S = new Solver(g, { workers, seed, seg, horizon, segs, pop, iters, commitN: commit, trace, crashPenalty: crash, potential, halfWidth, offPenalty, log });
    await S.init();
    // 基线:一直按住油门
    const [base] = await g.evalBatch([[1]], { seg: 1, tail: 1, maxFrames: 30000, minY: S.minY });
    const baseline = { holdW: { finishFrames: base.fin >= 0 ? base.fin : null, dead: base.dead, progress: S.prog.query(base.last[5], base.last[7], base.last[6], base.last[4]).s } };
    log(`基线(一直按住 W): ${baseline.holdW.finishFrames ?? '未完成(掉出赛道或超时)'}${baseline.holdW.finishFrames ? '' : `, 到达中线进度 ${baseline.holdW.progress.toFixed(0)} m`}`);
    const tPlan = Date.now();
    let A;
    if (resume) { // 从之前输出的 JSON 里的翻转帧继续打磨,跳过规划
      const j = JSON.parse(fs.readFileSync(resume, 'utf8')); A = { masks: togglesToMasks(j.toggles, j.finishFrames), finishFrames: j.finishFrames };
      log(`跳过规划,从 ${resume} 继续(${j.finishFrames} 帧)`);
    } else {
      log('阶段 A:滚动时域规划(CEM + WASM 快照)');
      A = await S.plan();
    }
    const finA = await S.finishOf(A.masks);
    log(`规划结果: ${A.finishFrames} 帧 (从起点整圈复核: ${finA}), 用时 ${((Date.now() - tPlan) / 1000).toFixed(1)}s`);
    let masks = A.masks, fin = finA, polished = null;
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
      baseline, phaseA: { finishFrames: finA, seconds: (Date.now() - tPlan) / 1000 }, phaseB: polished ? { finishFrames: fin, generations: polished.generations, history: polished.history } : null,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args(process.argv.slice(2));
  if (!a.track && !a.official) { console.error('用法: node scripts/solve.mjs --track <导出串文件> | --official  --out <输出前缀> [--seconds 60] [--potential polyline|field]'); process.exit(2); }
  const r = await solveTrack({ trackFile: a.official ? null : a.track, outBase: a.out, seconds: a.seconds ?? 60, workers: a.workers ?? 4, seed: a.seed ?? 1, seg: a.seg ?? 40, horizon: a.horizon ?? 20, segs: a.segs ? parseSegs(String(a.segs)) : parseSegs('40x6,100x6,240x4'), pop: a.pop ?? 96, iters: a.iters ?? 3, commit: a.commit ?? 6, polish: a.polish !== false, polishIters: a['polish-iters'] ?? Infinity, crash: a.crash ?? 0, potential: a.potential ?? 'polyline', halfWidth: a['half-width'] ?? 8.5, offPenalty: a['off-penalty'] ?? 15, trace: !!a.trace, resume: a.resume ?? null });
  console.log(`\n结果: ${r.finishFrames} ms (${r.finishSeconds.toFixed(3)} s), Verify ${r.verifyOk ? '通过' : '失败'}`);
  process.exit(r.verifyOk ? 0 : 1);
}
