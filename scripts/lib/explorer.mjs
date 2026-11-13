// Go-Explore 式探索:先找到"任意一条能冲线的路线",不依赖手工势场对"这条路走不走得通"的判断。
// 动机(report 6.11):官方 summer2 / summer3 里有近乎垂直的墙 / 环形结构,格子势场表达不了,滚动时域规划器在那里停滞。
//
// 做法:
//   档案(archive):把状态按 (已过检查点数, 3D 位置格子 6 x 4 x 6 m) 分格;每格只留一个代表(到达时车速更快的优先 —— 爬墙 / 起跳需要入坡速度)。
//   每个代表 = 一条动作链(父节点 + 一小段动作,每个动作 seg 帧);状态靠"确定性重放"还原(commit 到各评估 Worker 的 WASM 快照)。
//   每轮:按权重挑一格(势场进度只当弱启发:exp((s - s_max)/T) / (1 + 被选次数)),还原它,
//        从它出发做 pop 条随机展开(H 个动作,惰性 = 以 persist 的概率沿用上一个动作),沿途每个动作边界取样 -> 新格子 / 更快到达的格子进档案。
//   某条展开冲线就停(extraSeconds > 0 则再找一会儿取最快的),返回逐帧掩码,交给 Solver.polish 做帧级打磨。
// 与 plan() 的区别:不需要势场"单调向前"这个前提;势场只用来给选格子排个先后,选错了也只是浪费几轮。
export async function exploreLap(S, o = {}) {
  const { seconds = 600, pop = 96, H = 24, seg = 60, cellXZ = 6, cellY = 4, T = 60, persist = 0.7, extraSeconds = 0, minSpeedGain = 10, maxIters = Infinity, pNovel = 0.25, airCap = 8, staleExp = 1, pStale = 1 } = o;
  const log = o.log ?? S.o.log, g = S.g, rng = S.rng;
  const AC = [1, 9, 3, 4]; const PW = [0.45, 0.2, 0.2, 0.15]; // W, W+左, W+右, 刹车
  const pickAct = () => { let u = rng(); for (let i = 0; i < AC.length; i++) { u -= PW[i]; if (u <= 0) return AC[i]; } return AC[0]; };
  // 势场里"与目标不连通"的段(segLen = 0,例如 summer2 / summer3 过了最后一个检查点之后要跨环 / 长跳),进度没有梯度 —— 这种段改用
  // "到目标中心的水平直线距离"当弱启发:s = offset[k] + max(0, E - dist),E = 上一个目标到这个目标的直线距离。直线距离在环 / 墙附近会误导,所以它只用来排序,选格子时还掺了 pNovel 的纯新颖度。
  const ti = S.ti, P = S.prog, ctr = (cells) => [cells.reduce((a, c) => a + c[0], 0) / cells.length * 5 + 2.5, 0, cells.reduce((a, c) => a + c[2], 0) / cells.length * 5 + 2.5];
  const groups = new Map(); for (const p of ti.parts) if (ti.info[p.partId]?.detector?.type === 0 && p.cpOrder != null) (groups.get(p.cpOrder) ?? groups.set(p.cpOrder, []).get(p.cpOrder)).push(...p.cells);
  const targets = [...[...groups.keys()].sort((a, b) => a - b).map((k) => ctr(groups.get(k)))]; { const f = []; for (const p of ti.parts) if (ti.info[p.partId]?.detector?.type === 1) f.push(...p.cells); if (f.length) targets.push(ctr(f)); }
  const startC = ti.start?.position ? [ti.start.position.x, 0, ti.start.position.z] : [0, 0, 0];
  const degenerate = (P.segLen ?? []).map((l) => !(l > 1)), segE = targets.map((t, k) => Math.hypot(t[0] - (k ? targets[k - 1][0] : startC[0]), t[2] - (k ? targets[k - 1][2] : startC[2])));
  if (degenerate.some(Boolean)) log(`  [探索] 势场第 ${degenerate.map((d, k) => (d ? k : -1)).filter((k) => k >= 0).join(',')} 段与目标不连通:这些段改用直线距离当弱启发`);
  const sOf = (q, x, z, cp) => { const k = Math.min(cp, targets.length - 1); return degenerate[k] ? P.offset[k] + Math.max(0, segE[k] - Math.hypot(x - targets[k][0], z - targets[k][2])) : q.s; };
  const root = { parent: null, chunk: new Uint8Array(0), frames: 0, last: 1, s: 0 };
  const arch = new Map(); arch.set('root', { node: root, speed: 0, s: 0, bad: false, visits: 0, stale: 0 });
  const chainOf = (node) => { const parts = []; for (let n = node; n; n = n.parent) parts.push(n.chunk); parts.reverse(); const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let k = 0; for (const p of parts) { out.set(p, k); k += p.length; } return out; };

  // ---- 把某个节点的状态还原成各评估 Worker 的"已提交快照" ----
  let cur = null; // 当前已提交的节点
  const load = async (node) => {
    if (node === cur) return;
    const chain = []; let n = node; while (n && n !== cur) { chain.push(n); n = n.parent; }
    let acts, reset;
    if (cur && n === cur) { // 目标是当前快照的后代:只提交增量
      chain.reverse(); acts = [].concat(...chain.map((c) => Array.from(c.chunk))); reset = false;
    } else { acts = Array.from(chainOf(node)); reset = true; }
    const c = await g.commit(acts, seg, acts.map(() => seg), reset);
    if (c.frames !== node.frames) log(`  [探索] 警告:还原节点的帧数 ${c.frames} != 期望 ${node.frames}(重放不一致?)`);
    cur = node;
  };
  await g.commit([], seg, null, true); cur = root;
  const pick = () => { // 按权重抽一格;pNovel 的概率完全不看势场、只看"被选次数"(势场在墙 / 环 / 长跳处会误导,这是保底)
    let smax = -Infinity; for (const c of arch.values()) if (c.s > smax) smax = c.s;
    const novel = rng() < pNovel, useStale = pStale >= 1 || rng() < pStale; // pStale:这一次抽格子才用"最近没产出就降权"(默认每次都用;slalom 靠它:20 s,关掉后 300 s 都没找到)
    // stale = 自上次"选它能产出新格子"以来又选了多少次(Go-Explore 的"productive"信号)
    let tot = 0; const ws = []; for (const c of arch.values()) { const st = useStale ? Math.pow(1 + c.stale, staleExp) : 1, w = (novel ? 1 / ((1 + c.visits) * st * st) : Math.exp((c.s - smax) / T) / ((1 + c.visits) * st)) * (c.bad ? 0.05 : 1); ws.push(w); tot += w; }
    let u = rng() * tot, i = 0; const cells = [...arch.values()]; for (; i < cells.length - 1; i++) { u -= ws[i]; if (u <= 0) break; } return cells[i];
  };
  // 一个取样点 -> 档案。返回 0 = 没变化,1 = 新格子,2 = 同一格里更快到达的代表
  const cpKey = (smp) => smp[4] + '|' + Math.floor(smp[5] / cellXZ) + '|' + Math.floor(smp[6] / cellY) + '|' + Math.floor(smp[7] / cellXZ);
  const register = (base, chunk, smp) => {
    const x = smp[5], y = smp[6], z = smp[7], cp = smp[4];
    if (!(y > S.minY)) return 0;
    const key = cpKey(smp), old = arch.get(key);
    if (old && !(smp[1] > old.speed + minSpeedGain)) return 0;
    const q = S.prog.query(x, z, y, cp);
    const air = ((smp[2] >> 3) & 15) === 0; // 四轮离地:势场的"空中走廊"会给飞行中的状态虚高的进度,这里只允许比起飞点最多高 airCap 米,落地后再按真实位置算
    const qs = sOf(q, x, z, cp), sv = air ? Math.min(qs, base.s + airCap) : qs;
    const node = { parent: base, chunk, frames: smp[0], last: chunk[chunk.length - 1], s: sv };
    arch.set(key, { node, speed: smp[1], s: sv, bad: q.above > S.o.fallAbove || q.d > 25, visits: 0, stale: 0 });
    return old ? 2 : 1;
  };
  const consider = (base, plan, i, smp) => register(base, Uint8Array.from(plan.slice(0, i + 1)), smp);

  // 续跑:resume = { committed } —— 以前某次探索写出的 *.frontier.json / *.failed.json(每个动作 seg 帧)。沿这条链重放一遍,把沿途每个动作边界的状态登记进档案,再接着往后探索。
  if (o.resume?.committed?.length) {
    const acts = o.resume.committed, ds = o.resume.durs ?? acts.map(() => seg);
    if (!ds.every((d) => d === seg)) throw new Error(`续跑文件里的动作时长必须都是 ${seg} 帧(用同样的 --explore-seg)`);
    const [r] = await g.evalBatch([acts], { segs: acts.map(() => seg), maxFrames: acts.length * seg, sampleAt: acts.map((_, k) => (k + 1) * seg), minY: S.minY });
    let prev = root, n = 0;
    for (const smp of r.smp) { const i = Math.round(smp[0] / seg) - 1; if (i < 0 || i >= acts.length) continue; const node = { parent: prev, chunk: Uint8Array.from([acts[i]]), frames: smp[0], last: acts[i], s: 0 }; const got = register(prev, node.chunk, smp); const cell = got ? arch.get(cpKey(smp)) : null; if (cell) node.s = cell.s; prev = cell ? cell.node : node; n += got ? 1 : 0; }
    log(`  [探索] 续跑:沿 ${acts.length} 个动作(${acts.length * seg} 帧)重放,登记 ${n} 个状态,档案 ${arch.size} 格`);
  }
  const t0 = Date.now(); let iters = 0, simFrames = 0, best = null, firstFinAt = null, newCells = 0, lastLog = 0;
  const segs = Array(H).fill(seg), sampleAt = segs.map((_, k) => (k + 1) * seg);
  while (iters < maxIters) {
    if (S.o.cancel?.()) throw new Error('已取消');
    const el = (Date.now() - t0) / 1000;
    if (el > seconds && !best) break;
    if (best && el - firstFinAt > extraSeconds) break;
    iters++;
    const cell = pick(); cell.visits++;
    await load(cell.node);
    const base = cell.node, F = base.frames; let kids = 0;
    const plans = [];
    for (let k = 0; k < pop; k++) {
      const p = new Array(H); let a = rng() < 0.5 ? base.last : pickAct();
      for (let h = 0; h < H; h++) { if (h > 0 && rng() > persist) a = pickAct(); p[h] = a; }
      plans.push(p);
    }
    const res = await g.evalBatch(plans, { segs, maxFrames: H * seg, fromCommit: true, sampleAt, minY: S.minY, ...(S.o.crashStop ? { crashStop: S.o.crashStop } : {}) });
    for (let k = 0; k < res.length; k++) {
      const r = res[k]; simFrames += Math.max(0, r.frames - F);
      if (r.fin >= 0 && (!best || r.fin < best.fin)) { best = { fin: r.fin, base, plan: plans[k] }; if (firstFinAt == null) { firstFinAt = (Date.now() - t0) / 1000; log(`  [探索] 迭代 ${iters}: 找到冲线路线,完成帧 ${r.fin}(${(r.fin / 1000).toFixed(3)} s),用时 ${firstFinAt.toFixed(0)}s`); } }
      for (const s of r.smp) { const i = Math.round((s[0] - F) / seg) - 1; if (i < 0 || i >= H || Math.abs(s[0] - F - (i + 1) * seg) > 0) continue; { const got = consider(base, plans[k], i, s); newCells += got ? 1 : 0; if (got) kids++; } }
    }
    if (kids > 0) cell.stale = 0; else cell.stale++;
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now(); let smax = -Infinity; for (const c of arch.values()) if (c.s > smax) smax = c.s;
      if (o.onFrontier) { let bc = null; for (const c of arch.values()) if (!bc || c.s > bc.s) bc = c; const acts = Array.from(chainOf(bc.node)); o.onFrontier({ committed: acts, durs: acts.map(() => seg), frames: bc.node.frames, last: null, s: bc.s }); } // 定期把"最远进度"那一格的动作链写出去,不用等跑完就能用 diag_fail.mjs 重放
      log(`  [探索] 迭代 ${iters}: 档案 ${arch.size} 格(本段新增/更新 ${newCells}),最远进度 ${smax.toFixed(0)}/${S.prog.length.toFixed(0)} m,已模拟 ${(simFrames / 1e6).toFixed(1)}M 帧,用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`); newCells = 0;
    }
  }
  S.exploreStats = { iters, cells: arch.size, simFrames, seconds: (Date.now() - t0) / 1000 };
  if (!best) { // 没找到:把"最远进度"那一格的动作链当失败现场写出去(diag_fail.mjs 可以重放)
    let bc = null; for (const c of arch.values()) if (!bc || c.s > bc.s) bc = c;
    const acts = Array.from(chainOf(bc.node));
    throw Object.assign(new Error(`探索 ${iters} 轮、${arch.size} 格、${((Date.now() - t0) / 1000).toFixed(0)}s 内没有找到冲线路线(最远进度 ${bc.s.toFixed(0)}/${S.prog.length.toFixed(0)} m)`), { partial: { committed: acts, durs: acts.map(() => seg), frames: bc.node.frames, last: null } });
  }
  const acts = Array.from(chainOf(best.base)).concat(best.plan.slice(0, Math.ceil((best.fin - best.base.frames) / seg)));
  const masks = new Uint8Array(best.fin); let f = 0; for (const a of acts) for (let j = 0; j < seg && f < best.fin; j++) masks[f++] = a;
  log(`  [探索] 结束:${iters} 轮,档案 ${arch.size} 格,模拟 ${(simFrames / 1e6).toFixed(1)}M 帧,${((Date.now() - t0) / 1000).toFixed(0)}s;冲线 ${best.fin} 帧`);
  return { masks, finishFrames: best.fin };
}
