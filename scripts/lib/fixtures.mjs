// 测试用输入脚本(帧号 = 物理帧,1 帧 = 1 ms)。赛道:scripts/data/mini_track.txt(直线赛道,Start -> Checkpoint -> Finish)。
export const S1 = [ // 按住 W 全程,中途左右各点一下方向(车仍沿路,最终完成赛道)
  { frame: 0, key: 'up', down: true },
  { frame: 2000, key: 'left', down: true }, { frame: 2150, key: 'left', down: false },
  { frame: 2400, key: 'right', down: true }, { frame: 2550, key: 'right', down: false },
];
export const S2 = [ // S1 + 过检查点后(约 5.5s)按一下重生键 R(40 帧),再继续按住 W 完成
  ...S1,
  { frame: 7000, key: 'reset', down: true }, { frame: 7040, key: 'reset', down: false },
];
export const S3 = [ // 检查点之前点一下 R:游戏不做物理重生,而是"整局重来"(新建车,帧号从 0 开始)。重来之后的事件用新一局的帧号。
  ...S1.map((e) => ({ ...e, run: 0 })),
  { run: 0, frame: 3000, key: 'reset', down: true },   // 游戏在状态流里看到 reset 上升沿且没有可重生检查点 => 整局重来
  { run: 1, frame: 100, key: 'reset', down: false },  // 重来之后才松开 R(此时已经是新一局的第 100 帧)
  // 新一局:W 仍被按住(游戏用当前按键状态开局),之后重复 S1 中的转向点按 => 预期与 S1 完全相同的轨迹与完成时间
  ...S1.filter((e) => e.frame > 0).map((e) => ({ ...e, run: 1 })),
];
// 伪随机密集脚本:~200 次按键翻转,包含 1 帧点按、同一帧多个按键(用于压力测试注入的帧精确性)
export function randomScript(seed, nToggles = 200, endFrame = 6000) {
  let s = seed >>> 0; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const keys = ['up', 'right', 'down', 'left']; const state = { up: false, right: false, down: false, left: false };
  const ev = [{ frame: 0, key: 'up', down: true }]; state.up = true;
  for (let i = 0; i < nToggles; i++) {
    const frame = 1 + Math.floor(rnd() * (endFrame - 1)); const key = keys[Math.floor(rnd() * 4)];
    ev.push({ frame, key, down: null });
  }
  ev.sort((a, b) => a.frame - b.frame);
  const out = [ev[0]];
  for (const e of ev.slice(1)) { // 保证每个键按下/松开交替
    if (e.frame === out[out.length - 1].frame && e.key === out[out.length - 1].key) continue;
    state[e.key] = !state[e.key]; out.push({ frame: e.frame, key: e.key, down: state[e.key] });
  }
  return out;
}

// 边界用例:1 帧点按、连续两帧换键、同一帧多个按键、W 只松开 1 帧
export const E1 = [
  { frame: 0, key: 'up', down: true },
  { frame: 1000, key: 'left', down: true }, { frame: 1001, key: 'left', down: false },
  { frame: 1001, key: 'right', down: true }, { frame: 1002, key: 'right', down: false },
  { frame: 1500, key: 'down', down: true }, { frame: 1500, key: 'left', down: true },
  { frame: 1501, key: 'down', down: false }, { frame: 1501, key: 'left', down: false },
  { frame: 2000, key: 'up', down: false }, { frame: 2001, key: 'up', down: true },
];

// 重生(R 键)压力脚本。检查点在约 5568 帧被触发;之后按 R 会做"物理重生"(回到检查点),之前按 R 则是"整局重来"。
const base = [{ frame: 0, key: 'up', down: true }];
export const RS1 = [ // 刚过检查点就重生;随后连续两帧各点一次 R;再隔一段点一次
  ...base,
  { frame: 5600, key: 'reset', down: true }, { frame: 5601, key: 'reset', down: false },
  { frame: 5900, key: 'reset', down: true }, { frame: 5901, key: 'reset', down: false },
  { frame: 5902, key: 'reset', down: true }, { frame: 5903, key: 'reset', down: false },
  { frame: 6600, key: 'reset', down: true }, { frame: 6601, key: 'reset', down: false },
];
export const RS2 = [ // 长按 R 300 帧;松开后再点;重生期间改变油门/方向
  ...base,
  { frame: 6000, key: 'reset', down: true }, { frame: 6000, key: 'left', down: true },
  { frame: 6150, key: 'up', down: false }, { frame: 6300, key: 'reset', down: false }, { frame: 6300, key: 'left', down: false },
  { frame: 6301, key: 'up', down: true },
  { frame: 6500, key: 'reset', down: true }, { frame: 6502, key: 'reset', down: false },
];
export const RS3 = [ // 先在检查点之前 R(整局重来),新一局里过检查点后再 R(物理重生),同一局里连续两次
  ...base.map((e) => ({ ...e, run: 0 })),
  { run: 0, frame: 3000, key: 'reset', down: true },
  { run: 1, frame: 100, key: 'reset', down: false },
  { run: 1, frame: 7000, key: 'reset', down: true }, { run: 1, frame: 7001, key: 'reset', down: false },
  { run: 1, frame: 7500, key: 'reset', down: true }, { run: 1, frame: 7501, key: 'reset', down: false },
];
