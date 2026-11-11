// PolyTrack 0.6.3 — 自己实现的二进制格式编解码(依据对压缩代码行为的观察,仅供个人研究)。
//
// 1) 车辆状态缓冲区(物理 Worker -> 主线程的 UpdateResult,最长 227 字节)
//    [0..3]  carId        u32 LE
//    [4..6]  frames       u24 LE   已模拟帧数(1 帧 = 1 ms,物理 1000 Hz)
//    [7..10] speedKmh     f32
//    [11]    flags        bit0 hasStarted, bit1 finished, bit2 hasCheckpointToRespawnAt,
//                         bit3..6 对应 4 个车轮是否接触地面
//    [..]    finishFrames u24(仅 finished 时存在)
//    [..]    nextCheckpointIndex u16
//    [..]    position f32x3, quaternion f32x4
//    [..]    nImpulses u8, 然后 n 个 f32
//    [..]    每个接触的车轮 24 字节(接触点 xyz + 法线 xyz)
//    [..]    suspensionLength f32x4, suspensionVelocity f32x4, deltaRotation f32x4, skidInfo f32x4
//    [..]    steering f32
//    [..]    controls u8: bit0 up, bit1 right, bit2 down, bit3 left, bit4 reset, bit5 brakeLight
//
// 2) 回放(recording):五个按键 up/right/down/left/reset,各一个"翻转帧号"升序列表。
//    每个列表序列化为: count u24 LE + count 个 u24 LE(第一个是绝对帧号,之后是与前一项的差)。
//    五段依次拼接 -> zlib deflate(level 9) -> base64url(去掉 '=' 填充)。
//    某帧 t 的按键状态 = (翻转帧号 <= t 的个数) 为奇数。maxFrames = 5,999,999。
import zlib from 'node:zlib';

export const KEYS = ['up', 'right', 'down', 'left', 'reset'];
export const MAX_FRAMES = 5999999;

export function decodeCarState(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let i = 0;
  const carId = dv.getUint32(i, true); i += 4;
  const frames = u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16); i += 3;
  const speedKmh = dv.getFloat32(i, true); i += 4;
  const fl = u8[i]; i += 1;
  const hasStarted = !!(fl & 1), finished = !!(fl & 2), hasCheckpointToRespawnAt = !!(fl & 4);
  const contact = [!!(fl & 8), !!(fl & 16), !!(fl & 32), !!(fl & 64)];
  let finishFrames = null;
  if (finished) { finishFrames = u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16); i += 3; }
  const nextCheckpointIndex = dv.getUint16(i, true); i += 2;
  const position = { x: dv.getFloat32(i, true), y: dv.getFloat32(i + 4, true), z: dv.getFloat32(i + 8, true) }; i += 12;
  const quaternion = { x: dv.getFloat32(i, true), y: dv.getFloat32(i + 4, true), z: dv.getFloat32(i + 8, true), w: dv.getFloat32(i + 12, true) }; i += 16;
  const nImp = u8[i]; i += 1; i += 4 * nImp;
  for (const c of contact) if (c) i += 24;
  i += 16 * 4; // suspLen, suspVel, deltaRot, skid
  const steering = dv.getFloat32(i, true); i += 4;
  const cb = u8[i]; i += 1;
  const controls = { up: !!(cb & 1), right: !!(cb & 2), down: !!(cb & 4), left: !!(cb & 8), reset: !!(cb & 16) };
  return { carId, frames, speedKmh, hasStarted, finishFrames, hasCheckpointToRespawnAt, nextCheckpointIndex,
    position, quaternion, steering, controls, brakeLight: !!(cb & 32), numBytes: i };
}

// ---- 回放编解码 ----
function encodeList(list) {
  const out = Buffer.alloc(3 + 3 * list.length);
  out[0] = list.length & 255; out[1] = (list.length >> 8) & 255; out[2] = (list.length >> 16) & 255;
  list.forEach((f, k) => {
    const d = k === 0 ? f : f - list[k - 1];
    if (d < 0 || d > 0xffffff) throw new Error('bad toggle list');
    out[3 + 3 * k] = d & 255; out[4 + 3 * k] = (d >> 8) & 255; out[5 + 3 * k] = (d >> 16) & 255;
  });
  return out;
}
function decodeList(buf, off) {
  const n = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
  const list = [];
  for (let k = 0; k < n; k++) {
    const d = buf[off + 3 + 3 * k] | (buf[off + 4 + 3 * k] << 8) | (buf[off + 5 + 3 * k] << 16);
    list.push(k === 0 ? d : list[k - 1] + d);
  }
  return { list, next: off + 3 + 3 * n };
}
/** toggles: { up:[frames], right:[..], down:[..], left:[..], reset:[..] }  -> 回放字符串 */
export function encodeRecording(toggles) {
  const raw = Buffer.concat(KEYS.map((k) => encodeList(toggles[k] ?? [])));
  return zlib.deflateSync(raw, { level: 9 }).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeRecording(str) {
  const raw = zlib.inflateSync(Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  const toggles = {}; let off = 0;
  for (const k of KEYS) { const r = decodeList(raw, off); toggles[k] = r.list; off = r.next; }
  return toggles;
}
/** 把"在某帧按下/松开某键"的事件表 [{frame, key, down}] 转成 toggles */
export function eventsToToggles(events) {
  const t = Object.fromEntries(KEYS.map((k) => [k, []]));
  const state = Object.fromEntries(KEYS.map((k) => [k, false]));
  for (const e of [...events].sort((a, b) => a.frame - b.frame)) {
    if (state[e.key] !== e.down) { t[e.key].push(e.frame); state[e.key] = e.down; }
  }
  return t;
}
/** 某帧的按键状态(与游戏 getFrame 的语义一致) */
export function controlsAt(toggles, frame) {
  const o = {};
  for (const k of KEYS) { let n = 0; for (const f of toggles[k]) { if (f <= frame) n++; else break; } o[k] = n % 2 === 1; }
  return o;
}
// 复刻主线程 recordFrame(prev.frames, new.controls) 的逻辑,从状态流重建回放
export class RecordingBuilder {
  constructor() { this.t = Object.fromEntries(KEYS.map((k) => [k, []])); this.last = null; }
  record(frame, controls) {
    if (this.last !== null && frame <= this.last) throw new Error('frame not increasing');
    this.last = frame;
    for (const k of KEYS) { const cur = this.t[k].length % 2 === 1; if (controls[k] !== cur) this.t[k].push(frame); }
  }
}
