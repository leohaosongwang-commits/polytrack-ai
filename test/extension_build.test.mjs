// 不需要浏览器:扩展构建产物的静态检查(语法、清单引用的文件、无上传拦截、不含游戏文件)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', root + 'scripts/build_extension.mjs'], { stdio: 'pipe' });
const js = fs.readFileSync(root + 'extension/autopilot.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync(root + 'extension/manifest.json', 'utf8'));

test('autopilot.js 语法正确,且不含残留的 import / export', () => {
  new vm.Script(js, { filename: 'autopilot.js' });
  assert.ok(!/^\s*(import|export)\s/m.test(js));
  assert.ok(js.includes('window.__ptSolver') && js.includes('window.__ptai'));
});

test('按键显示:面板里有键帽和时间轴,数据源是物理侧的 ctl,drive 结束时隐藏', () => {
  for (const id of ['k_up', 'k_left', 'k_down', 'k_right', 'k_reset', 'id="tl"', 'id="keys"']) assert.ok(js.includes(id), id);
  assert.ok(js.includes('ctl: c.last.ctl'), 'PT.peek 要带出物理侧实际收到的按键位');
  assert.ok(js.includes('ui.keys(plan.toggles, f, p?.ctl ?? 0)') && js.includes('ui.keys(null)'));
});

test('探索式规划已打进产物,并作为规划失败后的兜底', () => {
  assert.ok(js.includes('async function exploreLap(') && js.includes('exploreLap }'));
  assert.ok(js.includes('function buildTrajectoryProgress(') && js.includes('buildTrajectoryProgress, exploreLap'), 'solver.mjs imports refpath.mjs, so the bundle must include it');
  assert.ok(js.includes('SOLVER.exploreLap(solver') && js.includes('改用探索式规划'));
});

test('清单:只匹配 0.6.3、MAIN world、document_start,引用的文件都存在', () => {
  const cs = manifest.content_scripts[0];
  assert.deepEqual(cs.matches, ['https://app-polytrack.kodub.com/0.6.3/*']);
  assert.equal(cs.world, 'MAIN'); assert.equal(cs.run_at, 'document_start');
  for (const f of cs.js) assert.ok(fs.existsSync(root + 'extension/' + f), f);
});

test('不拦截上传:清单不声明网络层规则,产物里没有网络 API 包装', () => {
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.declarative_net_request, undefined);
  assert.ok(!fs.existsSync(root + 'extension/rules.json'));
  assert.ok(!js.includes('blocked-by-polytrack-ai'));
  assert.ok(!js.includes('navigator.sendBeacon'));
  assert.ok(!js.includes('blocked by PolyTrack AI'));
});

test('构建产物里没有游戏代码特征(Worker 脚本只在运行时取、只在内存补丁)', () => {
  assert.ok(!js.includes('PolyTrackPhysics().then')); // 游戏 Worker 脚本里的片段
  assert.ok(!js.includes('importScripts("lib/polytrack_physics.js")'));
  assert.ok(js.length < 400 * 1024);
});

// 内置方案:每条都能解码、翻转帧不超过完成帧,并且已经内联进 autopilot.js
import { decodeRecording } from '../scripts/lib/pt_codec.mjs';
test('内置方案:回放串可解码、与完成帧一致,并已内联进构建产物', () => {
  const db = JSON.parse(fs.readFileSync(root + 'extension/plans/bundled.json', 'utf8'));
  for (const [id, p] of Object.entries(db)) {
    assert.match(id, /^[0-9a-f]+-\d+$/);
    assert.ok(p.finishFrames > 0 && p.name && p.recording);
    const t = decodeRecording(p.recording);
    const maxFrame = Math.max(0, ...Object.values(t).flat());
    assert.ok(maxFrame <= p.finishFrames, `${p.name}: 最后一次按键翻转帧 ${maxFrame} 超过完成帧 ${p.finishFrames}`);
    assert.ok(js.includes(JSON.stringify(id)), `${p.name} 没有内联进 autopilot.js`);
  }
});
