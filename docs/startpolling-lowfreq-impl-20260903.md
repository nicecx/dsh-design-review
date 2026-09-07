# startPolling 超时转低频轮询实施（018 lesson 措施② + 030 修复 v2）

- requestId: 待提审分配（实施复核）
- 类型: design
- 关联: 018 approved（措施② DSH 侧）；030 changes-requested（阻断 bug 修复——本版 v2）

## 复用评估

- 本地 CAPABILITY-INDEX：design-review 自身 startPolling（30min 硬超时——本次改其超时分支）；018 措施①（守护方 result-history.jsonl 归档——本变更读该归档做兜底补投）；无其他插件具结论补投能力
- 外部收录（awesome）：无对应
- GitHub 借鉴：无直接同型（轮询放弃策略 + 归档兜底为 DSH 治理特有）

## 背景与问题

008/012 实证：startPolling 30min 硬超时后停止轮询——迟到结论永不投递。018 措施①（守护方归档）已落地；措施②（DSH 侧不放弃）v1 实现有阻断 bug（030）：`poll.lowFreq` 未初始化 → undefined < 12 恒 false → 30min 后直接误投终态、低频段与归档补投死代码。

## 方案（v2，030 修复）

**决策抽纯函数** `nextPollStep({ elapsedMin, lowFreq, hasHistory })`（core.js）四走向：
fast（<30min → 30s）/ lowfreq（≥30 且 <12 次 → 5min）/ deliver-history（归档命中 → 补投）/ exhausted（≥12 次 → 终态）

startPolling 超时分支（src/index.js，commit `6a74a21` + `0a44df3`）：
1. 30min 内：30s 快轮询（原逻辑）
2. 超 30min：`lowFreq` **闭包变量初始化 0**（030 阻断 bug 修复）——转 5min 低频（最多 12 次 ≈1h）
3. 低频段每轮查 result-history.jsonl（018 措施①归档）——本 requestId 结论被覆盖 → 补投（deliver-from-history 审计）；**deliver 失败不 return 转低频自然重试**（030 建议③）
4. 低频耗尽 → audit `poll-exhausted`（030 建议④）+ 投递「结论未到达已停止」指引归档

约束（018 实施要点确认）：不改计时起点（ETA 语义）；只改投递行为；DSH 不自实施红线不变。

## 接口与兼容性

- core.js 新导出 nextPollStep（纯函数）；index.js 只读 result-history.jsonl（守护方写入）
- 新增审计 action：deliver-from-history / poll-exhausted
- 向后兼容：旧行为（30min 停止）替换为有界低频等待——更优无破坏

## 安全

- 只读 result-history.jsonl（review-handoff 内）；投递内容 = 守护方审核产物
- 低频轮询有界（12 次上限）——无无限轮询

## 测试方案

- **45/45 全绿**（41 既有 + 4 新用例：四走向直测 + undefined lowFreq 回归——030 阻断 bug 回归防线；`node test/index.test.js`）
- 部署后实证：排队超 30min 的提审结论到达时收到投递（或归档补投）

## 变更文件

- `~/Documents/Workspace/dsh-design-review/src/core.js`（nextPollStep 纯函数）
- `~/Documents/Workspace/dsh-design-review/src/index.js`（超时分支重构 + lowFreq 闭包初始化）
- `~/Documents/Workspace/dsh-design-review/test/index.test.js`（+4 用例）

## 风险与回滚

- 风险：低频轮询挂起（有界 12 次自然终止——内存态重启即失，018 确认可接受）；归档逐行扫描（文件 ≤ 数十行量级）
- 回滚：revert 0a44df3 / 6a74a21（恢复 30min 停止行为）

## 追加：fresh-path deliver 重试 + lesson 副作用门控（20260907-001 / 031 非阻塞落地）

**背景**：031 审核观察——fresh-path（30min 内结论正常到达）deliver 失败后直接 return 无重试。

**变更（commit bf6772f + 后续）**：
1. deliver 失败 → 30s 重试（`freshRetries ≤ 5`，最长 150s 有界）；5 次放弃 → 投递查档指引（result.json + result-history.jsonl）
2. **lesson 副作用整体门控**（`lessonSideEffectsDone` 布尔）——守则/playbook/ISSUES/传播投递每 startPolling 生命周期只执行一次——重试轮只重投结论、不重跑副作用（001 修复：原幂等只覆盖守则 includes 一处，playbook/ISSUES/传播在重试轮会重复执行）
3. 守则追加幂等（existing.includes(entry) → guardrail-duplicate-skip）

**幂等边界**：deliver 本身可重试（幂等——收方可能收到重复消息但无副作用）；守则/playbook/ISSUES/传播 = 一次性副作用（门控）。

**测试**：45/45 全绿（重试分支在闭包——下版抽纯函数补测同 nextPollStep 模式）。
