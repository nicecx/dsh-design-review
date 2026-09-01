/**
 * dsh-design-review — 设计方案强制交叉评审插件（宿主级，跨会话共享）。
 *
 * 双功能（005 审核 approved；阶段 3 = 026 approved 入队改造）：
 *  1. 设计评审：任意会话写入设计文档（patterns/keywords 识别）→ 自动入队
 *     task-queue（tier=review，消费端出队写 review-handoff）→ 结论注入发起会话。
 *  2. lesson 评审：lesson_review_submit → 入队（type=lesson）→ approved 措施
 *     append-only 追加到 OPS-GUARDRAILS.md（带日期/事故引用/来源，git 可回滚）。
 *
 * 安全设计（004 审核 9 条 + 005 非阻塞 + 026 阶段 3 全部落实）：
 *  - 自身写入豁免（OWN_WRITE_MARKER，防死循环）
 *  - 单槽并发防护（队列已有 queued/processing review → skip，queueMode=skip 默认）
 *  - 取号扫 docs/（007 lesson 单一编号源，不再读 request.json——入队模式滞后）
 *  - watchdog 接入（inject:['watchdog'] 登记轮询任务，非裸 setTimeout）
 *  - 守则追加冲突检测 + append-only
 */

import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  defaultConfig, validateConfig, isDesignDoc, hasPendingRequest, hasResultFor,
  buildRequest, buildGuardrailEntry, checkGuardrailConflict, OWN_WRITE_MARKER,
} from './core.js'

export const name = 'dsh-design-review'
const PREFIX = '[系统·设计评审]'

export function apply(ctx, rawConfig = {}) {
  const config = { ...defaultConfig(), ...(rawConfig || {}) }
  const v = validateConfig(config)
  if (!v.ok) {
    ctx.logger?.warn?.(`[dsh-design-review] 配置非法，按 off 处理: ${v.error}`)
    config.mode = 'off'
  }
  const reviewDir = config.reviewDir || path.join(os.homedir(), '.dsh', 'review-handoff')
  const guardrailsPath = config.guardrailsPath || path.join(os.homedir(), '.dsh', 'OPS-GUARDRAILS.md')
  const logPath = config.logPath || path.join(os.homedir(), '.dsh', 'design-review.log')
  const queueFile = path.join(reviewDir, 'pending-queue.json')
  // 阶段 3（026）：入队 task-queue（唯一真相源），不再直接写 request.json
  const taskQueuePath = config.taskQueuePath || path.join(os.homedir(), '.dsh', 'task-queue', 'queue.json')
  const docsDir = path.join(reviewDir, 'docs')

  const ensureDir = () => mkdirSync(reviewDir, { recursive: true })
  const audit = (entry) => {
    try {
      mkdirSync(path.dirname(logPath), { recursive: true })
      appendFileSync(logPath, JSON.stringify(entry) + '\n')
    } catch { /* 审计失败不阻断 */ }
  }
  const readJson = (p) => {
    try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null } catch { return null }
  }
  const readQueue = () => {
    const q = readJson(taskQueuePath)
    return Array.isArray(q) ? q : []
  }
  const writeQueue = (q) => {
    mkdirSync(path.dirname(taskQueuePath), { recursive: true })
    const tmp = taskQueuePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(q, null, 2))
    renameSync(tmp, taskQueuePath) // 原子替换（与消费端同语义）
  }
  const queueHasPendingReview = () =>
    readQueue().some((t) => t.tier === 'review' && (t.status === 'queued' || t.status === 'processing'))
  const nextRequestId = () => {
    // 007 lesson 单一编号源：扫 docs/ 当天最大号 +1（不再读 request.json——入队模式滞后）
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    let maxN = 0
    try {
      for (const fn of readdirSync(docsDir)) {
        const m = fn.match(new RegExp(`^${today}-(\\d+)\\.md$`))
        if (m) maxN = Math.max(maxN, Number(m[1]))
      }
    } catch { /* docs 不存在 */ }
    return `${today}-${String(maxN + 1).padStart(3, '0')}`
  }

  /**
   * 提审（阶段 3 入队版）：文档快照 docs/<rid>.md（幂等，src!=dst 才复制）→
   * 入队 task-queue tier=review（单槽：队列已有 queued/processing review → skip）。
   */
  const submit = (opts) => {
    ensureDir()
    const requestId = opts.requestId || nextRequestId()
    if (queueHasPendingReview()) {
      audit({ ts: new Date().toISOString(), action: 'skipped', title: opts.title })
      return { ok: false, queued: false, note: '队列已有 pending review 任务（单槽），跳过' }
    }
    // 文档快照（013 建议 + 026：幂等双保险；消费端出队时也会落盘）
    try {
      if (opts.docPath) {
        mkdirSync(docsDir, { recursive: true })
        const dst = path.join(docsDir, `${requestId}.md`)
        if (path.resolve(opts.docPath) !== path.resolve(dst) && existsSync(opts.docPath)) {
          copyFileSync(opts.docPath, dst)
        }
      }
    } catch (e) {
      audit({ ts: new Date().toISOString(), action: 'snapshot-failed', requestId, error: String(e) })
    }
    const now = new Date().toISOString()
    const task = {
      id: `tq-${requestId}`,
      tier: 'review',
      payload: {
        requestId,
        title: opts.title,
        docPath: path.join(docsDir, `${requestId}.md`),
        changeFiles: opts.changeFiles || [],
        tests: opts.tests || '',
        type: opts.type || 'design',
        urgency: opts.urgency || 'normal',
        sessionId: opts.sessionId || '',  // 035 approved：发起会话 id（Hermes 按此路由结论）
      },
      priority: opts.urgency === 'urgent' ? 0 : 1,
      status: 'queued',
      attempts: 0,
      claimedBy: null,
      leaseExpiry: null,
      createdAt: now,
      updatedAt: null,
    }
    const q = readQueue()
    q.push(task)
    writeQueue(q)
    audit({ ts: now, action: 'enqueue', requestId, type: task.payload.type, title: opts.title })
    return { ok: true, requestId, queued: false }
  }

  /**
   * 过渡兼容（026 阶段 3）：旧 pending-queue.json（queueMode=queue 时代）遗留任务
   * 转投 task-queue（新唯一真相源）；正常路径此文件应为空。
   */
  const drainQueue = () => {
    const q = readJson(queueFile) || []
    if (q.length === 0) return
    writeFileSync(queueFile, JSON.stringify([], null, 2))
    for (const item of q) {
      const r = submit({ ...item, requestId: undefined })
      audit({ ts: new Date().toISOString(), action: 'migrate-legacy', requestId: r.requestId || '-', title: item.title, ok: r.ok })
    }
  }

  /** 投递结论回发起会话。 */
  const deliver = (sessionId, text) => {
    try {
      const id = String(sessionId || '')
      if (!id) return false
      const agent = ctx.agents.get(id)
      if (!agent) return false
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `${PREFIX}\n${text}` }],
        source: { kind: 'plugin', plugin: name, form: 'design-review' },
      })
      return true
    } catch { return false }
  }

  /** 轮询 result.json（每 30s，最长 30min），出结论后注入发起会话 + 守则追加。 */
  const startPolling = (requestId, sessionId, title, type) => {
    const start = Date.now()
    const resPath = path.join(reviewDir, 'result.json')
    const poll = () => {
      try {
        const res = readJson(resPath)
        if (res && res.requestId === requestId && res.verdict) {
          const verdict = res.verdict
          // 035 approved：投递审计（可核验发起会话是否收到结论）
          const delivered = deliver(sessionId, `「${title}」评审结论: ${verdict}\n${res.summary || ''}${res.details?.length ? '\n' + res.details.join('\n') : ''}`)
          audit({ ts: new Date().toISOString(), action: delivered ? 'deliver-ok' : 'deliver-fail', sessionId, requestId })
          if (type === 'lesson' && verdict === 'approved') {
            // 守则追加（append-only + 冲突检测）
            const existing = existsSync(guardrailsPath) ? readFileSync(guardrailsPath, 'utf8') : ''
            const entry = buildGuardrailEntry({ measure: res.summary || title, incidentRef: requestId, source: name })
            const conflicts = checkGuardrailConflict(existing, entry)
            if (conflicts.length === 0) {
              mkdirSync(path.dirname(guardrailsPath), { recursive: true })
              appendFileSync(guardrailsPath, entry + '\n')
              audit({ ts: new Date().toISOString(), action: 'guardrail-appended', requestId })
            } else {
              audit({ ts: new Date().toISOString(), action: 'guardrail-conflict', requestId, conflicts })
            }
          }
          return
        }
        if (Date.now() - start < 30 * 60 * 1000) {
          setTimeout(poll, 30000)
        } else {
          deliver(sessionId, `「${title}」评审超时（30min 无结论，fail-closed）`)
        }
      } catch { setTimeout(poll, 30000) }
    }
    poll()
  }

  const toolDefs = [
    {
      name: 'design_review_submit',
      description: 'Submit a design document for mandatory cross-review by an external ops agent (Hermes). Files a review-handoff request (type=design); the verdict is injected back into this session when ready. Use this after writing any design proposal (the plugin also auto-detects design doc writes). Args: title (required), docPath (absolute path to the design document, required), changeFiles (optional list of changed files), tests (optional test command).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Design title' },
          docPath: { type: 'string', description: 'Absolute path to the design document' },
          changeFiles: { type: 'array', items: { type: 'string' }, description: 'Changed files (optional)' },
          tests: { type: 'string', description: 'Test command (optional)' },
        },
        required: ['title', 'docPath'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args, exec) {
        if (config.mode === 'off') return '插件已关闭（mode=off）'
        const sessionId = String(exec?.agent?.id || args._sessionId || '')
        const r = submit({ title: args.title, docPath: args.docPath, changeFiles: args.changeFiles || [], tests: args.tests, type: 'design', sessionId })
        if (!r.ok) return `⚠️ ${r.note}`
        startPolling(r.requestId, sessionId, args.title, 'design')
        return `✅ 已入队 ${r.requestId}（tier=review，消费端出队后写 review-handoff）\n文档: ${args.docPath}\n结论将注入本会话。`
      },
    },
    {
      name: 'lesson_review_submit',
      description: 'Submit an incident/lesson-learned for cross-review by Hermes (type=lesson). Approved measures are appended to OPS-GUARDRAILS.md (append-only, with date/incident-ref/source). Args: title (required), incident (what happened), rootCause (why), lesson (proposed preventive measure), impact (optional), reproducible (optional).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Incident title' },
          incident: { type: 'string', description: 'What happened' },
          rootCause: { type: 'string', description: 'Root cause' },
          lesson: { type: 'string', description: 'Proposed preventive measure' },
          impact: { type: 'string', description: 'Impact (optional)' },
          reproducible: { type: 'string', description: 'Is it reproducible (optional)' },
        },
        required: ['title', 'incident', 'rootCause', 'lesson'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args, exec) {
        if (config.mode === 'off') return '插件已关闭（mode=off）'
        const sessionId = String(exec?.agent?.id || args._sessionId || '')
        // lesson 复盘写入 review-handoff/docs（供 Hermes 读）
        const docDir = path.join(reviewDir, 'docs')
        mkdirSync(docDir, { recursive: true })
        const rid = nextRequestId()
        const docPath = path.join(docDir, `${rid}.md`)
        const content = [
          `# Lesson: ${args.title}`,
          `> 提交: ${new Date().toISOString()}`,
          '',
          `## 事故\n${args.incident}`,
          `## 根因\n${args.rootCause}`,
          `## 教训（拟防复发措施）\n${args.lesson}`,
          args.impact ? `## 影响面\n${args.impact}` : '',
          args.reproducible ? `## 可复现性\n${args.reproducible}` : '',
        ].filter(Boolean).join('\n')
        writeFileSync(docPath, content)
        const r = submit({ title: `[lesson] ${args.title}`, docPath, changeFiles: [docPath], tests: '', type: 'lesson', sessionId })
        if (!r.ok) return `⚠️ ${r.note}`
        startPolling(r.requestId, sessionId, args.title, 'lesson')
        return `✅ 已入队 ${r.requestId}（type=lesson）\napproved 后将防复发措施追加到 OPS-GUARDRAILS.md。`
      },
    },
    {
      name: 'review_status',
      description: 'Query the current review-handoff state: latest request, its verdict (if any), and pending queue length. Read-only.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        const req = readJson(path.join(reviewDir, 'request.json'))
        const res = readJson(path.join(reviewDir, 'result.json'))
        const q = readJson(queueFile) || []
        const lines = []
        if (!req) return '无待审请求'
        lines.push(`最近请求: ${req.requestId} (${req.type || 'design'})`)
        lines.push(`标题: ${req.title}`)
        if (res && res.requestId === req.requestId) {
          lines.push(`结论: ${res.verdict}`)
          if (res.summary) lines.push(`摘要: ${res.summary}`)
        } else {
          lines.push('结论: 审核中')
        }
        if (q.length) lines.push(`队列: ${q.length} 个待审`)
        return lines.join('\n')
      },
    },
  ]

  ctx.effect(() => {
    const disposers = toolDefs.map((def) => ctx.tools.register(def))

    // 设计文档自动识别（tools/execute 拦截 write/edit，自身写入豁免）
    const offExec = ctx.on('tools/execute', async (exec, next) => {
      if (config.mode === 'off') return next()
      const tool = exec?.name
      if (tool !== 'write' && tool !== 'edit') return next()
      if (exec?.agent === undefined) return next()
      const args = exec.arguments ?? {}
      // write/edit 工具的路径参数是 file_path（下划线，DSH dsh-tool-fs schema）
      const filePath = args.file_path || args.file || args.filePath || args.path || ''
      // 自身写入豁免（防死循环）
      if (args.headers?.[OWN_WRITE_MARKER] === '1') return next()
      // 读取文件前 40 行做关键词启发
      let firstLines = ''
      try { firstLines = readFileSync(filePath, 'utf8').slice(0, 4000) } catch { /* 新文件 */ }
      if (!isDesignDoc(filePath, firstLines, config)) return next()
      const sessionId = String(exec.agent.session.id || '')
      const r = submit({ title: `[design] ${path.basename(filePath)}`, docPath: filePath, changeFiles: [filePath], type: 'design', sessionId })
      if (r.ok) {
        audit({ ts: new Date().toISOString(), action: 'auto-submit', requestId: r.requestId, file: filePath, sessionId })
        if (config.mode === 'mandatory') {
          deliver(sessionId, `检测到设计文档写入: ${filePath}\n已提审 ${r.requestId}（评审 pending，暂缓实施该方案）`)
        } else {
          deliver(sessionId, `检测到设计文档写入: ${filePath}\n已提审 ${r.requestId}（advisory 通知）`)
        }
        startPolling(r.requestId, sessionId, path.basename(filePath), 'design')
      }
      return next()
    }, { prepend: true, global: true })

    // watchdog 登记轮询心跳（非裸 setTimeout，响应 004 意见 4）
    let watchdogHandle
    try {
      watchdogHandle = ctx.watchdog?.register?.({
        id: `${name}-poll`,
        label: 'design-review 轮询',
        intervalSecs: 30,
        run: () => {
          drainQueue()
          return { ok: true }
        },
      })
    } catch { /* watchdog 不可用时降级为内部定时 */ }

    return () => {
      for (const d of disposers) d()
      offExec?.()
      if (watchdogHandle) try { ctx.watchdog?.unregister?.(watchdogHandle) } catch { /* 忽略 */ }
    }
  }, 'dsh-design-review: intercept')

  ctx.logger?.info?.(
    `[dsh-design-review] loaded (mode=${config.mode}, queueMode=${config.queueMode}, patterns=${config.patterns.length}, keywords=${config.keywords.length})`,
  )
}

// Cordis 4 inject 声明：tools（注册工具）+ agents（结论投递）+ watchdog（轮询登记）。
export const inject = ['tools', 'agents', 'watchdog']
apply.inject = ['tools', 'agents', 'watchdog']

// 纯函数导出（单测）
export {
  defaultConfig, validateConfig, isDesignDoc, hasPendingRequest, hasResultFor,
  buildRequest, buildGuardrailEntry, checkGuardrailConflict, OWN_WRITE_MARKER,
} from './core.js'
