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

test('进度条:求解 / 微调按阶段显示百分比,规划器 / 探索 / 打磨都带可选的进度回调', () => {
  for (const k of ['function makeProgress(', 'onProgress: (p) => PG.set(p.frac)', "PG.enter('polish')", "PG.enter('verify')", 'PG.done(']) assert.ok(js.includes(k), k);
  assert.ok(js.includes("this.o.onProgress({ stage: 'plan'") && js.includes("stage: 'polish'") && js.includes("stage: 'explore'"), '三个阶段都要有进度回调');
  assert.ok(js.includes("ui.wait('对照榜单第 1 名')"), '读榜单是不定长等待');
  for (const id of ['id="pc"', 'id="pl"', 'id="chips"', 'id="pt"', 'id="trk"', 'id="dot"', 'id="min"', 'id="hd"']) assert.ok(js.includes(id), id); // 百分比 / 阶段名 / 阶段条 / 时间 / 条 / 状态点 / 折叠 / 标题栏
  assert.ok(js.includes('prefers-reduced-motion'), '尊重系统的"减少动态效果"设置');
});

test('目标名次 / 秒数:榜单二分(只读)和选方案规则打进产物;带目标的流程不存缓存、标明是别人的回放', () => {
  for (const k of ['window.__ptRank', 'async function resolveTarget(', 'function chooseForTarget(', 'async function countFaster(', 'async function lbAt(', 'async function fetchRecording(', 'async function resolveTargetFor(', 'async function replayFromEntry(', 'async function obtainPlanTarget(']) assert.ok(js.includes(k), k);
  assert.ok(js.includes('skip=${skip}&amount=1&onlyVerified=true'), '按下标取榜单:每次一个只读 GET');
  for (const id of ['id="tg"', 'id="seg"', 'id="tv"', 'id="tn"', 'data-m="rank"', 'data-m="sec"']) assert.ok(js.includes(id), id); // 目标:选择条 / 输入框 / 预览文字
  assert.ok(js.includes('不是自己的方案') && js.includes('ghost: true'), '榜单回放必须标明是别人的成绩');
  const seg = js.slice(js.indexOf('async function replayFromEntry('), js.indexOf('// ================= 6. 自动驾驶')); // replayFromEntry + obtainPlanTarget
  assert.ok(seg.includes('obtainPlanTarget') && !seg.includes('savePlan('), '带目标的流程不能改缓存(缓存里只放自己最快的方案)');
  assert.ok(js.includes('const tgt = ui.getTarget()') && js.includes('obtainPlanTarget(ui, id, tgt)'), '点击要按面板上的目标走 obtainPlanTarget');
  assert.ok(js.includes('e.stopPropagation()'), '输入框里打字的按键不能冒泡到游戏');
});

test('面板外观:滑块分段控件、主按钮热键提示、分组设置、目标组在忙时收起;原来的元素 id 都还在', () => {
  for (const k of ['class="thumb"', 'id="kk"', 'ICON_PLAY', 'ICON_STOP', '.tg.dis{grid-template-rows:0fr', ".style.setProperty('--i'", 'class="grp"', 'class="stw"', 'id="dt"', 'ptai:logopen']) assert.ok(js.includes(k), k);
  for (const id of ['go', 'gi', 'gt', 'st', 'dot', 'log', 'ft', 'hk', 'ver', 'hp', 'mbar', 'bd', 'tl', 'gd', 'clr', 'cp', 'kt', 'k_up', 'k_left', 'k_down', 'k_right', 'k_reset']) assert.ok(js.includes(`id="${id}"`), id); // 测试脚本和逻辑依赖的 id
  assert.ok(js.includes("$('ver').textContent = `v${BUILD.v}`"), '标题栏版本徽标跟着 BUILD.v');
});

test('探索式规划已打进产物,并作为规划失败后的兜底', () => {
  assert.ok(js.includes('async function exploreLap(') && js.includes('exploreLap, polishPlan }'));
  assert.ok(js.includes('window.__ptGuideMath') && js.includes('function projectGuide(') && js.includes('window.__ptGuideUI') && js.includes('prepareGuide'), '引导线(相机钩子 + 叠加层 + 数学)要在产物里');
  assert.ok(js.includes("'projectionMatrix'") && js.includes('__ptaiOverlay'), '相机钩子要跳过叠加层自己的绘制,否则死循环');
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

test('版本号:manifest.json 是唯一来源,油猴脚本头 / 面板页脚 / 构建标记都跟它一致', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(js.includes(`// @version      ${manifest.version}\n`), '油猴脚本头的 @version 要等于 manifest.version');
  assert.ok(js.includes(`const BUILD = {"v":"${manifest.version}"`), '构建标记里的版本号要等于 manifest.version');
  assert.ok(js.includes('`v${BUILD.v} · 构建 ${BUILD.t}'), '面板页脚要显示版本号');
});

test('规划流程:现成方案 → 榜单第 1 名回放 + 页面内微调 → 从零求解,微调核心已打进产物', () => {
  assert.ok(js.includes('async function polishPlan(') && js.includes('exploreLap, polishPlan }'), 'tas_core.mjs 要打进求解器包并导出 polishPlan');
  assert.ok(!js.includes("from './solver.mjs'"), 'tas_core 的 import 要被去掉');
  for (const k of ['async function obtainPlan(', 'async function deriveFromTop(', 'async function fetchTop1(', 'async function decodeRecordingWeb(', 'async function trackId64(']) assert.ok(js.includes(k), k);
  assert.ok(js.includes("order: 'backward'"), '页面内微调从终点往起点扫');
  assert.ok(js.includes('不慢于榜单第 1 名') && js.includes('SOLVER.polishPlan(g, toggles, top.frames'));
  assert.ok(js.includes("tgt.mode === 'fast' ? await obtainPlan(ui, id) : await obtainPlanTarget(ui, id, tgt)"), '点击要走 obtainPlan(「最快」)/ obtainPlanTarget(带目标),而不是直接 loadPlan / solve');
  assert.ok(fs.readFileSync(root + 'scripts/lib/worker_shim.js', 'utf8').includes('trackId = tr.getId()'), 'Worker 的 track 消息要带上游戏自己算的 trackId');
});

test('网络:扩展自己只发两种只读 GET(榜单 / 回放),没有任何写入类请求', () => {
  const hosts = new Set(js.match(/https:\/\/vps\.kodub\.com[^'"`\s)]*/g) ?? []);
  assert.deepEqual([...hosts], ['https://vps.kodub.com/v6/'], '产物里只能出现榜单只读接口的前缀');
  assert.ok(js.includes("method: 'GET', credentials: 'omit'"), '榜单读取必须是不带 cookie 的 GET');
  assert.ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(js), '不能有写入类请求');
  assert.ok(!/\.send\((?!\))/.test(js.replace(/XMLHttpRequest[^;]*?x\.send\(\)/g, '')), '除了取 Worker 脚本的那一次 GET,没有 XHR 发送体');
  for (const p of ['leaderboard?version=0.6.3', 'recordings?version=0.6.3']) assert.ok(js.includes(p), p);
});

test('构建产物里没有游戏代码特征(Worker 脚本只在运行时取、只在内存补丁)', () => {
  assert.ok(!js.includes('PolyTrackPhysics().then')); // 游戏 Worker 脚本里的片段
  assert.ok(!js.includes('importScripts("lib/polytrack_physics.js")'));
  assert.ok(js.length < 400 * 1024);
});

test('占位符都已替换;本机方案通道存在(local.json 被 .gitignore,公开构建里是空表)', () => {
  assert.ok(!js.includes('__BUNDLED_PLANS__') && !js.includes('__LOCAL_PLANS__') && !js.includes('__BUILD_INFO__'));
  assert.ok(/const BUILD = \{"v":"\d+\.\d+\.\d+","t":"\d\d-\d\d \d\d:\d\d","local":\d+\}/.test(js)); // 页脚的构建标记(版本号 + 构建时间 + 本机方案条数)
  assert.ok(js.includes('const LOCAL_SEED = '));
  assert.match(fs.readFileSync(root + '.gitignore', 'utf8'), /extension\/plans\/local\.json/);
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
