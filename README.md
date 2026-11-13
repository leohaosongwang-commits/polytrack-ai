# PolyTrack AI — 离线搜索(TAS 式)原型

在 PolyTrack 0.6.3 自带的**确定性物理**上做离线搜索:用批量并行评估 + WASM 状态快照,找出更快的整圈按键序列,
输出游戏自己的回放格式,并用游戏自带的 `Verify` 校验。

* 阶段 0(可行性验证)结论与实测证据:`report/phase0.md`(内部机制附录:`report/phase0_internals.md`)
* 原型(搜索器 + CLI + HTML 报告 + 测试):本文件

> **规则提醒**:这是个人学习/研究用的本地离线工具。它不会向游戏服务器上传任何东西(harness 拒绝所有游戏静态资源之外的请求)。
> TAS/机器人成绩能否提交到官方排行榜取决于社区与开发者的规则,**我没有查证到官方明文规定**(speedrun.com 对我的网络 403)。
> 提交之前请先去官方 Discord / itch.io 论坛确认,不要擅自提交。

## 在正版页面里用:Chrome 扩展(面板 + 一键自动驾驶)

`extension/` 是一个 Chrome 扩展(MV3,Chrome ≥ 111),只在 `https://app-polytrack.kodub.com/0.6.3/` 生效:页面右上角出现面板,点 **▶ 一键自动驾驶** → 没有这条赛道的方案就先在页面里求解(几分钟),再回到起点按方案自动开。
安装、面板说明、已知限制见 [`extension/README.md`](extension/README.md)。扩展**不碰网络**:不包装 XHR / fetch / sendBeacon,也没有 `declarativeNetRequest` 规则,成绩提交与排行榜读取完全交回游戏页面。

```bash
node scripts/build_extension.mjs                                                           # 构建 extension/autopilot.js
node scripts/test_extension.mjs --track scripts/data/slalom.txt --plan out/mac_slalom_field.json --twice   # 用缓存方案连开两次(第二次先按 T)
node scripts/test_extension.mjs --track scripts/data/slalom.txt                            # 页面内求解 + 自动驾驶
node scripts/play_replay.mjs --track scripts/data/slalom.txt --result out/mac_slalom_field.json --pace 1  # 有窗口地按 1 倍速放一份结果
```

本机(macOS)跑脚本:没有 Playwright 自带 Chromium 时用 `PT_CHROME=1`(用本机 Google Chrome),想看窗口加 `PT_HEADED=1`。

## 快速开始

需要 Node 18+、`playwright`(自带 Chromium)、能访问 `app-polytrack.kodub.com` 的网络。

```bash
# 1) 生成测试赛道(游戏自己的序列化器生成;输出的是我们自己设计的数据)
node scripts/make_slalom.mjs slalom                                  # 6 个 S 弯,约 1.1 km
BENDS=2 LEAD=3 TAIL=3 CP=1 node scripts/make_slalom.mjs slalom_mini  # 测试用小赛道

# 2) 求解(规划 + 打磨),输出 out/slalom.recording.txt 与 out/slalom.json
node scripts/solve.mjs --track scripts/data/slalom.txt --out out/slalom --seconds 90

# 3) 渲染 HTML 报告(俯视轨迹按车速着色、速度曲线、按键时间线、回放串)
node scripts/render_html.mjs --track scripts/data/slalom.txt --result out/slalom.json --out out/slalom.html

# 4) 阶段 0 实验(报告口径:t1/t1b/t2/t3 全量,t4 用 QUICK=1;重生压力测试单独跑)
QUICK=1 node scripts/run_all.mjs   # 或全量 node scripts/run_all.mjs(t4 很慢)
node scripts/t3b_respawn.mjs

# 5) 测试
node --test test/unit.test.mjs        # 纯单元测试,秒级
node --test test/engine.test.mjs      # 评估引擎 vs 游戏 Verify、快照逐比特一致(需浏览器)
node --test test/solver.test.mjs      # 端到端(几分钟)
```

`solve.mjs` 常用参数:`--segs 40x6,100x6,240x4`(规划时域,"帧数 x 个数"),`--pop 96 --iters 3`(CEM 种群/迭代),
`--commit 6`(每轮提交几个动作),`--seconds N` 或 `--polish-iters N`(打磨预算;后者可复现),`--seed`,`--resume 旧.json`(跳过规划只打磨),`--trace`,`--official`(用游戏默认赛道,即 Summer 1),`--potential polyline|field`,`--half-width / --off-penalty`(离路面惩罚)。规划阶段若 4000 帧内进度增长不足 4 m 会快速失败并写出 `.failed.json` 现场。 另有 `scripts/lib/explorer.mjs`(`solve.mjs --explore [--explore-seconds 600 --explore-resume 上次的.frontier.json]`:档案 + 随机展开找任意一条冲线路线,再打磨)、`scripts/bench.mjs`(批量跑赛道 / 种子并汇总)、`scripts/diag_fail.mjs`(重放失败现场、列出停滞点附近的零件)、`scripts/make_local_plan.mjs`(把一条回放串验证后做成本地方案)、`scripts/tas_polish.mjs`(帧级局部搜索,直接以完成帧为目标),以及 `--actions W,WL,WR,S,SL,SR`(扩展动作集)、`--crash-stop 窗口帧,掉速km/h,最低速km/h`(默认开 50,25,60;候选一撞就在引擎里提前结束,`--no-crash-stop` 关)、`--carry-mass`(默认 0.8)、`--game-track summer3`(官方赛道,内存里转手)和 `scripts/refine.mjs`(沿已有方案分段择优 / 束搜索:`--src 结果.json --out 前缀 --n 8 --beam 2 --cuts ...`)。

## 原理

1. **批量评估引擎**(`lib/eval_patch.js`):在内存里给游戏的物理 Worker 脚本加几条消息,直接调用游戏自己 `Verify` 用的内部函数
   (创建车 / 步进 1 帧)。一批"控制计划"并行发给 N 个 Worker,返回终态 / 完成帧 / 采样轨迹。
   整套物理在 WASM 线性内存里,所以还能 **快照/恢复**(20 MB,几毫秒),实现"从某状态出发评估一批后续计划"。
2. **进度势能**(`lib/progress.mjs`):用游戏自己的赛道解析器拿到部件格子,对道路格做 BFS 得到起点->终点中线折线,
   把车的位置投影成"沿中线弧长 s + 偏离 d"。
3. **阶段 A 规划**(`lib/solver.mjs: plan`):滚动时域 CEM。前面的动作短(40 帧),远处的动作长(100/240 帧),这样既能看到 2 秒外的弯又不会维度爆炸;
   评分 = 冲线(1e6 - 完成帧)> 存活 > 进度 + 速度项 - 偏离惩罚 - 切换惩罚;每轮只提交前几个动作(提交 = 在快照上前进并重新快照)。
4. **阶段 B 打磨**(`polish`):随机选窗口(30/60/120/240 帧),快照到窗口起点,批量变异窗口并连同原计划尾部各模拟 1000 帧,
   用局部评分挑最好的;再做一次整圈精确评估,**完成帧不变差才接受**。
5. **校验**:把按键序列编码成游戏回放串,用游戏自带 `Verify`(仅当恰好在目标帧完成才为 true)重复校验,并做 ±1 帧反例对照。

## 当前局限(诚实清单)

* 进度势能有两种:`--potential polyline`(单主路 BFS 中线)和 `--potential field`(按检查点分段的 Dijkstra 距离场,支持多层 / 跳跃 / 检查点折返;**CLI 和扩展现在默认用它**)。在自制蛇形赛道上 field 明显更好(见下)。
* **官方 Summer 1 现在能跑完整圈**(详见 `report/phase0.md` 6.6 / 6.7):势能原先有三处错误(向上跳跃边过宽、把叠起来的实心方块当路面、没有表示"坡道起跳的大跳"),都已修;停滞后回退得不够远是另一个原因。目前最好 **26.961 s**(游戏 Verify 通过,已内置进扩展;靠 `scripts/refine.mjs` 分段择优);冷跑一次 31.520 s。**不是最优**:榜单第 1 名 22.123 s,差别在线路与手法(骑坡道、漂移、空中刹车),求解器自己发现不了,详见 `report/phase0.md` 6.8。
* **求解器方差很大**:slalom 同参数同种子,不同版本得到 15.606 / 17.402 / 21.180 s;15.604 s 不是最优,也没有最优性证明。曾出现过约 1.1 s、两圈的撞后翻滚(18.225 s 那次),现在翻滚会被扣分,但不是根治。
* slalom 的撞墙已经消失:用 field 势能的结果(`out/mac_slalom_field.*`,15.604 s,Verify 通过)速度曲线上没有任何 60 帧内降速 > 25 km/h 的点。之前 polyline 结果(16.835 s)的撞击发生在最后一个 S 弯入口:车速 336 km/h 撞墙(规划时域只有 1.8 s,看不到弯)。**这是一次实测对比,不是根治**:没有换种子、没有换赛道验证,高速入弯没有结构化的速度上限。
* 搜索质量没有和"真实最优"对比过(粗估直线理想值 ≈13.7 s)。按键时间线抖动仍然很多。
* 动作集只有 W / W+左 / W+右 / 刹车;没用 R(检查点重生)。重生在阶段 0 的压力测试里行为一致,但搜索器没利用它。
* 速度:单次整圈评估 ≈ 50~120 ms(单 Worker);规划时间 97% 是物理模拟,4 线程约 38 万帧/s。slalom 规划约 1.5 分钟(4 线程,撞击提前结束后少约 40% 模拟帧,`report/phase0.md` 6.10)。
* **新赛道不保证能算出来**:滚动时域规划器在官方 summer2、summer3 上都失败(都含近乎垂直的墙 / 环形曲面结构,渲染截图确认,格子势场表达不了;见 `report/phase0.md` 6.11)。**`solve.mjs --explore`(Go-Explore 式探索,6.13)解出了 summer3**(27.205 s,游戏 Verify 通过,147 s),summer2 冲过了墙和长跳但没冲线;扩展页面内求解在规划器停滞后会自动改用探索,summer4~7 / winter / desert 没测。能跑通的只有 slalom 和 Summer 1。
* 版本固定 0.6.3(Worker 补丁依赖压缩后的代码布局,锚点变了会直接报错)。扩展只匹配 0.6.3 页面。
* 扩展下:面板上的自动驾驶按 1 倍实时;求解时页面会明显变卡;扩展不改动游戏的任何网络请求(成绩上传由你自行决定)。

## 目录

```
scripts/
  solve.mjs                CLI:规划 + 打磨 + Verify 校验,输出回放串 / JSON
  bench.mjs                批量基准:多赛道 / 多种子依次跑 solve.mjs,汇总成表
  diag_fail.mjs            重放 *.failed.json,打印轨迹表和停滞点附近的赛道零件
  render_html.mjs          把结果渲染成单文件 HTML 报告
  play_replay.mjs          在真实游戏页面(有窗口)里按 1 倍速放一份结果
  build_extension.mjs      把页面内自动驾驶拼成 extension/autopilot.js
  test_extension.mjs       用本机 Chrome 端到端测试页面内求解 + 自动驾驶
  verify_result.mjs        用游戏自带 Verify 独立复核一份结果 JSON
  make_slalom.mjs          生成蛇形测试赛道(S 弯部件 41/42 + 直路)
  build_mini_track.mjs     阶段 0 用的直线赛道
  lib/eval_patch.js        批量评估 / 快照提交 的 Worker 补丁(内存中)
  lib/solver.mjs           CEM 规划 + 窗口打磨
  lib/progress.mjs         中线折线与进度投影
  lib/pt_harness.mjs       Playwright 启动器(虚拟时钟 Worker、只放行游戏静态资源主机)
  lib/page_shim.js         页面侧垫片(Worker 旁路、Worker 池、批量评估)
  lib/worker_shim.js       Worker 侧虚拟时钟 + 赛道/部件目录读取
  lib/pt_codec.mjs         状态缓冲区 / 回放串编解码
  lib/pt_driver.mjs, pt_runner.mjs, fixtures.mjs   阶段 0 的帧精确注入与对比
  t1_speed / t1b_* / t2_state / t3_determinism / t3b_respawn / t4_injection / run_all   阶段 0 实验
  data/                    我们自己生成的测试赛道导出串
extension/                 Chrome 扩展(manifest / 页面内核心 src/core.js / 构建产物 autopilot.js)
test/                      unit / engine / solver / extension_build 测试
logs/                      阶段 0 的原始日志
report/                    阶段 0 报告 + 内部机制附录
out/                       求解结果(回放串 / JSON / HTML)
```

## 合规说明

* 本目录**不包含任何游戏文件**。Worker 脚本在运行时由 `curl` 从官网拉到内存,前置/补丁后经 Playwright 路由交给浏览器,不写盘。
* 逆向仅限个人学习研究,不要重新分发游戏文件。
