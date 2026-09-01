/**
 * dsh-design-review 核心逻辑（纯函数，无副作用，便于单测）。
 *
 * 覆盖 005 审核批准的机制：
 *  - 设计文档识别（patterns 收窄 + 关键词启发）
 *  - 单槽并发防护（pending 检查 + queueMode=skip|queue）
 *  - 守则 append-only 追加（带日期/引用/来源）
 *  - 自身写入豁免标记
 */

import path from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

/** 默认识别 patterns（收窄版，005 审核意见 6）。 */
export function defaultPatterns() {
  return [
    '**/*.design.md',
    'DESIGN.md',
    'PROPOSAL.md',
  ]
}

/** 默认关键词启发（.md 首 40 行）。 */
export function defaultKeywords() {
  return ['设计方案', '技术方案', '架构设计', 'Design Proposal', '设计文档']
}

/** 插件自身写入豁免标记（响应 004 意见 1：防死循环）。 */
export const OWN_WRITE_MARKER = 'x-dsh-design-review-own'

/** 默认配置。 */
export function defaultConfig() {
  return {
    mode: 'advisory',        // advisory | mandatory | off
    patterns: defaultPatterns(),
    keywords: defaultKeywords(),
    queueMode: 'skip',       // skip（默认，安全）| queue（显式排队）
    gitGate: false,          // mandatory 加强：评审通过前禁止 git 提交（默认关）
    reviewDir: undefined,    // 默认 ~/.dsh/review-handoff/
    guardrailsPath: undefined, // 默认 ~/.dsh/OPS-GUARDRAILS.md
    logPath: undefined,      // 默认 ~/.dsh/design-review.log
  }
}

/** 校验配置。 */
export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config 必须是对象' }
  if (cfg.mode !== undefined && !['advisory', 'mandatory', 'off'].includes(cfg.mode)) {
    return { ok: false, error: `mode 应为 advisory/mandatory/off` }
  }
  if (cfg.queueMode !== undefined && !['skip', 'queue'].includes(cfg.queueMode)) {
    return { ok: false, error: `queueMode 应为 skip/queue` }
  }
  for (const key of ['patterns', 'keywords']) {
    if (cfg[key] !== undefined && !Array.isArray(cfg[key])) {
      return { ok: false, error: `${key} 应为数组` }
    }
  }
  return { ok: true }
}

/** glob 简配：把 glob（如 *.design.md、DESIGN.md、双星号/星号形式）转成正则。
 * 支持双星号加斜杠前缀为可选段：既匹配完整路径，也匹配纯文件名/相对路径。 */
function globToRegex(glob) {
  let g = String(glob).replace(/\\/g, '/')
  if (g.startsWith('**/')) g = g.slice(3)
  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE__/g, '.*')
  return new RegExp(`^(?:.*/)?${escaped}$`)
}

/**
 * 判定一个文件是否为"设计文档"。
 * @param {string} filePath 绝对路径
 * @param {string} [firstLines] 文件前 40 行文本（关键词启发）
 * @param {object} cfg 配置（含 patterns/keywords）
 * @returns {boolean}
 */
export function isDesignDoc(filePath, firstLines, cfg = defaultConfig()) {
  const base = path.basename(filePath)
  const rel = filePath.replace(/\\/g, '/')
  // 1. patterns 精确匹配
  for (const p of (cfg.patterns || [])) {
    const re = globToRegex(p)
    if (re.test(rel) || re.test(base)) return true
  }
  // 2. 关键词启发（.md 首 40 行）
  if (base.endsWith('.md') && firstLines) {
    const head = String(firstLines).slice(0, 4000)
    for (const kw of (cfg.keywords || [])) {
      if (head.includes(kw)) return true
    }
  }
  return false
}

/**
 * skill 文件识别（20260901-019 approved，方案 A v4）：
 * - 规则 A：文件名恰为 SKILL.md（任意深度）
 * - 规则 B：路径含 /skills/（带分隔符，防 myskills/ 误匹配）且文件名以 .skill.md 结尾
 */
export function isSkillDoc(filePath) {
  const base = path.basename(filePath).toLowerCase()
  if (base === 'skill.md') return true
  return /[\/\\]skills[\/\\]/.test(filePath) && base.endsWith('.skill.md')
}

/**
 * 统一入队关卡（20260901-019 approved）：
 * - design：复用评估 + 设计模板（双检查）
 * - skill：仅复用评估（SKILL.md 内嵌「## 复用评估」节；跳过 7 章模板）
 * - lesson：豁免（独立文档结构）
 * 返回 { ok, reason, references }（复用 checkReuseSection/checkTemplateSections，不新增函数）
 */
export function gateByType(type, content) {
  if (type === 'skill') return checkReuseSection(content)
  if (type === 'design') {
    const r = checkReuseSection(content)
    if (!r.ok) return r
    const t = checkTemplateSections(content)
    if (!t.ok) return { ok: false, reason: `设计模板缺章 ${t.missing.join('、')}（见 ~/.dsh/DESIGN-TEMPLATE.md 必填 7 章）`, references: r.references }
    return r
  }
  return { ok: true, reason: 'lesson 豁免', references: { index: [], awesome: [], github: [] } }
}

/** 检查 review-handoff 目录当前是否有 pending 请求（单槽）。 */
export function hasPendingRequest(req) {
  return Boolean(req && req.status === 'pending')
}

/** 是否已有对应 result（requestId 匹配）。 */
export function hasResultFor(res, requestId) {
  return Boolean(res && res.requestId === requestId)
}

/**
 * 复用评估关卡（20260901-003 approved）：设计文档必须含「复用评估」节且
 * 命中至少一个引用源，或含「无复用/全新功能」逃逸声明。
 *
 * 返回 { ok, reason, references: { index, awesome, github } }：
 * - 判定（固化）：节存在 且（命中任一源 或 逃逸声明）= ok；节缺失/空节 = not ok
 * - 大小写不敏感：整段节内容统一 lowercase 后匹配（capability-index / awesome / github.com）
 * - 引用分类：CAPABILITY-INDEX → index；awesome → awesome；github.com → github（存命中行，截断 80）
 * - 逃逸：含「无复用」或「全新功能」声明 → ok（references 可空，audit 记 reuse-escape 供复核）
 */
export function checkReuseSection(content) {
  const text = String(content || '')
  const lower = text.toLowerCase()
  const sectionMatch = lower.match(/##\s*reuse evaluation[\s\S]*?(?=##\s|$)/i) || lower.match(/##\s*复用评估[\s\S]*?(?=##\s|$)/)
  const references = { index: [], awesome: [], github: [] }
  if (!sectionMatch) {
    return { ok: false, reason: '缺少「## 复用评估」节（开发前复用检索规范）', references }
  }
  const section = sectionMatch[0]
  const lines = section.split('\n')
  for (const line of lines) {
    const l = line.toLowerCase()
    if (l.includes('capability-index')) references.index.push(line.trim().slice(0, 80))
    if (l.includes('awesome')) references.awesome.push(line.trim().slice(0, 80))
    if (l.includes('github.com')) references.github.push(line.trim().slice(0, 80))
  }
  const hit = references.index.length + references.awesome.length + references.github.length > 0
  const escape = /无复用|全新功能/.test(section)
  if (hit || escape) {
    return {
      ok: true,
      reason: escape && !hit ? '逃逸声明（无复用/全新功能）' : `命中 ${references.index.length + references.awesome.length + references.github.length} 条引用`,
      references,
    }
  }
  return { ok: false, reason: '「复用评估」节为空：须含 CAPABILITY-INDEX / awesome / GitHub 引用，或声明「无复用」（全新功能）', references }
}

/**
 * 设计模板校验（20260901-006 approved）：DESIGN-TEMPLATE 必填章节齐全性检查。
 *
 * 必填章节（lowercase 匹配标题）：复用评估 / 方案 / 接口与兼容性 / 安全 / 测试方案 / 变更文件 / 风险与回滚
 * 返回 { ok, missing: [] }；额外校验（非阻塞字段）：变更文件节内引用的路径存在性（existsSync 由调用方注入）
 */
export function checkTemplateSections(content) {
  const text = String(content || '').toLowerCase()
  const required = [
    ['复用评估', /##\s*(复用评估|reuse evaluation)/],
    ['方案', /##\s*方案/],
    ['接口与兼容性', /##\s*接口[与和]兼容性/],
    ['安全', /##\s*安全/],
    ['测试方案', /##\s*测试方案|##\s*测试/],
    ['变更文件', /##\s*变更文件/],
    ['风险与回滚', /##\s*风险与回滚|##\s*风险/],
  ]
  const missing = required.filter(([, re]) => !re.test(text)).map(([name]) => name)
  return { ok: missing.length === 0, missing }
}

/**
 * 缺陷模式全机扫描（20260901-006 approved，lesson 跨 agent 传播 P1）。
 *
 * 限定根目录扫描（避免系统库海量候选），排除 node_modules/.git/备份/二进制；
 * 返回候选清单 [{ file, line, context }]（供发起 agent 复核，不入队）。
 * 注意：本函数只产出候选——修复任务必须经复核后由 agent 显式提审（tier=review 互审）。
 */
export function scanDefectPattern(pattern, roots, exclude = /(node_modules|\.git\/|\.bak|__pycache__|\.pyc|\.png|\.jpg|\.zip|review-handoff[\/\\]docs)/i) {
  const pat = String(pattern || '').trim().toLowerCase()
  if (!pat) return []
  const hits = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = path.join(dir, name)
      if (exclude.test(p)) continue
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p, depth + 1); continue }
      if (!/\.(js|mjs|cjs|ts|py|sh|yml|yaml|json|md)$/i.test(name)) continue
      let lines
      try { lines = String(readFileSync(p, 'utf8')).split('\n') } catch { continue }
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(pat)) {
          hits.push({ file: p, line: i + 1, context: lines[i].trim().slice(0, 120) })
        }
      }
    }
  }
  for (const root of roots || []) walk(root, 0)
  return hits
}

/** 构造 review-handoff 请求（type=design|lesson）。 */
export function buildRequest(opts) {
  const now = opts.requestedAt instanceof Date ? opts.requestedAt : new Date(opts.requestedAt || Date.now())
  return {
    protocol: 'review-handoff/v1',
    requestId: opts.requestId,
    ts: now.toISOString(),
    title: opts.title,
    type: opts.type || 'design',
    docPath: opts.docPath,
    changeFiles: opts.changeFiles || [],
    tests: opts.tests || '',
    urgency: opts.urgency || 'normal',
    status: 'pending',
    sessionId: opts.sessionId || '',
    // 20260901-003 approved：结构化复用检索结果（Hermes 可核对与文档一致性）
    reuseCheck: opts.reuseCheck || { index: [], awesome: [], github: [] },
  }
}

/** 构造守则追加条目（append-only，带日期/引用/来源）。 */
export function buildGuardrailEntry({ measure, incidentRef, source, date }) {
  const d = (date || new Date()).toISOString().slice(0, 10)
  return [
    '',
    `### 追加条目（${d} · 来源 ${source || 'dsh-design-review'} · 事故引用 ${incidentRef || '-'}）`,
    `- ${measure}`,
  ].join('\n')
}

/** 追加前冲突检测：新条目不得与既有守则矛盾（关键词共现启发，返回需人工确认项）。 */
export function checkGuardrailConflict(existing, entry) {
  const conflicts = []
  const measureLine = entry.split('\n').find((l) => l.startsWith('- '))
  if (!measureLine) return conflicts
  const text = measureLine.slice(2)
  // 若新条目是否定式（禁止/严禁/不得），且既有守则含"允许"+相同主题词 → 可疑矛盾
  const negated = text.includes('禁止') || text.includes('严禁') || text.includes('不得')
  if (!negated) return conflicts
  // 提取主题词：去掉否定词与虚词后的连续片段
  const topic = text
    .replace(/禁止|严禁|不得|绝不|直接|在|跑|执行|使用|进行/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  if (topic.length === 0) return conflicts
  for (const line of existing.split('\n')) {
    if (!line.includes('允许')) continue
    const hit = topic.filter((w) => line.includes(w))
    if (hit.length >= 1) {
      conflicts.push(`既有「${line.trim()}」与新条目「${text}」可能矛盾（共现: ${hit.join('/')}），需人工确认`)
    }
  }
  return conflicts
}

/** 审计行。 */
export function auditLine(entry) {
  return JSON.stringify(entry)
}
