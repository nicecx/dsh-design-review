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

/** glob 简配：把 glob（如 *.design.md、DESIGN.md）转成正则。 */
function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE__/g, '.*')
  return new RegExp(`^${escaped}$`)
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
