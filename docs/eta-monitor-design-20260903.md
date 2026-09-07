# 审核通道完成时间预测与卡死判别机制（ETA 双用途）v5

- requestId: 20260902-037 → 008 → 012（changes-requested；012 详情因 result 覆盖丢失——018 已修）→ v4 修订重报（设计先行、未实施）
- 类型: design
- 触发: 2026-09-03 用户要求——"识别真卡死 vs 审核未完成 + 完成时间预测（守护方管理 + DSH 远程观察双用途）"
- v2 修订: 落实 037 评审 4 项（检测器分层枚举 / 活性信号新增 / etaAt hash 陷阱 / 签名分桶稳定）
- v3 修订: 落实 037 完整 details 另 4 项（⑤样本回写者=写 result 的 agent 幂等 ⑥P90 小样本 N<10 用基线 ⑦上报受众=用户+通道 ⑧T4 断言对准介入层）+ 强化唤醒≠介入语义
- **v4 修订（2026-09-03）**：标注 018/030 已实施对设计的覆盖——①018 措施①（result-history.jsonl 归档）与措施②（startPolling 30min 后转 5min 低频轮询 + 归档兜底补投，031 approved）**已落地**：设计第 6 节 startPolling 升级部分（超时后不放弃）已完成，无需再实施；②本设计剩余核心（**未实施**）= etaAt 预测（消费端入槽写入 + eta-stats 校准）、L2 卡死判别升级（check_stuck_review 固定 15min → etaAt+B）、runs 活性标记、检测器解耦——均在守护方侧；③DSH 侧监管（schedule 读 etaAt）为会话规则（随守护方 etaAt 落地启用）。
- **v5（2026-09-03 033 approved）**：落实 032 四项 + 033 实施提示（lease 量纲公式修正/urgent sanityCap 分档/L2' 措辞统一）；评审 037→008→012→032→033 闭环。实施=守护方侧（task_queue_consumer.py/check_stuck_review/monitor 脚本/agent job prompt）——①runs 活性改 **lease 模型**（60s 心跳与 cron 短命 agent 矛盾：单 turn 1-5min 无法维持 60s 心跳 → 长审必被误判陈旧接管 → 035 并发双跑重现；leaseUntil = max(etaAt+B, startedAt+sanityCapMin)（量纲修正），仅 lease 过期可接管，心跳仅僵尸诊断）+ 补 T8（30min 长审跨 stuck 不被接管）②模型映射显式（type→审核模型映射表防分桶错配）③runs 删除时序（先 result+state 后删 runs）④样本回写并发加固（check-then-write + O_EXCL）。

## 复用评估

- 本地 CAPABILITY-INDEX：review-handoff 协议、031 lesson（卡死检测）、025 队列 ETA、task_queue_consumer.py、dsh_review_code_monitor.py / dsh_review_arbitration_monitor.py（stuck1/stuck2 重唤醒——021 自愈链路）、design-review startPolling（30min 固定超时误报实证：037 排队 28min+审核 2min 即触发）
- 外部收录（awesome）：无对应条目
- GitHub 借鉴：任务 ETA 历史分位数预测 + 持续校准思路

## 问题定义

1. **判别缺陷**：固定 age 阈值无法区分真卡死 vs 审核未完成（035 长审 30min 被 15min 阈值误判；037 排队时间计入 startPolling 30min 误报）
2. **检测器分散**：3 个年龄检测器并存——(a) 消费端 check_stuck_review（STUCK_MIN=15min 硬编码真卡死介入）(b) code monitor stuck1/stuck2（10min 无 result 重唤醒——首跑失败自愈）(c) arbitration monitor 同款——设计必须分层而非整体替换
3. **无预测**：无完成时间预测 → 守护方无法管理、DSH 无法远程观察

## 方案：ETA 预测 + 分层卡死判别 + 活性信号

### 1. ETA 预测（入槽时写入，永不重写）

`etaAt = 入槽时刻 + P90(同型历史审核时长)`——(type, 审核模型) 分桶。

- **写入方与 hash 陷阱（037-3）**：etaAt 由**消费端**在 pick 任务写 request.json 的**同一 write_json 调用内**写入（037 实证：消费端路径可行）——**必须在 monitor 首次观察前落盘且此后永不重写**（monitor 输出 hash = sha256(整个 req JSON sort_keys)——任何后补写改变 hash → 误唤醒）。DSH 侧**不存在**直写 request.json 路径（单槽统一由消费端写）——若有遗留直写代码一律走队列。
- **冷启动基线**：design/pro 30min、lesson/pro 20min、skill/pro 15min、arbitration/kimi 45min
- **模型映射显式化（032 建议①）**：request.json 无 model 字段——消费端写 etaAt 与 agent 回写样本时分桶统一用 **type → 审核模型映射表**：design/lesson/skill → deepseek-v4-pro（code review job）、arbitration → kimi-k3（arbitration job）——与冷启动基线一致；分桶键 = `"<type>__<映射模型>"`——防消费端预测桶与回写样本桶错配（映射表写入消费端脚本注释与 PROTOCOL，若审核通道再分流须同步更新映射）

### 2. 检测器分层（037-1：3 检测器枚举，不整体替换）

| 层 | 检测器 | 阈值 | 作用 |
|---|---|---|---|
| L1 自愈 | code/arbitration monitor stuck1/stuck2 | 10min 无 result | 首跑失败/未写 result → 重唤醒（021 自愈链路）——**保留不动** |
| L2 真卡死 | 消费端 check_stuck_review（升级） | `now > etaAt + B`（B = max(10min, etaAt×20%)） | 真卡死 → 卡死签名 → **唤醒**守护方 agent（037-1：唤醒≠介入） |
| L2' 活性辅助 | 守护方介入前查 runs 标记 | — | lease 未过期 → 不接管（035 教训） |

- **唤醒≠介入（037-1）**：monitor 只负责唤醒（含 L1 短周期重唤醒——10min 即唤醒是设计行为）；守护 agent 被唤醒后按 `etaAt+B + runs 活性证据` **自行决定介入 or 继续等**——介入判据的消费方是 agent，不是 monitor
- check_stuck_review 升级：固定 15min → etaAt+B；无 etaAt（旧格式）→ 基线兜底
- **签名分桶稳定（037-4）**：卡死签名中 age 字段一律分桶（age//10min 档，沿用 031 age//STUCK_BUCKET 模式）——禁止裸实际 age（每分钟变 → 唤醒风暴）
- 031 架构修复保留：卡死检测与消费端 tick 解耦（独立检测器/独立 job——消费端停摆不导致无人检测）

### 3. 活性信号 runs 标记（037-2：新增；032 修正 = lease 模型）

`~/.dsh/review-handoff/runs/<requestId>.json`：
```json
{"startedAt": "...", "pid": 123, "heartbeat": "...", "leaseUntil": "...", "sanityCapMin": 120}
```
- 守护方审核 agent **第 1 步**写（含 heartbeat 初值 + leaseUntil），结束时删除
- **lease 模型（032 必改：60s 心跳与 cron 短命 agent 矛盾——单 turn 常 1-5min 无法维持 60s 心跳，长审必被误判陈旧接管 → 035 并发双跑系统性重现）**：
  - `leaseUntil = max(etaAt + B, startedAt + sanityCapMin)  // 量纲修正（033 提示①）：etaAt+B 为绝对时间戳、sanityCapMin 为分钟——分别加 startedAt 后取 max；B 的 20% 基数 = 预期审核时长（etaAt − 入槽时刻）`——**仅 lease 过期才允许接管**（删旧写新）
  - heartbeat 仅作僵尸诊断（心跳停滞 + lease 过期 = 僵尸确认），不作接管判据
- **删除时序（032 建议②）**：先写 result.json + state.json（结论落盘），**再删 runs 标记**——防止"结论已出但标记尚在"窗口期的无谓接管
- **sanityCap 分档（033 提示②）**：P90 基线 30-45min 下 lease 恒被 sanityCapMin=120 主导——守护 agent 中途死亡（09-02 provider RuntimeError 实证）时接管延迟最长 ~2h；**urgent 审核单独分档（sanityCapMin=20min）**。heartbeat 字段对短命 cron agent 无法中途刷新——标为可选（僵尸判定实际退化为 lease 过期）
- 用途：L2' 活性辅助判据 + 防并发双跑（035 教训：长审 ≠ 卡死）

### 4. 样本回写与校准（037-5/6：回写者与规则补齐）

- **回写者 = 写 result.json 的审核 agent**（037-5）：在翻转 state.lastProcessedId 时**幂等追加**样本（`sample = result.ts - request.ts` 分钟）——每 requestId 只计一次（记录 `lastSampledRequestId`，防 stuck 重唤醒重复采样）；`eta-stats.json` 原子写（tmp+rename），与消费端读并发安全
- **并发加固（032 建议③）**：lease 接管场景仍可能双 agent 先后写 result——样本追加前**重读 state.json 校验 lastProcessedId 未变**（check-then-write）；仍竞态则样本追加走 O_EXCL 锁（.sample.lock）——确保 lastSampledRequestId 幂等不被竞态击穿
- **异常样本剔除**：`sample > 4h` 或 result 缺失 → 不计（卡死/人工介入产物不入分布）
- **小样本规则（037-6）**：桶内 **N < 10 用基线**；N ≥ 10 用 P90（滚动窗口 ≤30）

### 5. DSH 远程观察（schedule-72 升级）

- 每 15min 读 request.json：无 etaAt → 基线兜底
- `now < etaAt` → 静默；`etaAt ≤ now < etaAt+B` → 观察（查守护方是否已唤醒处理——查消费端/独立检测器输出）；`≥ etaAt+B` → **上报守护方**（不自修）
- **上报受众与通道（037-7）**：守护方自己本有检测（L1/L2 唤醒链）——**DSH schedule-72 的真实价值是向用户远程观察上报**：受众 = 用户（含守护方状态提示）。通道 = ①会话内通知（本会话 schedule-72 prompt 汇报——用户在时直接可见）②iMessage relay（用户不在场时经 dsh-relay 通道推送——复用既有通道配置）；守护方侧检测状态（是否已唤醒/处理中）一并汇报，由用户决定是否升级给守护方
- result 落盘 → 转达相关会话（现有行为）

### 6. 与现有机制关系

- L1（monitor stuck 重唤醒）保留——L2 升级判据——两层互补（自愈先行、介入兜底）
- 总 ETA = 025 排队 ETA + 本机制审核 ETA（执行段）
- design-review startPolling 30min 固定超时：**计时应从入槽时刻起算**（037 实证：排队时间计入导致误报）——读 request.json 的 ts（入槽）而非提审时刻；判据同 etaAt+B（二期统一，一期先修计时起点）

## 接口与兼容性

- request.json 增 `etaAt`（ISO）——向后兼容（无字段读方基线兜底；协议 v1 不变）
- 新路径：`eta-stats.json`（分位数）/ `runs/<requestId>.json`（活性）/ `alerts/`（DSH 上报）——均落 review-handoff 目录权限模型
- etaAt 永不重写（hash 稳定约束）；runs/alerts 文件生命周期明确（删/归档）

## 安全

- 无新权限（review-handoff 目录内）；etaAt 为预测辅助非 SLA 承诺
- 样本仅 (type, model, 分钟)——无内容/会话隐私
- 卡死处理权归守护方（2026-09-03 用户裁定）：DSH 只观察上报，不自修、不伪造 hash/ts（审批代理 09-03 裁定）
- runs 标记由守护方 agent 维护——防误删/防伪冒（agent 写入前校验 requestId 匹配当前 pending）

## 测试方案（实施后）

- T1：消费端写 request.json 含 etaAt（同一次 write，hash 稳定——写后连续 2 tick monitor 无唤醒）
- T2：result 变化 → 消费端回写样本 + P90 重算（滚动截断、超时样本剔除）
- T3：L2 判别——now<etaAt 静默 / 观察窗 / ≥etaAt+B 卡死签名（mock 时钟；签名 age 分桶稳定——连续 tick hash 不变）
- T4（037-8）：**长审核不误报断言对准介入层**——monitor 短周期唤醒（16min 长审仍产生 stuck1 唤醒）是设计行为非误报；断言 = 守护 agent 被唤醒后查 runs 活性证据 → **不介入、不告警用户**（035 回归）
- T5：runs 标记——agent 写/删；stuck 唤醒读 lease：lease 未过期 → 不重复处理（035 回归）；lease 过期 → 接管（删旧写新）
- **T8（032 必改）**：单 turn >60s、总时长 30min 的长审在 stuck1/stuck2 重唤醒时**不被接管**（leaseUntil = max(etaAt+B, startedAt+sanityCapMin) 未过——035 回归强化）
- T6：消费端停摆解耦——消费端停时独立检测器仍出卡死签名（031 回归）
- T7：DSH alerts 上报——写 alerts 文件 → 守护方唤醒处理 → 归档

## 变更文件（计划，未实施）

- `~/.hermes/scripts/task_queue_consumer.py`（etaAt 写入、样本回写、check_stuck_review 升级 etaAt+B、alerts 扫描、检测解耦）
- `~/.hermes/scripts/dsh_review_code_monitor.py` / `dsh_review_arbitration_monitor.py`（runs 标记读写——agent 侧行为在 job prompt 或 agent 脚本）
- 守护方审核 agent 行为（写/心跳/删 runs 标记）——job prompt 更新
- `~/.dsh/review-handoff/eta-stats.json` / `runs/` / `alerts/`（新）
- DSH 侧 schedule-72 监管逻辑升级（无代码——会话内规则）

## 风险与回滚

- 风险：P90 偏小 → L2 误报（B 缓冲 + L2' 活性吸收）；etaAt 后补写 → hash 误唤醒（约束：写入后永不重写 + 测试 T1 验证）；runs 标记僵尸（sanity cap 兜底）
- 回滚：消费端不写 etaAt（读方基线兜底）；删除 eta-stats/runs/alerts 即回冷启动

---

## 实施记录（守护方侧，2026-09-07 22:2x 完成——用户转达守护方实施报告）

**验收状态：5 项全落地 + T1-T8 测试全过（真实数据目录未触碰）**

| # | 实施项 | 落点 |
|---|---|---|
| ① | etaAt 写入 | task_queue_consumer.py pick 任务：etaAt 随同一 write_json 落盘（无二次写，hash 稳定）；分桶 `<type>__<映射模型>`（design/lesson/skill→pro、arbitration→kimi）；冷启动 30/20/15/45min；N≥10 P90（滚动≤30，nearest-rank） |
| ② | check_stuck_review 升级 | 15min → now > etaAt+B（B=max(10min, 预期×20%)）；签名 age//15 分桶；无 etaAt 旧格式基线兜底；monitor 只唤醒不介入 |
| ③ | runs lease 活性 | 新共享库 dsh_review_eta.py：acquire 写 `{startedAt, pid, leaseUntil, sanityCapMin}`；leaseUntil = max(etaAt+B, startedAt+sanityCapMin)（033 量纲修正）；sanityCap 120/urgent 20；仅 lease 过期接管；删除时序先 result+state 后 release |
| ④ | 检测与消费端解耦 | 新独立检测器 dsh_review_stuck_detector.py + cron job 54a9f4e6cc0a（*/2，monitor 门控，健康静默） |
| ⑤ | 样本回写 | 写 result agent：幂等（lastSampledRequestId）+ check-then-write + O_EXCL .sample.lock；>4h 剔除；eta-stats.json 原子写 |

**行为载体**：两审核 job prompt 更新（inbox 步骤 1.5 acquire + 5.5 sample+release；arbitration 同款+条件式 sample）；PROTOCOL v1.5（模型映射表）；dsh-ops-guardian 技能加 ETA 运维章节。

**防误写**：stale requestId acquire 拒绝（exit 3）。

**DSH 侧零代码改动**——监管（schedule）读 etaAt 即启用；T1 实证 = 下个任务入槽含 etaAt。
