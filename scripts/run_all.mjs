// 依次运行阶段 0 的全部实验,日志写到 logs/。需要 Node 18+、playwright(带 chromium),以及能访问 app-polytrack.kodub.com 的网络。
// 用法:QUICK=1 node scripts/run_all.mjs    (缩减版,更快)
//       node scripts/run_all.mjs            (全量:t3/t4 的配置更多,软件渲染下 t4 单独就要 25 分钟以上)
// 报告口径:t1/t1b/t2/t3 来自全量运行,t4 来自 QUICK=1 单独运行(node 的环境变量 QUICK=1 node scripts/t4_injection.mjs)
// 另:重生压力测试不在这里,单独运行 node scripts/t3b_respawn.mjs(约 8 分钟)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const logs = new URL('../logs/', import.meta.url).pathname;
if (!fs.existsSync(dir + 'data/mini_track.txt')) { console.log('生成测试赛道…'); spawnSync('node', [dir + 'build_mini_track.mjs'], { stdio: 'inherit' }); }
const steps = ['t1_speed.mjs', 't1b_offline_throughput.mjs', 't2_state.mjs', 't3_determinism.mjs', 't4_injection.mjs'];
const summary = {};
for (const s of steps) {
  console.log('\n===== ' + s + ' =====');
  const t0 = Date.now();
  const r = spawnSync('node', [dir + s], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env });
  fs.writeFileSync(logs + s.replace('.mjs', '.log'), (r.stdout ?? '') + (r.stderr ?? ''));
  process.stdout.write(r.stdout ?? ''); if (r.stderr) process.stderr.write(r.stderr);
  summary[s] = { exitCode: r.status, seconds: Math.round((Date.now() - t0) / 1000) };
}
fs.writeFileSync(logs + 'run_all_summary.json', JSON.stringify(summary, null, 2));
console.log('\n' + JSON.stringify(summary, null, 2));
