// 诊断规划失败:把 solve.mjs 写出的 *.failed.json(或带 committed/durs 的 JSON)在引擎里重放一遍,打印轨迹表(帧、位置、车速、车轮接地、中线进度 s、偏移 d、高度层),
// 并可列出赛道零件,看停滞点附近到底是什么结构(坡 / 跳 / 墙 / 多层)。
// 用法:node scripts/diag_fail.mjs --game-track summer2 --failed out/x.failed.json [--every 100] [--from 0] [--to 99999] [--parts x0,x1,z0,z1 [--max-parts 100]]
import fs from 'node:fs';
import { launchGame } from './lib/pt_harness.mjs';
import { Solver } from './lib/solver.mjs';

const argv = process.argv.slice(2);
const get = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const failed = JSON.parse(fs.readFileSync(get('failed'), 'utf8'));
const every = Number(get('every', 100)), from = Number(get('from', 0)), to = Number(get('to', 1e9));
const track = get('track') ? fs.readFileSync(get('track'), 'utf8').trim() : null;
const g = await launchGame({ exposeTrack: true, mainVirtual: true, customTrack: track, officialTrack: get('game-track') });
try {
  const S = new Solver(g, { workers: 1, potential: 'field', slowSegs: null });
  await S.init();
  const total = failed.durs.reduce((a, b) => a + b, 0);
  const [r] = await g.evalBatch([failed.committed], { segs: failed.durs, maxFrames: total, sampleEvery: every, minY: S.minY });
  console.log(`重放 ${failed.committed.length} 个动作 / ${total} 帧;终态 帧 ${r.frames} 车速 ${r.last[1].toFixed(0)} km/h  dead=${r.dead}`);
  console.log('帧      x       y       z     km/h  轮  cp    s     d    上方');
  for (const s of r.smp) {
    if (s[0] < from || s[0] > to) continue;
    const q = S.prog.query(s[5], s[7], s[6], s[4]);
    const w = (s[2] >> 3) & 15; const wn = (w & 1) + ((w >> 1) & 1) + ((w >> 2) & 1) + ((w >> 3) & 1);
    console.log(`${String(s[0]).padStart(6)} ${s[5].toFixed(1).padStart(7)} ${s[6].toFixed(1).padStart(7)} ${s[7].toFixed(1).padStart(7)} ${s[1].toFixed(0).padStart(5)}  ${wn}  ${s[4]}  ${q.s.toFixed(0).padStart(5)} ${q.d.toFixed(1).padStart(5)} ${(q.above ?? 0).toFixed(1).padStart(5)}`);
  }
  const ti = await g.trackInfo();
  console.log(`\n赛道:${ti.parts?.length ?? '?'} 个零件;起点/检查点/终点见 trackInfo。进度势能总长 ${S.prog.length.toFixed(0)} m,检查点 ${S.prog.checkpoints} 个`);
  const box = get('parts');
  if (box && ti.parts) {
    const [x0, x1, z0, z1] = box.split(',').map(Number);
    const inBox = (c) => c[0] * 5 + 2.5 >= x0 && c[0] * 5 + 2.5 <= x1 && c[2] * 5 + 2.5 >= z0 && c[2] * 5 + 2.5 <= z1;
    const sel = ti.parts.filter((p) => p.cells.some(inBox));
    console.log(`区域内零件 ${sel.length} 个(世界坐标 = 格子 x 5;列:零件号 类别 格子范围 x/y/z 起点序 检测器):`);
    for (const p of sel.slice(0, Number(get('max-parts', 100)))) {
      const mn = [0, 1, 2].map((k) => Math.min(...p.cells.map((c) => c[k]))), mx = [0, 1, 2].map((k) => Math.max(...p.cells.map((c) => c[k])));
      console.log(`  #${p.partId} cat${p.category} x${mn[0]}..${mx[0]} y${mn[1]}..${mx[1]} z${mn[2]}..${mx[2]}${p.startOrder != null ? ' 起点' + p.startOrder : ''}${ti.info[p.partId]?.detector ? ' 检测器' + ti.info[p.partId].detector.type : ''}`);
    }
  }
} finally { await g.close(); }
