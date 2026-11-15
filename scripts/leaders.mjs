// 给一批官方赛道各求一条"自己搜出来的最快方案",验证通过后收进扩展的内置方案(extension/plans/bundled.json)。
// 每条赛道两步(每步一个独立子进程:内存隔离、可超时、崩了不影响后面;日志实时写文件,可边跑边看):
//   1. 滚动时域规划器(圈速好,但遇到墙 / 环 / 长跳会停滞;--stall-retries 1 让它快速失败);
//   2. 规划失败 -> 探索式规划(Go-Explore)找一圈能冲线的 -> 拿这一圈当参考轨迹压圈速(--refine)-> 打磨。
// 取两步里"通过游戏 Verify 且更快"的那条,再调 bundle_plan.mjs 写入内置方案(写入前会再用游戏 Verify 校验一遍)。
// 只用我们自己的搜索结果:不读榜单、不读别人的回放;只在本地离线运行,不上传任何成绩。
// 用法:node scripts/leaders.mjs --tracks summer4,winter1 --dir out/leaders [--planner-timeout 420] [--explore-seconds 900] [--explore-timeout 2700] [--refine 1] [--no-bundle]
//   已经有 <dir>/<赛道>.best.json 的赛道会跳过(中断后原样重跑即可续上)。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const tracks = String(a.tracks || '').split(',').filter(Boolean);
if (!tracks.length) { console.error('用法: node scripts/leaders.mjs --tracks summer4,winter1 --dir out/leaders'); process.exit(2); }
const dir = path.resolve(a.dir || 'out/leaders'); fs.mkdirSync(dir, { recursive: true });
const plannerTimeout = Number(a['planner-timeout'] ?? 420) * 1000, exploreSeconds = Number(a['explore-seconds'] ?? 900), exploreTimeout = Number(a['explore-timeout'] ?? 2700) * 1000, refine = Number(a.refine ?? 1);
const logf = fs.createWriteStream(path.join(dir, 'leaders.log'), { flags: 'a' });
const say = (m) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${m}`; console.log(l); logf.write(l + '\n'); };
const pretty = (t) => t.replace(/^([a-z]+)(\d+)$/, (_, n, k) => n[0].toUpperCase() + n.slice(1) + ' ' + k);

function run(label, args, timeoutMs, logPath) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logPath);
    const p = spawn('node', [path.join(HERE, 'solve.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: process.env });
    let timedOut = false; const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    p.stdout.pipe(out, { end: false }); p.stderr.pipe(out, { end: false });
    p.on('close', (code) => { clearTimeout(timer); kill(); out.end(); resolve({ code, timedOut }); });
  });
}
const readRes = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.verifyOk === true && j.finishFrames > 0 ? j : null; } catch { return null; } };

for (const t of tracks) {
  const best = path.join(dir, t + '.best.json');
  if (fs.existsSync(best)) { say(`${t}: 已有结果,跳过`); continue; }
  const cands = [];
  say(`${t}: 步骤 1 规划器(最多 ${plannerTimeout / 1000} s)`);
  const t0 = Date.now();
  await run('planner', ['--game-track', t, '--out', path.join(dir, t + '_planner'), '--seconds', '45', '--workers', '4', '--stall-retries', '1'], plannerTimeout, path.join(dir, t + '_planner.log'));
  const rp = readRes(path.join(dir, t + '_planner.json'));
  if (rp) { cands.push({ how: '规划器', ...rp }); say(`${t}: 规划器 ${(rp.finishFrames / 1000).toFixed(3)} s,Verify 通过(${Math.round((Date.now() - t0) / 1000)} s)`); }
  else say(`${t}: 规划器没跑通(${Math.round((Date.now() - t0) / 1000)} s)`);
  if (!rp) {
    say(`${t}: 步骤 2 探索 ${exploreSeconds} s + 压圈速 ${refine} 轮(最多 ${exploreTimeout / 1000} s)`);
    const t1 = Date.now();
    await run('explore', ['--game-track', t, '--explore', '--explore-seconds', String(exploreSeconds), '--refine', String(refine), '--ref-halfwidth', '3', '--out', path.join(dir, t + '_explore'), '--seconds', '45', '--workers', '4'], exploreTimeout, path.join(dir, t + '_explore.log'));
    const re = readRes(path.join(dir, t + '_explore.json'));
    if (re) { cands.push({ how: '探索+压圈速', ...re }); say(`${t}: 探索法 ${(re.finishFrames / 1000).toFixed(3)} s,Verify 通过(${Math.round((Date.now() - t1) / 1000)} s)`); }
    else say(`${t}: 探索法也没跑通(${Math.round((Date.now() - t1) / 1000)} s)`);
  }
  if (!cands.length) { fs.writeFileSync(path.join(dir, t + '.failed'), 'no verified plan\n'); continue; }
  cands.sort((x, y) => x.finishFrames - y.finishFrames); const c = cands[0];
  fs.writeFileSync(best, JSON.stringify({ track: t, how: c.how, finishFrames: c.finishFrames, recording: c.recording, toggles: c.toggles }));
  if (!a['no-bundle']) {
    const r = spawnSync('node', [path.join(HERE, 'bundle_plan.mjs'), '--result', best, '--name', pretty(t), '--game-track', t], { encoding: 'utf8', env: process.env, timeout: 300000 });
    say(`${t}: 收进内置方案:${(r.stdout || '').trim().split('\n').slice(-1)[0] || r.stderr.slice(0, 120)}`);
  }
}
say('全部完成');
