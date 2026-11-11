# 附录:PolyTrack 0.6.3 内部机制(逆向观察,仅供个人学习)

来源:对 `app-polytrack.kodub.com/0.6.3/` 的 `main.bundle.js`(压缩)、`simulation_worker.bundle.js`(压缩)的阅读,
以及运行时旁路观察。以下均为"观察到的行为",变量名是压缩后的,不可当作稳定接口。每条都有对应的实测,见 `report/phase0.md`。

## 1. 架构

| 部分 | 说明 |
|---|---|
| 渲染 / UI / 输入 | 主线程,three.js + DOM。HUD 是 DOM 文本(计时器、车速、检查点计数),不需要 OCR。 |
| 物理 | 独立 Web Worker(`simulation_worker.bundle.js`),内部加载 Emscripten 编译的 C++/WASM 物理模块(`lib/polytrack_physics.js`)。 |
| 物理步长 | 固定 1 ms(1000 Hz)。1 帧 = 1 ms,所以"帧数"就是毫秒数,完成时间 = 完成帧数。 |
| 数学函数 | Worker 里把 `Math.sin/cos/atan2/exp/log/pow/sqrt/…` 换成自带的 WASM / 查表实现,目的是跨平台逐比特一致。 |
| 自检 | Worker 暴露 `TestDeterminism` 消息,调用 WASM 里的 `testDeterminism()`;实测返回 `true`。 |
| 回放验证 | Worker 暴露 `Verify` 消息:给赛道 + 回放 + 目标帧数,同步跑到完成或到达目标帧数,**仅当恰好在目标帧完成才返回 true**。 |

## 2. 实时循环(玩家开车时)

```
每次 rAF(或 60Hz 兜底定时器):
  o += clamp((performance.now() - last)/1000, 0, 0.1)      // 秒;一次最多追 100 步
  while (o > 0.001) { o -= 0.001; 对每辆已启动的车:先应用"帧号 <= 当前帧"的按键,再 updateCarModel(...) 前进 1 步 }
  把本轮每步的车辆状态缓冲区(<= 227 字节)postMessage 回主线程
```

* 按键事件在主线程直接 `postMessage({ControlCar, up,right,down,left,reset})` 给 Worker。
* Worker 给按键打帧号:`frame = car.frames + max(0, performance.now() - 上次tick时间[ms])`。
  **真实时间下它依赖墙钟时间(有抖动);虚拟时钟下时间在两次推进之间冻结,于是帧号恰好 = 当前已执行帧数。**
* 车辆的 `StartCar` 由主线程 rAF 循环在第一次按键后发出;启动前 `hasStarted=false`,Worker 不产生状态。

## 3. 非实时路径(幽灵 / 验证)

`Init.isRealtime=false` 时用 `setInterval(h)`:对带 `targetSimulationFrames` 的车,从回放里读每一帧的按键,
尽可能快地同步推进(单次调用内 100/车数 步 x 循环,受 10ms 真实时间预算限制)。`Verify` 是它的"无消息"变体。

## 4. 车辆状态缓冲区(Worker -> 主线程,实测解码)

| 偏移 | 字段 |
|---|---|
| 0..3 | carId (u32) |
| 4..6 | frames (u24):已执行帧数 |
| 7..10 | speedKmh (f32) |
| 11 | flags:bit0 hasStarted,bit1 finished,bit2 hasCheckpointToRespawnAt,bit3..6 各车轮接地 |
| 若 finished | finishFrames (u24) |
| 之后 | nextCheckpointIndex (u16),position f32x3,quaternion f32x4,碰撞冲量 u8 + n x f32,接地车轮 24 字节 x n,悬挂长度/速度、车轮转角、打滑各 f32x4,转向 f32,controls u8(bit0..4 = up/right/down/left/reset,bit5 刹车灯) |

## 5. 回放(recording)格式

五个按键(up, right, down, left, reset)各一个**升序"翻转帧号"列表**。某帧 t 的按键状态 = (翻转帧 <= t 的个数)是否为奇数。
每个列表序列化:`count(u24 LE)` + count 个 `u24 LE`(第一个绝对帧号,其后为差分)。五段顺序拼接 -> zlib deflate(level 9) -> base64url(去 `=`)。
`maxFrames = 5,999,999`(约 100 分钟)。主线程在每个状态到达时调用 `recordFrame(prevState.frames, newState.controls)` 构造它,
所以**回放记录的是"物理实际应用了什么",而不是"用户按了什么"**。

## 6. 重生(R 键)的两种语义

* 已经过至少一个检查点(`hasCheckpointToRespawnAt=1`):**物理重生**,在同一辆车、同一局里进行,计时继续。
  回放里 reset 记成一段 `[F, F+d]`:**d 不是常数**——实测按住 R 时 d = 1 帧(逐 1 ms 步进)/ 110 帧(100 ms 步进)/ 111 帧(7 ms+3 ms 交替步进),
  推测是"物理发生重生 -> 主线程处理到状态并清掉 reset 控制位"的确认延迟(**未用代码验证**)。单次点按(按下后下一帧松开)时 d = 1。物理结果(完成帧)不受 d 影响。
* 判定"有没有检查点可重生"用的是主线程已收到的最新状态:R 点按得离检查点很近(实测 RS1:检查点后约 40 帧)时,不同的主线程节奏会得到不同决策(重生 / 整局重来)。
* 尚未过任何检查点:**整局重来**。主线程在 R 的按键处理里立刻新建一辆车(carId+1),帧号从 0 重新开始;旧车停在原地不再前进。回放只含新一局。
  新一局以"当前按键状态"开局(例如 W 仍被按住)。

## 7. 赛道数据

* 赛道存档:`PolyTrack2` + base64 风格编码 -> 两层 deflate -> 部件列表。世界坐标 = 格子坐标 x 5(`partSize = 5`)。
* 部件分类:Special(起点/终点/检查点)、Road、RoadTurns、RoadWide、Plane、Block、WallTrack、Pillar、Sign。检测器类型:`Checkpoint=0`、`Finish=1`。
* 官方 Summer 1 在 0.6.3 里已经是 679 个部件的多层赛道(不是简单的教程直道)。

## 8. 网络

* 游戏静态资源:`app-polytrack.kodub.com/0.6.3/…`。
* 启动时会向 `vps.kodub.com`(用户/排行榜服务)发请求,携带一个本地生成的 `userToken`。本项目的 harness 一律拒绝该请求。
