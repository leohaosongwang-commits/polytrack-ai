// 批量基准:对若干条赛道依次跑 solve.mjs(每条一个独立子进程:内存隔离、可超时、崩了不影响后面),汇总成表。
// 用法:node scripts/bench.mjs --tracks summer2,winter3,scripts/data/slalom.txt --dir out/bench1 [--seeds 1,2] [--timeout 900] -- [传给 solve.mjs 的其余参数,如 --workers 4 --no-polish]
//   赛道写官方名(summer1..7 / winter1..5 / desert1..5;游戏自己的静态资源,只在内存里转手)或导出串文件路径(.txt)。
//   已有结果(<dir>/<名>_s<种子>.result.json)的组合会跳过,所以中断后可以原样重跑续上。
// 本工具只在本地离线运行,不会上传任何成绩(solve.mjs 的 harness 拒绝所有非静态资源请求)。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const own = dd < 0 ? argv : argv.slice(0, dd);
const pass = dd < 0 ? [] : argv.slice(dd + 1);
const get = (k, d) => { const i = own.indexOf('--' + k); return i >= 0 && own[i + 1] ? own[i + 1] : d; };
const tracks = get('tracks', '').split(',').filter(Boolean);
const seeds = get('seeds', '1').split(',').map(Number);
const dir = path.resolve(get('dir', 'out/bench'));
const timeoutMs = Number(get('timeout', 900)) * 1000;
if (!tracks.length) { console.error('用法: node scripts/bench.mjs --tracks summer2,winter3 --dir out/bench1 [--seeds 1,2] [--timeout 900] -- [solve.mjs 参数]'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });

const nameOf = (t) => path.basename(t).replace(/\.txt$/, '');

/** 从日志里提炼一行结果 */
function summarize(name, seed, log, wall, code, timedOut) {
  const m = (re) => { const x = log.match(re); return x ? x[1] : null; };
  const result = m(/^结果: (\d+) ms/m);
  const planWall = m(/规划结果: \d+ 帧 \(从起点整圈复核: -?\d+\), 用时 ([\d.]+)s/);
  const planFrames = m(/规划结果: (\d+) 帧/);
  const verify = /=> 通过/.test(log) ? 'ok' : /=> 失败/.test(log) ? 'FAIL' : '-';
  const rollbacks = (log.match(/\[规划\] 回退/g) || []).length;
  const stalls = (log.match(/\[规划\] 停滞/g) || []).length;
  const err = !result ? ((log.match(/Error: (.*)$/m) || [])[1] ?? (timedOut ? '超时' : code !== 0 ? `exit ${code}` : '?')) : null;
  return { track: name, seed, ok: !!result && verify === 'ok', frames: result ? Number(result) : null, planFrames: planFrames ? Number(planFrames) : null, planSeconds: planWall ? Number(planWall) : null, wallSeconds: Math.round(wall), verify, rollbacks, stalls, error: err ? String(err).slice(0, 160) : null };
}

function runOne(spec, seed) {
  const name = nameOf(spec); const base = path.join(dir, `${name}_s${seed}`);
  const rj = base + '.result.json';
  if (fs.existsSync(rj)) return Promise.resolve(JSON.parse(fs.readFileSync(rj, 'utf8')));
  const target = spec.endsWith('.txt') ? ['--track', spec] : ['--game-track', spec];
  const args = [path.join(HERE, 'solve.mjs'), ...target, '--out', base, '--seed', String(seed), ...pass];
  const t0 = Date.now(); let log = '';
  return new Promise((resolve) => {
    const p = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: process.env });
    let timedOut = false;
    const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
    p.on('close', (code) => {
      clearTimeout(timer); kill(); // 兜底:清掉可能残留的浏览器子进程
      fs.writeFileSync(base + '.log', log);
      const s = summarize(name, seed, log, (Date.now() - t0) / 1000, code, timedOut);
      fs.writeFileSync(rj, JSON.stringify(s));
      resolve(s);
    });
  });
}

const rows = [];
for (const t of tracks) for (const s of seeds) {
  const r = await runOne(t, s); rows.push(r);
  console.log(`${r.track.padEnd(10)} 种子${r.seed}  ${r.ok ? (r.frames / 1000).toFixed(3) + ' s' : '失败'.padEnd(8)}  规划 ${r.planSeconds ?? '-'}s  总 ${r.wallSeconds}s  回退 ${r.rollbacks} 停滞 ${r.stalls}  Verify ${r.verify}${r.error ? '  ' + r.error : ''}`);
}
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(rows, null, 1));
const okRows = rows.filter((r) => r.ok);
console.log(`\n${okRows.length}/${rows.length} 条跑通;跑通的规划阶段平均 ${okRows.length ? (okRows.reduce((a, r) => a + (r.planSeconds ?? 0), 0) / okRows.length).toFixed(0) : '-'} s`);
