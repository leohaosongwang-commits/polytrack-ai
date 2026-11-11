// 把一次求解结果渲染成单文件 HTML 报告(俯视轨迹按车速着色、速度曲线、按键时间线、回放串)。
// 用法:node scripts/render_html.mjs --track scripts/data/slalom.txt --result out/slalom.json --out out/slalom.html
import fs from 'node:fs';
import { launchGame } from './lib/pt_harness.mjs';
import { togglesToMasks } from './lib/solver.mjs';

function args(argv) { const o = {}; for (let i = 0; i < argv.length; i += 2) o[argv[i].slice(2)] = argv[i + 1]; return o; }

export async function renderHtml({ trackFile, resultFile, outFile }) {
  const res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const g = await launchGame({ exposeTrack: true, mainVirtual: true, customTrack: fs.readFileSync(trackFile, 'utf8').trim() });
  try {
    const ti = await g.trackInfo();
    await g.makePool(1);
    const masks = togglesToMasks(res.toggles, res.finishFrames);
    const [r] = await g.evalBatch([Array.from(masks)], { seg: 1, tail: 1, maxFrames: res.finishFrames + 5, sampleEvery: 20 });
    const road = []; for (const p of ti.parts) if (p.category <= 3) for (const c of p.cells) road.push([c[0], c[2], p.partId]);
    const traj = r.smp.map((s) => [s[0], +s[5].toFixed(2), +s[7].toFixed(2), +s[1].toFixed(1), +s[6].toFixed(1)]);
    const cps = ti.parts.filter((p) => ti.info[p.partId]?.detector).map((p) => ({ x: p.x * 5, z: p.z * 5, type: ti.info[p.partId].detector.type }));
    const data = { name: trackFile.split('/').pop(), finishFrames: res.finishFrames, verify: res.verify, verifyOk: res.verifyOk, baseline: res.baseline, phaseA: res.phaseA?.finishFrames, phaseB: res.phaseB?.finishFrames ?? null, params: res.params, recording: res.recording, road, traj, cps, masks: Array.from(masks.filter((_, i) => i % 10 === 0)) };
    fs.writeFileSync(outFile, HTML.replace('/*DATA*/', 'const DATA=' + JSON.stringify(data) + ';'));
    return outFile;
  } finally { await g.close(); }
}

const HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PolyTrack 求解报告</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mut:#667085;--line:#e3e6ea;--ok:#12805c;--bad:#b42318;--acc:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#e8eaee;--mut:#98a2b3;--line:#2a2f39;--ok:#4ade80;--bad:#f87171;--acc:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 48px}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.stat b{display:block;font-size:20px}.stat span{color:var(--mut);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:14px}.card h2{font-size:14px;margin:0 0 8px;color:var(--mut);font-weight:600}
svg{width:100%;height:auto;display:block}textarea{width:100%;height:76px;font:12px/1.3 ui-monospace,monospace;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:6px 12px;cursor:pointer}.ok{color:var(--ok)}.bad{color:var(--bad)}.leg{display:flex;align-items:center;gap:8px;color:var(--mut);font-size:12px;margin-top:6px}
.bar{height:8px;flex:0 0 160px;border-radius:4px;background:linear-gradient(90deg,#3b82f6,#22c55e,#facc15,#ef4444)}
</style></head><body><main>
<h1>PolyTrack 离线求解报告</h1><div class="sub" id="sub"></div>
<div class="grid" id="stats"></div>
<div class="card"><h2>俯视轨迹(颜色 = 车速)</h2><svg id="map" viewBox="0 0 900 500"></svg><div class="leg"><span>慢</span><div class="bar"></div><span>快</span><span id="vmax"></span></div></div>
<div class="card"><h2>车速 - 时间</h2><svg id="spd" viewBox="0 0 900 180"></svg></div>
<div class="card"><h2>按键时间线(每 10 ms 一格)</h2><svg id="keys" viewBox="0 0 900 70"></svg></div>
<div class="card"><h2>回放串(游戏回放格式)</h2><textarea id="rec" readonly></textarea><p><button id="cp">复制</button> <span class="sub">仅供本地离线研究;请先确认目标排行榜/社区对 TAS、机器人的规则,不要擅自提交。</span></p></div>
</main><script>
/*DATA*/
const $=(i)=>document.getElementById(i);const D=DATA;const S=(f)=>(f/1000).toFixed(3)+' s';
$('sub').textContent='赛道 '+D.name+' · 种子 '+D.params.seed+' · 工作线程 '+D.params.workers;
const base=D.baseline.holdW.finishFrames;
const stats=[['最终圈速',S(D.finishFrames)],['规划阶段',S(D.phaseA)],['打磨后',D.phaseB?S(D.phaseB):'—'],['基线(一直按 W)',base?S(base):'未完成'],['游戏 Verify',D.verifyOk?'通过 ✔':'失败 ✘']];
$('stats').innerHTML=stats.map(([a,b])=>'<div class="stat"><span>'+a+'</span><b class="'+(a==='游戏 Verify'?(D.verifyOk?'ok':'bad'):'')+'">'+b+'</b></div>').join('');
const col=(t)=>{const st=[[59,130,246],[34,197,94],[250,204,21],[239,68,68]];const x=Math.max(0,Math.min(.999,t))*3,i=Math.floor(x),f=x-i;const a=st[i],b=st[i+1];return 'rgb('+a.map((v,k)=>Math.round(v+(b[k]-v)*f)).join(',')+')'};
// 地图:世界 x 对应横轴,z 对应纵轴(自适应缩放)
const xs=D.traj.map(p=>p[1]),zs=D.traj.map(p=>p[2]);const rx=D.road.map(r=>r[0]*5+2.5),rz=D.road.map(r=>r[1]*5+2.5);
const minX=Math.min(...xs,...rx)-10,maxX=Math.max(...xs,...rx)+10,minZ=Math.min(...zs,...rz)-10,maxZ=Math.max(...zs,...rz)+10;
const W=900,H=500,sc=Math.min(W/(maxX-minX),H/(maxZ-minZ));const ox=(W-(maxX-minX)*sc)/2,oy=(H-(maxZ-minZ)*sc)/2;
const X=(x)=>ox+(x-minX)*sc,Y=(z)=>oy+(z-minZ)*sc;let m='';
for(const r of D.road)m+='<rect x="'+X(r[0]*5)+'" y="'+Y(r[1]*5)+'" width="'+5*sc+'" height="'+5*sc+'" fill="currentColor" opacity=".10"/>';
const vmax=Math.max(...D.traj.map(p=>p[3]));$('vmax').textContent='最高 '+vmax.toFixed(0)+' km/h';
for(let i=1;i<D.traj.length;i++){const a=D.traj[i-1],b=D.traj[i];m+='<line x1="'+X(a[1])+'" y1="'+Y(a[2])+'" x2="'+X(b[1])+'" y2="'+Y(b[2])+'" stroke="'+col(b[3]/vmax)+'" stroke-width="2.2" stroke-linecap="round"/>'}
for(const c of D.cps)m+='<rect x="'+(X(c.x)-4)+'" y="'+(Y(c.z)-4)+'" width="8" height="8" fill="'+(c.type?'#ef4444':'#22c55e')+'"/>';
$('map').innerHTML=m;
// 速度曲线
const T=D.traj.map(p=>p[0]);const tm=Math.max(...T);let s='<polyline fill="none" stroke="var(--acc)" stroke-width="1.6" points="'+D.traj.map(p=>(30+p[0]/tm*850).toFixed(1)+','+(165-p[3]/vmax*150).toFixed(1)).join(' ')+'"/>';
for(let k=0;k<=4;k++){const v=vmax*k/4;s+='<line x1="30" x2="880" y1="'+(165-150*k/4)+'" y2="'+(165-150*k/4)+'" stroke="var(--line)"/><text x="2" y="'+(168-150*k/4)+'" font-size="10" fill="var(--mut)">'+v.toFixed(0)+'</text>'}
s+='<text x="30" y="178" font-size="10" fill="var(--mut)">0 s</text><text x="840" y="178" font-size="10" fill="var(--mut)">'+(tm/1000).toFixed(1)+' s</text>';$('spd').innerHTML=s;
// 按键时间线
const n=D.masks.length,cw=880/n;let k='';const rows=[[1,'W','#22c55e'],[8,'L','#3b82f6'],[2,'R','#f59e0b'],[4,'S','#ef4444']];
rows.forEach(([bit,l,c],r)=>{k+='<text x="2" y="'+(14+r*16)+'" font-size="10" fill="var(--mut)">'+l+'</text>';let i=0;while(i<n){if(D.masks[i]&bit){let j=i;while(j<n&&(D.masks[j]&bit))j++;k+='<rect x="'+(18+i*cw*0.98).toFixed(1)+'" y="'+(6+r*16)+'" width="'+Math.max(1,(j-i)*cw*0.98).toFixed(1)+'" height="10" fill="'+c+'"/>';i=j}else i++}});
$('keys').innerHTML=k;$('rec').value=D.recording;$('cp').onclick=()=>{navigator.clipboard?.writeText(D.recording);$('cp').textContent='已复制'};
</script></body></html>`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args(process.argv.slice(2));
  console.log(await renderHtml({ trackFile: a.track, resultFile: a.result, outFile: a.out }));
}
