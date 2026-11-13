// 批量评估引擎:在内存里拼进物理 Worker 脚本(仅个人研究;不落盘、不分发游戏文件)。
// 与游戏自己的 Verify 用同一套内部函数:s = 创建车辆物理模型,n = 步进 1 帧(1 ms)。
// 新增消息:
//   101 Prepare : 缓存赛道 + 山体顶点(来自游戏自己发给实时 Worker 的 CreateCar),清除已提交状态
//   100 Eval    : 对一批控制计划各自模拟,返回终态 / 完成帧 / 采样轨迹
//                 opts.fromCommit=true 时从"已提交快照"(WASM 线性内存快照)出发,否则从赛道起点出发
//   102 Commit  : 把一段动作提交为新的基准状态(在上一个快照基础上前进并重新快照)
//   103 Probe   : 返回 WASM 线性内存大小(调试用)
// 控制计划 = 动作码数组,每个动作持续 seg 帧;动作码 bit0 up, bit1 right, bit2 down, bit3 left, bit4 reset。
// opts.gate = {p:[x,y,z], d:[dx,dy,dz], post:[逐帧掩码], shifts:[每个计划的整数偏移]}:计划用完后沿用 tailArr,直到车越过"过 p 点、法向 d"的平面,
//   之后改用 post[f - 越过帧 + shift](把后半段按键按"越过时刻"对齐,容忍前面改动造成的时间差)。
// 计划用完后用 tail 掩码继续(或 opts.tailArr:一份所有计划共用的逐帧掩码数组,配合 seg=1 使用,省去重复传输),直到完成、掉出赛道(y < minY)或模拟了 maxFrames 帧。
// 状态向量 dec(): [帧数, 车速km/h, flags, 完成帧(-1=未完成), 下一个检查点序号, x, y, z, qx, qy, qz, qw]
export const EVAL_CASES = `case 101:self.__ev={trk:Ko.fromSaveString(r.trackData),mv:r.mountainVertices,mo:r.mountainOffset,snap:null,snap0:null,f:0};
self.__dec=function(u,f){const dv=new DataView(u.buffer,u.byteOffset,u.byteLength);const fl=u[11];let o=12,fin=-1;if(fl&2){fin=u[o]|u[o+1]<<8|u[o+2]<<16;o+=3}
const cp=dv.getUint16(o,true);o+=2;return[f,dv.getFloat32(7,true),fl,fin,cp,dv.getFloat32(o,true),dv.getFloat32(o+4,true),dv.getFloat32(o+8,true),dv.getFloat32(o+12,true),dv.getFloat32(o+16,true),dv.getFloat32(o+20,true),dv.getFloat32(o+24,true)]};
postMessage({__vt:"prep",id:r.id});break;
case 103:postMessage({__vt:"probe",id:r.id,heap:t.HEAPU8.length});break;
case 102:!function(e){
const V=self.__ev,seg=e.seg||1,dec=self.__dec;let u=null,f=0;
if(!V.snap0){s(1,V.mv,new R(V.mo.x,V.mo.y,V.mo.z),V.trk,V.trk.getStartTransform());V.snap0=t.HEAPU8.slice()}
if(V.snap&&!e.reset){t.HEAPU8.set(V.snap);f=V.f}else{t.HEAPU8.set(V.snap0);f=0}
const h={id:1};let fin=-1;
for(let ai=0;ai<e.actions.length;ai++){const m=e.actions[ai],sg=e.segs?e.segs[ai]:seg;for(let j=0;j<sg;j++){u=new Uint8Array(n(h,{up:!!(m&1),right:!!(m&2),down:!!(m&4),left:!!(m&8),reset:!!(m&16)}));f++;if(u[11]&2){fin=u[12]|u[13]<<8|u[14]<<16;break}}if(fin>=0)break}
V.snap=t.HEAPU8.slice();V.f=f;
postMessage({__vt:"commit",id:e.id,frames:f,fin:fin,last:u?dec(u,f):null})}(r);break;
case 100:!function(e){
const V=self.__ev,dec=self.__dec,out=[];
const maxF=Math.min(e.maxFrames||60000,5999999),se=e.sampleEvery|0,seg=e.seg||1,tail=e.tail|0,minY=e.minY==null?-1e9:e.minY;
let bd=null;if(e.segs){bd=[];let c=0;for(const x of e.segs){c+=x;bd.push(c)}}
const smpAt=e.sampleAt?new Set(e.sampleAt):null;const TA=e.tailArr||null;
const CS=e.crashStop||null;const hist=CS?new Float32Array(CS.w|0||50):null;
let st=null;
if(!e.fromCommit)st=V.trk.getStartTransform();else{if(!V.snap0){s(1,V.mv,new R(V.mo.x,V.mo.y,V.mo.z),V.trk,V.trk.getStartTransform());V.snap0=t.HEAPU8.slice()}if(!V.snap){V.snap=V.snap0;V.f=0}}
for(let k=0;k<e.plans.length;k++){
const plan=e.plans[k],id=e.fromCommit?1:e.carIdBase+k;
let f0=0;
if(e.fromCommit){t.HEAPU8.set(V.snap);f0=V.f}else s(id,V.mv,new R(V.mo.x,V.mo.y,V.mo.z),V.trk,st);
const h={id};let f=f0,u=null,fin=-1,dead=false,ai=0,crashed=false;const smp=[];
const GT=e.gate||null;let crossed=false,fc=0;const sh=GT&&GT.shifts?(GT.shifts[k]|0):0;
for(;f<f0+maxF;f++){
let a;if(bd){while(ai<bd.length&&f-f0>=bd[ai])ai++;a=ai}else a=((f-f0)/seg)|0;let m=a<plan.length?plan[a]:(TA?(TA[a-plan.length]??tail):tail);
if(crossed){const pi=f-fc+sh;m=(pi>=0&&pi<GT.post.length)?GT.post[pi]:tail}
u=new Uint8Array(n(h,{up:!!(m&1),right:!!(m&2),down:!!(m&4),left:!!(m&8),reset:!!(m&16)}));
if(u[11]&2){fin=u[12]|u[13]<<8|u[14]<<16;f++;break}
if(CS){const sp=new DataView(u.buffer,u.byteOffset,u.byteLength).getFloat32(7,true),k=(f-f0)%hist.length,old=hist[k];hist[k]=sp;if(f-f0>=hist.length&&old-sp>CS.drop&&old>CS.minV){crashed=true;f++;break}}
if(GT&&!crossed&&a>=plan.length){const dv=new DataView(u.buffer);if((dv.getFloat32(14,true)-GT.p[0])*GT.d[0]+(dv.getFloat32(18,true)-GT.p[1])*GT.d[1]+(dv.getFloat32(22,true)-GT.p[2])*GT.d[2]>=0){crossed=true;fc=f+1}}
if(smpAt?smpAt.has(f+1-f0):(se&&(f+1-f0)%se===0))smp.push(dec(u,f+1));
if(minY>-1e8&&new DataView(u.buffer).getFloat32(18,true)<minY){dead=true;f++;break}}
let extra=0;
if(e.airMax&&fin<0&&!dead&&!crashed&&((u[11]>>3)&15)===0){const am=e.airTail|0,settle=e.airSettle==null?100:e.airSettle;let landed=0;
while(extra<e.airMax){const w=(u[11]>>3)&15;if(w>0){landed++;if(landed>settle)break}else landed=0;
u=new Uint8Array(n(h,{up:!!(am&1),right:!!(am&2),down:!!(am&4),left:!!(am&8),reset:false}));f++;extra++;
if(u[11]&2){fin=u[12]|u[13]<<8|u[14]<<16;break}
if(minY>-1e8&&new DataView(u.buffer).getFloat32(18,true)<minY){dead=true;break}}}
if(!e.fromCommit)t.ccall("deleteCarModel","void",["number"],[id]);
out.push({frames:f,fin:fin,dead:dead,crashed:crashed,last:dec(u,f),smp:smp,extra:extra,fc:crossed?fc:0})}
postMessage({__vt:"eval",id:e.id,results:out})}(r);break;
`;
