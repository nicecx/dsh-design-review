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
