# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-08-31

### Added
- Design-doc auto-detection (`tools/execute` intercept of write/edit): `*.design.md` / `DESIGN.md` / `PROPOSAL.md` + content-keyword heuristic, narrow defaults per review 20260831-005.
- review-handoff filing (type=design) with single-slot protection: never overwrites a pending request; `queueMode=skip` (default) or explicit `queue` with a drain loop.
- Own-write exemption marker (`x-dsh-design-review-own`) preventing infinite interception loops (review 004 point 1).
- `lesson_review_submit`: files type=lesson reviews; on approval the preventive measure is appended to `OPS-GUARDRAILS.md` (append-only, dated, incident ref + source, conflict detection, git-revertible).
- Result polling with watchdog integration (`ctx.watchdog.register`, 30s interval, 30 min fail-closed).
- Modes: `advisory` (default, non-blocking) / `mandatory` (hard notice + optional `gitGate`) / `off`.
- Tools: `design_review_submit`, `lesson_review_submit`, `review_status`.
- Pure core layer (`src/core.js`) with 9 unit tests (detection, single-slot, request build, guardrail append, conflict detection).

### Notes
- Designed through the DSH↔Hermes cross-review process (reviews 20260831-004 changes-requested → 20260831-005 approved; all 9 points + 4 non-blocking items addressed).
