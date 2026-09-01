import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultConfig, validateConfig, isDesignDoc, hasPendingRequest, hasResultFor,
  buildRequest, buildGuardrailEntry, checkGuardrailConflict, checkReuseSection, OWN_WRITE_MARKER,
} from '../src/core.js'

test('T1: 写入 *.design.md → 识别为设计文档', () => {
  assert.equal(isDesignDoc('/a/b/foo.design.md', '', defaultConfig()), true)
  assert.equal(isDesignDoc('/a/b/DESIGN.md', '', defaultConfig()), true)
  assert.equal(isDesignDoc('/a/b/PROPOSAL.md', '', defaultConfig()), true)
})

test('T2: 普通文件不识别', () => {
  assert.equal(isDesignDoc('/a/b/src/index.js', '', defaultConfig()), false)
  assert.equal(isDesignDoc('/a/b/README.md', '普通说明', defaultConfig()), false)
})

test('T3: 关键词启发（.md 首 40 行含设计方案）', () => {
  assert.equal(isDesignDoc('/a/b/anything.md', '这是一个设计方案文档\n详细内容...', defaultConfig()), true)
  assert.equal(isDesignDoc('/a/b/note.md', 'Design Proposal: new feature', defaultConfig()), true)
})

test('T4: 单槽 pending 检查', () => {
  const pending = { status: 'pending', requestId: 'x' }
  const done = { status: 'pending', requestId: 'x' }
  assert.equal(hasPendingRequest(pending), true)
  assert.equal(hasPendingRequest(null), false)
  assert.equal(hasResultFor({ requestId: 'x', verdict: 'approved' }, 'x'), true)
  assert.equal(hasResultFor({ requestId: 'y', verdict: 'approved' }, 'x'), false)
})

test('T5: buildRequest type=design/lesson', () => {
  const d = buildRequest({ requestId: 'R1', title: 't', type: 'lesson', docPath: '/d.md', sessionId: 's' })
  assert.equal(d.protocol, 'review-handoff/v1')
  assert.equal(d.type, 'lesson')
  assert.equal(d.status, 'pending')
  assert.equal(d.sessionId, 's')
  const d2 = buildRequest({ requestId: 'R2', title: 't' })
  assert.equal(d2.type, 'design')
})

test('L1/L2: 守则条目 append-only 含日期/引用/来源', () => {
  const entry = buildGuardrailEntry({ measure: '禁止在 profile 跑 pnpm install', incidentRef: '20260831-001', source: 'dsh-design-review', date: new Date('2026-08-31') })
  assert.ok(entry.includes('2026-08-31'))
  assert.ok(entry.includes('20260831-001'))
  assert.ok(entry.includes('dsh-design-review'))
  assert.ok(entry.includes('禁止在 profile 跑 pnpm install'))
})

test('L3: 守则冲突检测', () => {
  const existing = '允许在 profile 目录直接运行 pnpm install'
  const entry = buildGuardrailEntry({ measure: '禁止在 profile 跑 pnpm install', incidentRef: 'r', source: 's' })
  const conflicts = checkGuardrailConflict(existing, entry)
  assert.ok(conflicts.length > 0, '应检测到矛盾')
  // 无冲突场景
  const existing2 = '每 30 分钟巡检一次'
  const entry2 = buildGuardrailEntry({ measure: '禁止在 profile 跑 pnpm install', incidentRef: 'r', source: 's' })
  assert.equal(checkGuardrailConflict(existing2, entry2).length, 0)
})

test('OWN_WRITE_MARKER 存在', () => {
  assert.equal(OWN_WRITE_MARKER, 'x-dsh-design-review-own')
})

test('validateConfig', () => {
  assert.equal(validateConfig({ mode: 'bogus' }).ok, false)
  assert.equal(validateConfig({ queueMode: 'bogus' }).ok, false)
  assert.equal(validateConfig({ patterns: 'not-array' }).ok, false)
  assert.equal(validateConfig({ mode: 'advisory', queueMode: 'skip' }).ok, true)
})

test('write 工具参数 file_path 形式可提取（回归：部署 bug）', () => {
  // 模拟 tools/execute 拦截里从 exec.arguments 提取路径的逻辑
  const args = { file_path: '/x/y/proposal.design.md', content: '...' }
  const fp = args.file_path || args.file || args.filePath || args.path || ''
  assert.equal(fp, '/x/y/proposal.design.md')
  assert.equal(isDesignDoc(fp, '', defaultConfig()), true)
})

// ── 20260901-003 approved：复用评估关卡 checkReuseSection ──
test('R1: 复用评估节 + CAPABILITY-INDEX 引用 → ok 且 references.index 命中', () => {
  const doc = '# 方案\n\n## 复用评估\n- 本地已有能力（CAPABILITY-INDEX）：dsh-task-queue → 复用\n'
  const r = checkReuseSection(doc)
  assert.equal(r.ok, true)
  assert.ok(r.references.index.length >= 1)
})

test('R2: github.com 链接 → ok 且 references.github 命中', () => {
  const doc = '## 复用评估\n- GitHub 借鉴：https://github.com/foo/bar\n'
  const r = checkReuseSection(doc)
  assert.equal(r.ok, true)
  assert.ok(r.references.github.length >= 1)
})

test('R3: 缺复用评估节 → not ok（含提示）', () => {
  const doc = '# 方案\n\n## 背景\n无复用评估节\n'
  const r = checkReuseSection(doc)
  assert.equal(r.ok, false)
  assert.match(r.reason, /复用评估/)
})

test('R4: 大小写不敏感（英文节名 + 引用大小写变体）→ ok', () => {
  const doc = '# x\n\n## Reuse Evaluation\n- Capability-Index 条目：y\n- awesome 插件：z\n'
  const r = checkReuseSection(doc)
  assert.equal(r.ok, true)
  assert.ok(r.references.index.length >= 1)
  assert.ok(r.references.awesome.length >= 1)
})

test('R5: 逃逸口「无复用」声明 → ok（全新功能）', () => {
  const doc = '## 复用评估\n- 无复用：全新功能，无既有资产可复用（理由充分）\n'
  const r = checkReuseSection(doc)
  assert.equal(r.ok, true)
  assert.match(r.reason, /逃逸|无复用/)
})

test('R6: 空节（无引用无逃逸）→ not ok', () => {
  const doc = '## 复用评估\n- 随便写点东西\n'
  const r = checkReuseSection(doc)
  assert.equal(r.ok, false)
})

test('R7: buildRequest 携带 reuseCheck 字段', () => {
  const req = buildRequest({ requestId: 'r1', title: 't', reuseCheck: { index: ['x'], awesome: [], github: [] } })
  assert.deepEqual(req.reuseCheck, { index: ['x'], awesome: [], github: [] })
})
