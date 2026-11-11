// 独立复核:用游戏自带 Verify 校验一份求解结果 JSON(与求解器代码无关)。
// 用法:node scripts/verify_result.mjs --track scripts/data/slalom.txt --result out/slalom_v3.json
import fs from 'node:fs';
import { launchGame } from './lib/pt_harness.mjs';
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v.slice(2), arr[i + 1]]]), []));
const res = JSON.parse(fs.readFileSync(a.result, 'utf8'));
const g = await launchGame({ mainVirtual: true, customTrack: fs.readFileSync(a.track, 'utf8').trim() });
const n = res.finishFrames;
const at = await g.verify(res.recording, n, 3); const m1 = await g.verify(res.recording, n - 1, 1); const p1 = await g.verify(res.recording, n + 1, 1);
await g.close();
const ok = at.every((x) => x.result === true) && m1[0].result === false && p1[0].result === false;
console.log(JSON.stringify({ result: a.result, finishFrames: n, atFinish: at.map((x) => x.result), minus1: m1[0].result, plus1: p1[0].result, ok }));
process.exit(ok ? 0 : 1);
