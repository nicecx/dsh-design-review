# 审核通道完成时间预测与卡死判别机制（ETA 双用途）

- requestId: 待提审分配（设计先行、未实施——changeFiles/tests 置空声明）
- 类型: design
- 触发: 2026-09-03 用户要求——"要有能力识别是真卡了还是审核未完成；建立完成时间预测机制，预测时间既用于守护方自己管理，也用于我远程观察"
- 教训背景: 035（lesson）审核 agent 实际活跃工作 16min+（长审核）被 age>15min 固定阈值误判卡死；同时 027-034（skill 无 monitor 归属）与 031 老 bug（失败无重唤醒）是真卡死——**固定 age 阈值无法区分两者**

## 复用评估

- 本地 CAPABILITY-INDEX：review-handoff 协议（request.json 单槽）、031 lesson（卡死检测 check_stuck_review——缺陷：固定 15min 阈值 + 检测器挂消费端 cron 内与被测同体）、025 队列 ETA（入队"第 N 位预计等待 ~Xmin"——排队段预测已有雏形）、task-queue consumer（消费端）、design-review startPolling（30min fail-closed 超时——固定阈值同缺陷）
- 外部收录（awesome）：无对应条目
- GitHub 借鉴：CI 超时预测/Elasticsearch 任务 ETA 类机制思路（历史分位数预测 + 持续校准）

## 问题定义

1. **判别缺陷**：现判定卡死 = pending age > 15min（031 固定阈值）——无法区分：①真卡死（无 agent/agent 失败不重试/skill 无归属）②审核未完成（agent 活跃工作中，035 实证可超 15min）
2. **无预测**：无完成时间预测——守护方无法管理（何时该介入），DSH 侧无法远程观察（何时该担心）——用户只能自己问

## 方案：完成时间预测（ETA）+ 双判据卡死判别

### 1. ETA 预测模型（入槽时计算，写入共享位置）

**预测公式**：`etaAt = 入槽时刻 + P90(同型历史审核时长)`——按 (type, 审核模型) 分桶取历史 P90（保守上界，避免频繁误报）。

- type 分桶: design / lesson / skill / arbitration
- 模型分桶: deepseek-v4-pro（code review job）/ kimi-k3（arbitration job）
- 历史数据源: review-handoff 的 request.json（入槽 ts）→ result.json（完成 ts）时间线——**每次审核 result 落盘即回写一个时长样本**（持续校准，样本滚动窗口 ≤30 条/桶）

**写入位置**: request.json 增 `etaAt` 字段（入槽时由**守护方消费端** task_queue_consumer.py 写入——它知道 type+模型+入槽时刻）——**双方共享同一字段**：
- 守护方管理：check_stuck_review 用 etaAt 判据
- DSH 远程观察：schedule-72 监管轮询读 request.json.etaAt

**冷启动基线**（无历史时保守值，随 result 校准）：
| type | 模型 | 初始 P90（min） |
|---|---|---|
| design | deepseek-v4-pro | 30 |
| lesson | deepseek-v4-pro | 20 |
| skill | deepseek-v4-pro | 15 |
| arbitration | kimi-k3 | 45（kimi 90s 超时重试历史，含容错） |

### 2. 卡死判别语义（双判据，共享 etaAt）

```
now < etaAt            → 审核未完成（正常等待，静默）
etaAt ≤ now < etaAt+B  → 观察窗（守护方查 agent 活性：cron agent 运行中 = 未完成继续等；
                         无 agent = 异常，介入排查）
now ≥ etaAt+B          → 真卡死（守护方介入：查 agent 失败/唤醒链/归属）
```

- B（缓冲）= max(10min, etaAt 的 20%)——覆盖模型抖动
- **agent 活性是辅助判据**（守护方 cron 侧可见）：agent 活跃时即使超 etaAt+B 也先查 agent 状态（035 教训：活跃 16min 长审）

### 3. 守护方侧变更（消费端 + 卡死检测）

- `task_queue_consumer.py`：写 request.json 时计算并写 `etaAt`（读 ~/.dsh/review-handoff/eta-stats.json 分位数；无样本用基线）
- `eta-stats.json`：`{ "<type>__<model>": { "samples": [<分钟>...], "p90": N } }`——消费端或守护方在 result 落盘时追加样本 + 重算分位数（滚动 ≤30）
- `check_stuck_review`（031 改进）：age 判据 → `now > etaAt + B` 才输出卡死签名（消除长审核误报）；输出加 etaAt/实际 age 上下文
- **检测器与消费端解耦**（031 架构缺陷修复）：卡死检测移出消费端 tick 循环或独立 job——消费端停摆（07:40-07:46 实证 tick 缺口）不再导致无人检测

### 4. DSH 侧远程观察（schedule-72 监管升级）

- 每 15min 读 request.json：无 etaAt（旧格式）→ 用基线兜底
- `now < etaAt` → 静默（一句话状态即可）
- `now ≥ etaAt + B` → **上报守护方**（按 2026-09-03 用户裁定：卡死处理走守护方，DSH 不自修）
- result 落盘 → 转达相关会话（现有行为）
- 上报消息含上下文：requestId/type/etaAt/实际 age/agent 活性未知（DSH 侧不可见 agent——守护方查）

### 5. 与现有机制关系

- 不取代 031 卡死检测——031 升级判据（etaAt+B）并解耦检测器
- 不取代 025 队列 ETA（排队段）——本机制覆盖**审核执行段**（入槽→结论），两段衔接：总 ETA = 排队 ETA + 审核 ETA
- design-review startPolling 30min 固定超时 → 同判据升级（读 etaAt）——提审方通知也准（可选二期）

## 接口与兼容性

- request.json 增 `etaAt`（ISO 时间）——**向后兼容**：旧 request.json 无该字段，读者（DSH schedule-72 / 守护方 check_stuck_review）用基线兜底，不破坏现有协议（协议版本仍 v1）
- eta-stats.json 新路径 `~/.dsh/review-handoff/eta-stats.json`——与 request/result/state.json 并列，无协议冲突
- 消费端写 etaAt 为增量逻辑：pick 任务写 request.json 时多算一个字段，不改变写入时序与单槽语义
- DSH 侧无新工具/新插件——schedule-72（会话内监管轮询）读取逻辑升级，不改接口

## 安全

- 无新权限（读写均落在既有 review-handoff 目录权限模型内）
- etaAt 为预测值非承诺：不构成审核 SLA，仅判别辅助（防误报/防漏报）；误判边界由 B 缓冲 + agent 活性辅助吸收
- 样本数据只含 (type, model, 分钟时长)——无请求内容/会话信息，无隐私面
- 卡死处理权仍归守护方（2026-09-03 用户裁定）：DSH 侧只观察与上报，不自修、不绕过门控（审批代理 09-03 裁定：禁止伪造 hash/ts 类操纵监控机制）

## 测试方案（实施后）

- T1：etaAt 写入——消费端 pick 任务写 request.json 含 etaAt（基线值）
- T2：result 落盘 → eta-stats 样本追加 + P90 重算（滚动窗口截断）
- T3：判别语义——now<etaAt 静默 / 观察窗 / 超 etaAt+B 卡死签名（mock 时钟）
- T4：长审核不误报——agent 活跃（mock）时超 etaAt 不告警（035 回归）
- T5：消费端停摆解耦——消费端 tick 停止时独立检测器仍输出卡死（031 修复回归）

## 变更文件（计划，未实施）

- `~/.hermes/scripts/task_queue_consumer.py`（etaAt 写入 + eta-stats 维护 + check_stuck_review 判据升级 + 检测解耦）
- `~/.dsh/review-handoff/eta-stats.json`（新，分位数统计）
- 本设计文档（入 ~/.dsh/review-handoff/docs/）

## 风险与回滚

- 风险：P90 偏小 → 频繁误报（B 缓冲 + agent 活性辅助吸收）；样本污染（卡死样本计入分布——剔除：仅 result 正常落盘计样本，卡死/超时不计）
- 回滚：消费端不加 etaAt（读不到则 DSH 侧基线兜底）；eta-stats.json 删除即回冷启动
