// 把页面内自动驾驶拼成一个文件 extension/autopilot.js(浏览器扩展内容脚本 / 油猴脚本共用)。
// 用法:node scripts/build_extension.mjs
// 拼接顺序:配置 -> page_shim.js(window.__pt:Worker 包装、状态解码、评估池)-> progress.mjs + refpath.mjs + solver.mjs + explorer.mjs(去掉 import/export)-> extension/src/core.js。
// 里面只有我们自己写的代码;游戏的 Worker 脚本在用户浏览器里运行时才取到,并只在内存中补丁(blob),不会写进本目录。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EVAL_CASES } from './lib/eval_patch.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const rd = (p) => fs.readFileSync(root + p, 'utf8');
const strip = (src) => src
  .replace(/^import .*?;\s*$/gm, '')
  .replace(/^export (const|let|function|async function|class) /gm, '$1 ');

const solverBundle = `const __ptSolverMod = (() => {\n${strip(rd('scripts/lib/progress.mjs'))}\n${strip(rd('scripts/lib/refpath.mjs'))}\n${strip(rd('scripts/lib/solver.mjs'))}\n${strip(rd('scripts/lib/explorer.mjs'))}\nreturn { Solver, masksToToggles, togglesToMasks, buildProgress, buildProgressField, buildTrajectoryProgress, exploreLap };\n})();\nwindow.__ptSolver = __ptSolverMod;`;
const core = rd('extension/src/core.js')
  .replace('__WORKER_SHIM__', () => JSON.stringify(rd('scripts/lib/worker_shim.js')))
  .replace('__EVAL_CASES__', () => JSON.stringify(EVAL_CASES))
  .replace('__BUNDLED_PLANS__', () => JSON.stringify(JSON.parse(fs.existsSync(root + 'extension/plans/bundled.json') ? rd('extension/plans/bundled.json') : '{}')));

const out = `// ==UserScript==
// @name         PolyTrack AI 自动驾驶(0.6.3,个人研究)
// @namespace    polytrack-ai
// @version      0.2.0
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
${core}
})();
`;
fs.writeFileSync(root + 'extension/autopilot.js', out);
console.log('已生成 extension/autopilot.js', (out.length / 1024).toFixed(1) + ' KB');
