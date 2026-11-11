# PolyTrack AI — 离线搜索(TAS 式)原型

在 PolyTrack 0.6.3 自带的**确定性物理**上做离线搜索:用批量并行评估 + WASM 状态快照,找出更快的整圈按键序列,
输出游戏自己的回放格式,并用游戏自带的 `Verify` 校验。

* 阶段 0(可行性验证)结论与实测证据:`report/phase0.md`(内部机制附录:`report/phase0_internals.md`)
* 原型(搜索器 + CLI + HTML 报告 + 测试):本文件

> **规则提醒**:这是个人学习/研究用的本地离线工具。它不会向游戏服务器上传任何东西(harness 拒绝所有游戏静态资源之外的请求)。
> TAS/机器人成绩能否提交到官方排行榜取决于社区与开发者的规则,**我没有查证到官方明文规定**(speedrun.com 对我的网络 403)。
> 提交之前请先去官方 Discord / itch.io 论坛确认,不要擅自提交。

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
`--commit 6`(每轮提交几个动作),`--seconds N` 或 `--polish-iters N`(打磨预算;后者可复现),`--seed`,`--resume 旧.json`(跳过规划只打磨),`--trace`,`--official`(用游戏默认赛道,即 Summer 1),`--potential polyline|field`,`--half-width / --off-penalty`(离路面惩罚)。规划阶段若 4000 帧内进度增长不足 4 m 会快速失败并写出 `.failed.json` 现场。

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

* 进度势能有两种:`--potential polyline`(默认,假设单主路的 BFS 中线,自制赛道用)和 `--potential field`(按检查点分段的 Dijkstra 距离场,支持多层 / 跳跃 / 检查点折返,官方赛道用:`--official`)。官方 Summer 1 的势能已经能建出来,但**搜索在检查点 2 之前停滞,没有完成一圈**(详见 `report/phase0.md` 6.4)。
* 搜索质量没有和"真实最优"对比过。当前最好结果(`out/slalom_v3.*`,1.1 km 蛇形赛道 16.835 s,Verify 通过)里**仍有一次撞击**(≈13 s 处速度从 ≈340 骤降到 ≈170 km/h),按键时间线抖动也很多(见 HTML 报告)。我试过加"速度骤降"惩罚(`--crash`,默认关)和拉长远端时域,都没有改善(分别 17.161 s、20.534 s),详见 `report/phase0.md` 6.2。基线(一直按 W)在这条赛道上不能冲线。
* 动作集只有 W / W+左 / W+右 / 刹车;没用 R(检查点重生)。重生在阶段 0 的压力测试里行为一致,但搜索器没利用它。
* 速度:单次整圈评估 ≈ 50~120 ms(单 Worker,约 15 万帧/秒);4 核上规划 1.1 km 赛道约 2~3 分钟。
* 只在本机离线运行,版本固定 0.6.3(Worker 补丁依赖压缩后的代码布局,锚点变了会直接报错)。

## 目录

```
scripts/
  solve.mjs                CLI:规划 + 打磨 + Verify 校验,输出回放串 / JSON
  render_html.mjs          把结果渲染成单文件 HTML 报告
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
test/                      unit / engine / solver 测试
logs/                      阶段 0 的原始日志
report/                    阶段 0 报告 + 内部机制附录
out/                       求解结果(回放串 / JSON / HTML)
```

## 合规说明

* 本目录**不包含任何游戏文件**。Worker 脚本在运行时由 `curl` 从官网拉到内存,前置/补丁后经 Playwright 路由交给浏览器,不写盘。
* 逆向仅限个人学习研究,不要重新分发游戏文件。
