// 帧级局部搜索(TAS 式打磨):在一份已有的逐帧按键方案上反复做小改动(平移翻转帧、平移/删除短脉冲、替换一小段、时间扭曲……),
// 每个候选从"窗口起点的快照"出发,窗口之后沿用原方案的按键一直模拟到冲线,直接用真实完成帧做目标。
// 只接受完成帧更小(或相同且翻转次数不增)的候选,所以结果单调不变差;最后用游戏自带 Verify 校验。
// 与 solver.polish 的区别:不用势能做代理评分,目标就是完成帧本身。
// "闸门对齐"(默认开,--no-gate 关):窗口较早时,改动会让车比原来早/晚到达后面的地形,后半段按绝对帧号发出的按键就对不上了,
//   所以在窗口之后 300~1500 帧处取原方案轨迹上的一个"闸门"(过该点、法向=该处速度方向的平面),
//   候选越过闸门的那一刻起,后半段按键改按"越过时刻"对齐(并随机试 ±5 帧偏移)。这样早期的结构性改动(起飞速度、落点、漂移时机)也能被真实完成帧公平地评价。
// 先做 1-opt 穷举扫描(每个键的每个翻转帧平移若干固定量、每个脉冲整体平移,带/不带闸门各评一遍),到局部最优后再做随机多点变异(--no-sweep / --no-random 可关)。
// 用法:node scripts/tas_polish.mjs --src 方案.json --out 前缀 [--minutes 30] [--workers 4] [--batch 64] [--seed 1] [--from 0] [--late 0.25] [--order forward|backward] [--no-gate] [--no-sweep] [--no-random] [--game-track summer3|winter2|desert4…]
//   --order backward:扫描从终点往起点走(同样时间内覆盖更多事件;扩展里的页面内微调就用这个顺序)。
//   方案.json 需含 toggles + finishFrames(solve.mjs / refine.mjs 的输出,或 make_local_plan 的 plan 字段)。
//   想提前结束:在输出前缀旁建一个空文件 <前缀>.stop,会在当前一轮结束后收尾并校验。
// 只在本地离线运行,不会向游戏服务器上传任何成绩(harness 拒绝所有非静态资源请求)。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchGame } from './lib/pt_harness.mjs';
import { polishPlan } from './lib/tas_core.mjs';
import { encodeRecording } from './lib/pt_codec.mjs';

// 搜索核心在 lib/tas_core.mjs(与页面里的扩展共用);这里只负责:读方案、起浏览器、写结果、游戏 Verify 复核。
export { mutateWin, keyEdges, singleShiftCandidates, pulseShiftCandidates, bigShiftCandidates, insertCandidates, scalePulseCandidates, rebuild } from './lib/tas_core.mjs';

export async function tasPolish({ src, out, minutes = 30, workers = 4, batch = 64, seed = 1, from = 0, late = 0.25, rounds = 2, gate = true, sweep = true, structural = true, random = true, order = 'forward', gameTrack = null, log = console.log }) {
  const j = JSON.parse(fs.readFileSync(src, 'utf8')); const j2 = j.plan ?? j;
  const g = await launchGame({ exposeTrack: true, mainVirtual: true, ...(gameTrack ? { officialTrack: gameTrack } : {}) });
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true }); const stopFile = out + '.stop'; // 想提前结束:建这个空文件
    const toRec = (tg) => encodeRecording(Object.fromEntries(['up', 'right', 'down', 'left', 'reset'].map((k, i) => [k, tg[i]])));
    const save = (finishFrames, tg, final = false) => { fs.writeFileSync(out + '.json', JSON.stringify({ finishFrames, finishSeconds: finishFrames / 1000, toggles: tg, recording: toRec(tg), source: j2.source ?? null, startFrames: j2.finishFrames, final })); };
    const r = await polishPlan(g, j2.toggles, j2.finishFrames, { seconds: minutes * 60, workers, batch, seed, from, late, rounds, gate, sweep, structural, random, order, log, shouldStop: () => fs.existsSync(stopFile), onImprove: (x) => save(x.finishFrames, x.toggles) });
    // 收尾:游戏 Verify
    const bestFin = r.finishFrames; const rec = toRec(r.toggles); save(bestFin, r.toggles, true);
    const v = await g.verify(rec, bestFin, 3); const vm = await g.verify(rec, bestFin - 1, 1); const vp = await g.verify(rec, bestFin + 1, 1);
    const verify = { atFinish: v.map((x) => x.result), minus1: vm[0].result, plus1: vp[0].result }; const ok = verify.atFinish.every((x) => x === true) && verify.minus1 === false && verify.plus1 === false;
    log(`收尾:${bestFin} 帧 (${(bestFin / 1000).toFixed(3)} s),起点 ${r.startFrames};游戏 Verify ${JSON.stringify(verify)} => ${ok ? '通过' : '失败'};${r.iterations} 轮,改进 ${r.improvements} 次`);
    return { finishFrames: bestFin, startFrames: r.startFrames, verifyOk: ok, toggles: r.toggles, recording: rec, iterations: r.iterations };
  } finally { await g.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.argv.slice(2); const a = Object.fromEntries(raw.reduce((acc, v, i, arr) => (v.startsWith('--') && !v.startsWith('--no-') ? [...acc, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
  if (!a.src || !a.out) { console.error('用法: node scripts/tas_polish.mjs --src 方案.json --out 前缀 [--minutes 30] [--workers 4] [--batch 64] [--seed 1] [--from 0] [--late 0.25] [--order forward|backward] [--no-gate] [--no-sweep] [--no-random]'); process.exit(2); }
  const r = await tasPolish({ src: a.src, out: a.out, minutes: Number(a.minutes ?? 30), workers: Number(a.workers ?? 4), batch: Number(a.batch ?? 64), seed: Number(a.seed ?? 1), from: Number(a.from ?? 0), late: Number(a.late ?? 0.25), order: a.order === 'backward' ? 'backward' : 'forward', gate: !raw.includes('--no-gate'), sweep: !raw.includes('--no-sweep'), structural: !raw.includes('--no-structural'), random: !raw.includes('--no-random'), gameTrack: a['game-track'] && a['game-track'] !== true ? a['game-track'] : null });
  console.log(`\n结果: ${r.finishFrames} 帧 (${(r.finishFrames / 1000).toFixed(3)} s),起点 ${r.startFrames},Verify ${r.verifyOk ? '通过' : '失败'}`);
  process.exit(r.verifyOk ? 0 : 1);
}
