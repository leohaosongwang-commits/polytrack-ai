// 把页面内自动驾驶拼成一个文件 extension/autopilot.js(浏览器扩展内容脚本 / 油猴脚本共用)。
// 用法:node scripts/build_extension.mjs [--public] [--no-bundled] [--out 路径]
//   --public       不内联本机方案(extension/plans/local.json),公开构建 / 推送用
//   --no-bundled   连内置方案(bundled.json)也不内联:做出一份"没有任何现成方案"的产物,只给端到端测试用(配合 --out,别覆盖 extension/autopilot.js)
// 拼接顺序:配置 -> page_shim.js(window.__pt:Worker 包装、状态解码、评估池)-> progress.mjs + refpath.mjs + solver.mjs + tas_core.mjs + explorer.mjs(去掉 import/export)-> guide.mjs(引导线数学,window.__ptGuideMath)+ extension/src/guide.js(相机钩子 + 叠加层)-> extension/src/core.js。
// 里面只有我们自己写的代码;游戏的 Worker 脚本在用户浏览器里运行时才取到,并只在内存中补丁(blob),不会写进本目录。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EVAL_CASES } from './lib/eval_patch.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const rd = (p) => fs.readFileSync(root + p, 'utf8');
const argOf = (k) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null; };
const strip = (src) => src
  .replace(/^import .*?;\s*$/gm, '')
  .replace(/^export (const|let|function|async function|class) /gm, '$1 ');

const solverBundle = `const __ptSolverMod = (() => {\n${strip(rd('scripts/lib/progress.mjs'))}\n${strip(rd('scripts/lib/refpath.mjs'))}\n${strip(rd('scripts/lib/solver.mjs'))}\n${strip(rd('scripts/lib/tas_core.mjs'))}\n${strip(rd('scripts/lib/explorer.mjs'))}\nreturn { Solver, masksToToggles, togglesToMasks, buildProgress, buildProgressField, buildTrajectoryProgress, exploreLap, polishPlan };\n})();\nwindow.__ptSolver = __ptSolverMod;`;
const guideBundle = `window.__ptGuideMath = (() => {\n${strip(rd('scripts/lib/guide.mjs'))}\nreturn { GUIDE_STEP, GUIDE_DEFAULTS, buildGuidePath, projectGuide, mulMat4, clipOf, actColor };\n})();\n${rd('extension/src/guide.js')}`;
// 版本号只在 extension/manifest.json 里改一处;油猴脚本头、面板页脚、chrome://extensions 里显示的都从它来
const VERSION = JSON.parse(rd('extension/manifest.json')).version;
const localPlans = !process.argv.includes('--public') && fs.existsSync(root + 'extension/plans/local.json') ? JSON.parse(rd('extension/plans/local.json')) : {};
const core = rd('extension/src/core.js')
  .replace('__WORKER_SHIM__', () => JSON.stringify(rd('scripts/lib/worker_shim.js')))
  .replace('__EVAL_CASES__', () => JSON.stringify(EVAL_CASES))
  .replace('__BUNDLED_PLANS__', () => JSON.stringify(process.argv.includes('--no-bundled') ? {} : JSON.parse(fs.existsSync(root + 'extension/plans/bundled.json') ? rd('extension/plans/bundled.json') : '{}')))
  // 本机方案(extension/plans/local.json,被 .gitignore):--public 时不内联,公开构建 / 推送用它
  .replace('__LOCAL_PLANS__', () => JSON.stringify(localPlans))
  // 构建标记:面板页脚显示"构建时间 + 本机方案条数",一眼看出 Chrome 里加载的是哪一版(改了文件后要在 chrome://extensions 点 ↻ 才会换成新版)
  .replace('__BUILD_INFO__', () => JSON.stringify({ v: VERSION, t: new Date().toLocaleString('sv-SE', { hour12: false }).slice(5, 16), local: Object.keys(localPlans).length }));

const out = `// ==UserScript==
// @name         PolyTrack AI 自动驾驶(0.6.3,个人研究)
// @namespace    polytrack-ai
// @version      ${VERSION}
// @match        https://app-polytrack.kodub.com/0.6.3/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
// 由 scripts/build_extension.mjs 生成,请改源文件后重新构建。
(() => {
  'use strict';
  if (window.__ptaiLoaded) return; window.__ptaiLoaded = true;
  if (!location.href.startsWith('https://app-polytrack.kodub.com/0.6.3/')) return;
  window.__ptCfg = { mainVirtual: false, sampleEvery: 0, keepAll: false, keepRecording: false };
${rd('scripts/lib/page_shim.js')}
${solverBundle}
${guideBundle}
${core}
})();
`;
const outPath = argOf('--out') ?? root + 'extension/autopilot.js';
fs.writeFileSync(outPath, out);
console.log('已生成', outPath.startsWith(root) ? outPath.slice(root.length) : outPath, (out.length / 1024).toFixed(1) + ' KB');
