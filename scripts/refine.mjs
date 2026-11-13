// 分段择优(best-of-N):沿一份已有方案把整圈切成若干段,每段用 N 个不同随机种子各规划一次,
// 选"先到、到时车速又高"的那条接着往下走;最后一段规划到冲线,可再做窗口打磨,并用游戏自带 Verify 校验。
// 为什么需要它:单次滚动时域规划的结果方差很大(同一段 3500 帧,不同种子慢 80~1300 帧),
//   坏结果多半是某个高速弯里的一次失误;N 选 1 能直接过滤掉这些长尾。
// 比较方式:所有候选在"源方案第 cut 帧所在的中线进度 s"处比较 —— score = 到达帧 - w x 到达车速(km/h)(默认 w=20 ms/(km/h),
//   约等于"少 1 km/h 要多花 20 ms 才能加速回来")。只要前缀仍与源方案一致,源方案本身也作为候选,所以不会比源方案差。
// 用法:node scripts/refine.mjs --src out/summer1_k.json --out out/summer1_m [--cuts 4000,6500,...] [--n 8] [--w 20]
//        [--workers 8] [--pop 96] [--iters 3] [--commit 6] [--segs 40x6,100x6,240x4] [--look 0.6] [--actions W,WL,WR,S] [--seed0 1] [--beam 2]
//        [--polish-seconds 120] [--resume out/summer1_m.stage.json] [--track 导出串文件]
// 只在本地离线运行,不会向游戏服务器上传任何成绩(harness 拒绝所有非静态资源请求)。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchGame } from './lib/pt_harness.mjs';
import { Solver, masksToToggles, togglesToMasks, mulberry32 } from './lib/solver.mjs';
import { encodeRecording } from './lib/pt_codec.mjs';
import { parseActions, parseSegs } from './solve.mjs';

const expand = (committed, durs) => { const m = []; committed.forEach((c, i) => { for (let j = 0; j < durs[i]; j++) m.push(c); }); return m; };
/** 逐帧掩码 -> committed/durs(相同动作连续段,最长 60 帧,保证回退与重规划的粒度) */
export const rle = (m, n = m.length) => { const committed = [], durs = []; for (let f = 0; f < n;) { let e = f + 1; while (e < n && m[e] === m[f] && e - f < 60) e++; committed.push(m[f]); durs.push(e - f); f = e; } return { committed, durs }; };

export async function refine({ src, out, cuts = null, n = 8, w = 20, workers = 8, pop = 96, iters = 3, commit = 6, segs = parseSegs('40x6,100x6,240x4'), look = 0.6, actions = null, extraRel = 1, seed0 = 1, beam = 2, polishSeconds = 0, resume = null, track = null, log = console.log }) {
  const res = JSON.parse(fs.readFileSync(src, 'utf8')); const km = Array.from(togglesToMasks(res.toggles, res.finishFrames));
  const cutList = (cuts ?? [4000, 6500, 9000, 11500, 14000, 16500, 19000, 21500, 24000]).filter((c) => c < res.finishFrames - 1500);
  const g = await launchGame({ exposeTrack: true, mainVirtual: true, ...(track ? { customTrack: fs.readFileSync(track, 'utf8').trim() } : {}) });
  try {
    const S = new Solver(g, { workers, potential: 'field', slowSegs: null, stallFrames: 0, segs, pop, iters, commitN: commit, lookAhead: look, ...(actions ? { actions } : {}), extraRel, log: () => {} });
    await S.init();
    const pos = async (masks) => { const c = await g.commit(masks, 1, null, true); return { s: S.prog.query(c.last[5], c.last[7], c.last[6], c.last[4]).s, v: c.last[1] }; };
    const refS = []; for (const c of cutList) refS.push(await pos(km.slice(0, c))); // 源方案在各切点的中线进度/车速
    // 束搜索:每段保留得分最高的 beam 个状态(而不是 1 个),避免一次"高速但线路不对"的贪心选择把后面带进死胡同
    let states = [{ prefix: km.slice(0, cutList[0]), onSource: true }]; let stage = 0;
    if (resume) { const st = JSON.parse(fs.readFileSync(resume, 'utf8')); states = st.states.map((x) => ({ prefix: expand(x.committed, x.durs), onSource: false })); stage = st.stage; log(`从 ${resume} 恢复:已完成 ${stage} 段,${states.length} 个状态`); }
    const t0 = Date.now(); let prefix = states[0].prefix;
    for (; stage < cutList.length; stage++) {
      // 阶段 stage:从各状态(=第 stage 个切点附近)规划到第 stage+1 个切点的中线进度;最后一阶段规划到冲线
      const last = stage === cutList.length - 1; const target = last ? null : refS[stage + 1];
      const segLen = (last ? res.finishFrames : cutList[stage + 1]) - cutList[stage];
      const cands = [];
      for (let si = 0; si < states.length; si++) {
        const st = states[si]; const from = st.prefix.length;
        if (st.onSource) cands.push(last ? { label: '源方案', frame: res.finishFrames, v: 0, masks: km.slice(0, res.finishFrames), fin: res.finishFrames, onSource: true } : { label: '源方案', frame: cutList[stage + 1], v: refS[stage + 1].v, masks: km.slice(0, cutList[stage + 1]), onSource: true });
        for (let k = 0; k < n; k++) {
          const sd = seed0 + stage * 1000 + si * 100 + k; S.rng = mulberry32(sd); S.o.prefix = rle(st.prefix); S.o.stopS = target ? target.s : null; S.o.maxFrames = from + Math.round(segLen * 1.8) + 3000;
          S.sHist = []; S.stallRetry = 0; S.stopped = null; const ts = Date.now(); let r; const tag = `段 ${stage + 1}/${cutList.length} 状态${si + 1} 种子 ${k + 1}/${n}`;
          try { r = await S.plan(); } catch (e) { log(`  ${tag}: 失败(${String(e.message).slice(0, 50)})`); continue; }
          if (last) { cands.push({ label: `种子${sd}`, frame: r.finishFrames, v: 0, masks: Array.from(r.masks), fin: r.finishFrames }); log(`  ${tag}: 冲线 ${r.finishFrames} 帧 (${((Date.now() - ts) / 1000) | 0}s)`); continue; }
          const m = expand(r.committed, r.durs); const at = []; for (let f = Math.max(10, m.length - 600); f <= m.length; f += 10) at.push(f);
          const [e] = await g.evalBatch([m], { seg: 1, tail: 1, maxFrames: m.length, sampleAt: at, minY: S.minY });
          let hit = null; for (const sm of e.smp) if (S.prog.query(sm[5], sm[7], sm[6], sm[4]).s >= target.s) { hit = sm; break; }
          const fr = hit ? hit[0] : m.length; const v = hit ? hit[1] : e.last[1];
          cands.push({ label: `种子${sd}`, frame: fr, v, masks: m.slice(0, fr) });
          log(`  ${tag}: 到达帧 ${fr}(源 ${cutList[stage + 1]}),车速 ${v.toFixed(0)} km/h,评分 ${(fr - w * v).toFixed(0)} (${((Date.now() - ts) / 1000) | 0}s)`);
        }
      }
      if (!cands.length) throw new Error(`第 ${stage + 1} 段所有候选都失败`);
      const score = (c) => (last ? c.fin : c.frame - w * c.v);
      cands.sort((x, y) => score(x) - score(y)); const keep = cands.slice(0, last ? 1 : beam);
      log(`段 ${stage + 1}/${cutList.length}: 保留 ${keep.map((c) => `${c.label}(${last ? `冲线 ${c.fin}` : `${c.frame}帧 ${c.v.toFixed(0)}km/h`})`).join(' | ')};全部评分 ${cands.map((c) => score(c).toFixed(0)).join('/')};累计 ${((Date.now() - t0) / 1000) | 0}s`);
      states = keep.map((c) => ({ prefix: c.masks, onSource: !!c.onSource })); prefix = states[0].prefix;
      if (last) break;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out + '.stage.json', JSON.stringify({ stage: stage + 1, states: states.map((x) => rle(x.prefix)) })); // 每段结束存档,可用 --resume 续跑
    }
    let masks = Uint8Array.from(prefix); let fin = await S.finishOf(masks);
    log(`整圈复核: ${fin} 帧 (${(fin / 1000).toFixed(3)} s)`);
    if (fin < 0) throw new Error('整圈复核未完成');
    if (polishSeconds > 0) { log(`窗口打磨 ${polishSeconds}s`); const p = await S.polish(masks, fin, { seconds: polishSeconds }); masks = p.masks; fin = p.finishFrames; log(`打磨结果: ${fin} 帧`); }
    const rec = encodeRecording(Object.fromEntries(['up', 'right', 'down', 'left', 'reset'].map((k, i) => [k, masksToToggles(masks)[i]])));
    const v = await g.verify(rec, fin, 3); const vm = await g.verify(rec, fin - 1, 1); const vp = await g.verify(rec, fin + 1, 1);
    const verify = { atFinish: v.map((x) => x.result), minus1: vm[0].result, plus1: vp[0].result }; const ok = verify.atFinish.every((x) => x === true) && verify.minus1 === false && verify.plus1 === false;
    log(`游戏 Verify: ${JSON.stringify(verify)} => ${ok ? '通过' : '失败'}`);
    const o = { track: track ?? '(官方默认赛道)', finishFrames: fin, finishSeconds: fin / 1000, verify, verifyOk: ok, recording: rec, toggles: masksToToggles(masks), params: { src, cuts: cutList, n, beam, w, pop, iters, commit, seed0, wallSeconds: (Date.now() - t0) / 1000 } };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out + '.recording.txt', rec + '\n'); fs.writeFileSync(out + '.json', JSON.stringify(o, null, 1));
    log(`已写出 ${out}.json`);
    return o;
  } finally { await g.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
  if (!a.src || !a.out) { console.error('用法: node scripts/refine.mjs --src out/x.json --out out/y [--cuts 4000,6500,...] [--n 8] [--w 20] [--workers 8] [--polish-seconds 120] [--resume out/y.stage.json]'); process.exit(2); }
  const r = await refine({ src: a.src, out: a.out, cuts: a.cuts ? String(a.cuts).split(',').map(Number) : null, n: Number(a.n ?? 8), w: Number(a.w ?? 20), workers: Number(a.workers ?? 8), pop: Number(a.pop ?? 96), iters: Number(a.iters ?? 3), commit: Number(a.commit ?? 6), segs: a.segs ? parseSegs(String(a.segs)) : undefined, look: Number(a.look ?? 0.6), actions: a.actions ? parseActions(a.actions) : null, extraRel: Number(a.prior ?? 1), seed0: Number(a.seed0 ?? 1), beam: Number(a.beam ?? 2), polishSeconds: Number(a['polish-seconds'] ?? 0), resume: a.resume ?? null, track: a.track ?? null });
  console.log(`\n结果: ${r.finishFrames} ms (${r.finishSeconds.toFixed(3)} s), Verify ${r.verifyOk ? '通过' : '失败'}`);
  process.exit(r.verifyOk ? 0 : 1);
}
