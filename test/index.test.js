import { test } from 'node:test'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import {
  defaultConfig, validateConfig, isDesignDoc, hasPendingRequest, hasResultFor,
  buildRequest, buildGuardrailEntry, checkGuardrailConflict, checkReuseSection, checkTemplateSections, scanDefectPattern, isSkillDoc, gateByType, OWN_WRITE_MARKER,
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

// ── 20260901-006 approved：设计模板校验 checkTemplateSections ──
test('T1: 模板章节齐全 → ok', () => {
  const doc = [
    '## 复用评估\n- CAPABILITY-INDEX 条目\n',
    '## 方案\nx\n',
    '## 接口与兼容性\nx\n',
    '## 安全\nx\n',
    '## 测试方案\nx\n',
    '## 变更文件\nx\n',
    '## 风险与回滚\nx\n',
  ].join('')
  const r = checkTemplateSections(doc)
  assert.equal(r.ok, true)
  assert.deepEqual(r.missing, [])
})

test('T2: 缺「安全」与「变更文件」章 → missing 列出', () => {
  const doc = '## 复用评估\nx\n## 方案\nx\n## 接口与兼容性\nx\n## 测试方案\nx\n## 风险与回滚\nx\n'
  const r = checkTemplateSections(doc)
  assert.equal(r.ok, false)
  assert.ok(r.missing.includes('安全'))
  assert.ok(r.missing.includes('变更文件'))
})

test('T3: 章节大小写不敏感', () => {
  const doc = '## REUSE EVALUATION\nx\n## 方案\nx\n## 接口与兼容性\nx\n## 安全\nx\n## 测试\nx\n## 变更文件\nx\n## 风险\nx\n'
  const r = checkTemplateSections(doc)
  assert.equal(r.ok, true)
})

// ── 20260901-006 approved：缺陷模式扫描 scanDefectPattern ──
test('P1: 扫描命中含模式的行（排除 node_modules）', () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-'))
  fs.mkdirSync(path.join(td, 'src'), { recursive: true })
  fs.mkdirSync(path.join(td, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(td, 'src', 'a.js'), 'const x = launchctl kickstart -k\n')
  fs.writeFileSync(path.join(td, 'src', 'b.py'), 'normal line\n')
  fs.writeFileSync(path.join(td, 'node_modules', 'bad.js'), 'launchctl kickstart -k\n')
  const hits = scanDefectPattern('kickstart -k', [td])
  assert.ok(hits.some((h) => h.file.includes('a.js')), '应命中 a.js')
  assert.ok(!hits.some((h) => h.file.includes('node_modules')), '应排除 node_modules')
  fs.rmSync(td, { recursive: true, force: true })
})

test('P2: 空模式 → 空候选', () => {
  assert.deepEqual(scanDefectPattern('', ['/tmp']), [])
})

// ── 20260901-019 approved：skill 识别 S1-S4 + 统一关卡 I1-I4 ──
test('S1: SKILL.md 文件名（任意深度）→ skill 文档', () => {
  assert.equal(isSkillDoc('/a/b/SKILL.md'), true)
  assert.equal(isSkillDoc('a/SKILL.md'), true)
})

test('S2: skills/ 下 .skill.md → skill 文档', () => {
  assert.equal(isSkillDoc('a/skills/x/y.skill.md'), true)
  assert.equal(isSkillDoc('/Users/x/Documents/Workspace/skills/vehicle-maintenance/SKILL.md'), true)
})

test('S3: 普通 .md → 非 skill', () => {
  assert.equal(isSkillDoc('README.md'), false)
  assert.equal(isSkillDoc('/a/b/note.md'), false)
})

test('S4: skills/ 下 soft-skills.md → 非 skill（后缀严格，防宽松回归）', () => {
  assert.equal(isSkillDoc('a/skills/soft-skills.md'), false)
  assert.equal(isSkillDoc('a/myskills/foo.skill.md'), false)  // 防 myskills/ 误匹配
})

test('I1: skill 含复用评估节 + 引用 → 通过', () => {
  const r = gateByType('skill', '## 复用评估\n- CAPABILITY-INDEX 条目 x\n- github.com/foo\n')
  assert.equal(r.ok, true)
})

test('I2: skill 无复用评估节 → 拒绝', () => {
  const r = gateByType('skill', '# 技能说明\n直接写内容\n')
  assert.equal(r.ok, false)
  assert.match(r.reason, /复用评估/)
})

test('I3: skill 含「无复用」逃逸 → 通过', () => {
  const r = gateByType('skill', '## 复用评估\n- 无复用：全新功能\n')
  assert.equal(r.ok, true)
})

test('I4: design 缺模板章 → 拒绝（双关卡回归）', () => {
  const r = gateByType('design', '## 复用评估\n- CAPABILITY-INDEX x\n## 方案\nx\n')
  assert.equal(r.ok, false)
  assert.match(r.reason, /模板缺章/)
})
