import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultConfig, validateConfig, isDesignDoc, hasPendingRequest, hasResultFor,
  buildRequest, buildGuardrailEntry, checkGuardrailConflict, OWN_WRITE_MARKER,
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
