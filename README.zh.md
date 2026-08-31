# dsh-design-review

> **设计方案与教训（lesson learnt）的外部交叉评审机制。** 任意会话写入设计文档 → 自动提审外部运维 agent（Hermes，type=design）；`lesson_review_submit` 提审事故教训（type=lesson）——approved 的防复发措施自动追加到 `OPS-GUARDRAILS.md`。

## 为什么需要它

设计决策与运维教训不应只活在单个对话里。本插件把交叉评审**机制化**：任意会话写出的设计文档自动提交给 Hermes 评审；事故教训按"可防复发"标准评审——approved 的措施永久追加进守则文件，杜绝同类设计再犯。

与 [dsh-reset-handoff](https://github.com/nicecx/dsh-reset-handoff)（重置→外部执行器）、[dsh-auto-approver](https://github.com/nicecx/dsh-auto-approver)（审批→外部裁决）配套：三者共用同一套 review-handoff 协议。

## 工作原理

```
任意会话写入设计文档（*.design.md / DESIGN.md / PROPOSAL.md / 关键词命中）
   → dsh-design-review（tools/execute 拦截，自身写入豁免）
   → 写 review-handoff request.json（type=design，单槽安全）
   → Hermes cron 审核（读文档/核对文件/跑测试）
   → 结论注入发起会话 + 文档头标记

lesson_review_submit(事故, 根因, 教训, ...)
   → 提审 type=lesson
   → Hermes 审核可防复发性 + 同类风险排查 + 守则冲突检测
   → approved → 措施追加到 ~/.dsh/OPS-GUARDRAILS.md（append-only、带日期、git 可回滚）
```

## 安装

```sh
dsh plugin --profile <profile> add github:nicecx/dsh-design-review
```

## 配置

```yaml
- id: dsh-design-review
  name: 'dsh-design-review'
  config:
    mode: 'advisory'        # advisory | mandatory | off（默认 advisory）
    patterns:               # 设计文档路径规则（收窄默认）
      - '**/*.design.md'
      - 'DESIGN.md'
      - 'PROPOSAL.md'
    keywords:               # .md 首 40 行内容启发
      - 设计方案
      - 技术方案
      - 架构设计
      - 'Design Proposal'
    queueMode: 'skip'       # skip（安全，默认）| queue（显式排队）
    gitGate: false          # mandatory 加强：评审通过前禁止 git 提交（默认关）
```

| mode | 行为 |
| --- | --- |
| `advisory` | 自动提审 + 通知会话；不阻塞。**默认。** |
| `mandatory` | 自动提审 + 硬提示「评审 pending，暂缓实施」；可选 `gitGate`。 |
| `off` | 惰性。 |

## 工具

| 工具 | 用途 |
| --- | --- |
| `design_review_submit(title, docPath, changeFiles?, tests?)` | 提审 type=design（写设计文档时也会自动触发） |
| `lesson_review_submit(title, incident, rootCause, lesson, impact?, reproducible?)` | 提审 type=lesson；approved 措施追加 OPS-GUARDRAILS.md |
| `review_status()` | 最近请求/结论/队列长度 |

## 安全设计

- **自身写入豁免**：插件自己的文档头标记不会再次触发拦截（无死循环）。
- **单槽防护**：绝不覆盖 pending 的 request.json；`queueMode=skip`（默认）或显式 `queue` + 排空循环。
- **watchdog 接入**：结果轮询登记 `dsh-task-watchdog`（非裸 setTimeout）。
- **守则追加**：append-only、带日期/事故引用/来源；与既有守则冲突检测；文件 git 跟踪可回滚。
- **fail-closed**：30 分钟无结论 → 标 `failed-review`（绝不静默视为通过）。

## License

MIT
