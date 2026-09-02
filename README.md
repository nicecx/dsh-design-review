# dsh-design-review

> **Mandatory cross-review of design documents and lessons-learned with an external ops agent (e.g. Hermes).** Any session that writes a design document automatically files a review-handoff request (type=design); `lesson_review_submit` files type=lesson reviews whose approved measures are appended to `OPS-GUARDRAILS.md`.

## Why

Design decisions and operational lessons should not live and die inside a single conversation. This plugin makes cross-review **mechanized**: a design document written in *any* DSH session is automatically submitted to the external ops agent (Hermes) for review; an incident's lesson is reviewed for *preventability* — and approved preventive measures are permanently appended to the guardrails file so the same class of mistake is not repeated.

It pairs with [dsh-reset-handoff](https://github.com/nicecx/dsh-reset-handoff) and [dsh-auto-approver](https://github.com/nicecx/dsh-auto-approver): reset → external executor, approval → external verdict, design/lesson → external cross-review. All three speak the same review-handoff protocol.

## How it works

```
any session writes a design doc (*.design.md / DESIGN.md / PROPOSAL.md / keyword match)
   → dsh-design-review (tools/execute intercept, own-write exempt)
   → files review-handoff request.json (type=design, single-slot safe)
   → Hermes cron reviews (reads doc, checks files, runs tests)
   → verdict injected back into the originating session + doc header marker

lesson_review_submit(incident, rootCause, lesson, ...)
   → files type=lesson request
   → Hermes reviews preventability + same-class risk + guardrail conflict
   → approved → measure appended to ~/.dsh/OPS-GUARDRAILS.md (append-only, dated, git-revertible)
```

## Install

```sh
dsh plugin --profile <profile> add github:nicecx/dsh-design-review
```

## Configuration

```yaml
- id: dsh-design-review
  name: 'dsh-design-review'
  config:
    mode: 'advisory'        # advisory | mandatory | off (default advisory)
    patterns:               # design-doc path patterns (narrow default)
      - '**/*.design.md'
      - 'DESIGN.md'
      - 'PROPOSAL.md'
    keywords:               # content heuristic for .md first 40 lines
      - 设计方案
      - 技术方案
      - 架构设计
      - 'Design Proposal'
    queueMode: 'skip'       # skip (safe, default) | queue (explicit pending queue)
    gitGate: false          # mandatory extra: block git commit until approved (default off)
```

| mode | behavior |
| --- | --- |
| `advisory` | auto-submit + notify the session; non-blocking. **Default.** |
| `mandatory` | auto-submit + hard notice "review pending, hold implementation"; optional `gitGate`. |
| `off` | inert. |

## Tools

| Tool | Purpose |
| --- | --- |
| `design_review_submit(title, docPath, changeFiles?, tests?)` | File a type=design review (auto-detection also fires on design-doc writes). |
| `lesson_review_submit(title, incident, rootCause, lesson, impact?, reproducible?)` | File a type=lesson review; approved measures append to `OPS-GUARDRAILS.md`. |
| `review_status()` | Latest request, verdict, queue length. |

## Safety design

- **Own-write exemption**: the plugin's own doc-header markers never re-trigger interception (no infinite loop).
- **Single-slot protection**: never overwrites a pending `request.json`; `queueMode=skip` (default) or explicit `queue` with a drain loop.
- **watchdog integration**: the result poll is registered with `dsh-task-watchdog` (not a bare setTimeout).
- **Guardrail append**: append-only, dated, with incident ref + source; conflict detection against existing rules; file is git-tracked for rollback.
- **fail-closed**: 30 min without a verdict → marked `failed-review` (never silently treated as approved).

## License

MIT

## 联动（20260902-003 approved，独立部署·协议联动）

与 dsh-task-queue（队列中枢）联动：设计文档/lesson auto-submit 入队 review tier → 消费端出队 → 单槽检查写 request.json → Hermes 审核 → 结论按 sessionId 路由回发起会话；approved 守则追加 OPS-GUARDRAILS + 缺陷模式传播扫描。详见协作契约「二·五 架构总览」。
