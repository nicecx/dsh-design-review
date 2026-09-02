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
  buildRequest, buildGuardrailEntry, checkGuardrailConflict, checkReuseSection,
  checkTemplateSections, scanDefectPattern, isSkillDoc, gateByType, pickGateContent,
  isGitPushCmd, isTestCmd, isPrecheckCmd, parseProtocolTypes, OWN_WRITE_MARKER,
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
  /** 035 非阻塞⑤：auto-submit 短窗口去重表（key=path|docType|sessionId → lastTs） */
  const autoSubmitRecent = new Map()
  const audit = (entry) => {
    try {
      mkdirSync(path.dirname(logPath), { recursive: true })
      appendFileSync(logPath, JSON.stringify(entry) + '\n')
    } catch { /* 审计失败不阻断 */ }
  }

  /** 019：design-review.log 尾部窗口内是否存在指定 action 记录（sessionId + repo 归属）。 */
  const recentAudit = (action, sessionId, repo, windowMs) => {
    try {
      const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').slice(-200) : []
      const now = Date.now()
      for (const l of lines) {
        if (!l) continue
        try {
          const d = JSON.parse(l)
          if (d.action !== action) continue
          if (sessionId && d.sessionId && d.sessionId !== sessionId) continue
          if (repo && d.repo && !String(d.repo).includes(String(repo).split('/').pop())) continue
          const ts = Date.parse(d.ts || 0)
          if (!Number.isNaN(ts) && now - ts <= windowMs) return true
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 读失败按无记录 */ }
    return false
  }

  /** 019：收录类判定（upstream diff 含 data/plugins；upstream 不可解析 → fail-closed 按收录类）。 */
  const isCatalogPush = async (repo) => {
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const run = promisify(execFile)
      const dir = repo || '.'
      let out
      try {
        out = await run('git', ['diff', '--name-only', '@{upstream}...HEAD', '--', 'data/plugins/'], { cwd: dir, timeout: 5000 })
      } catch {
        return true // upstream 不可解析 → fail-closed（按收录类要求预检）
      }
      return String(out.stdout || '').trim().length > 0
    } catch {
      return true
    }
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
   * 提审（阶段 3 入队版）：复用评估关卡（003 approved）→ 文档快照 → 入队 task-queue。
   * 关卡：文档含「复用评估」节且命中引用/逃逸声明，否则拒绝入队（note 给作者三查提示）。
   */
  /**
   * 035 approved 措施②（DSH 侧实施）：提审 type 归属校验——
   * 锚点 = PROTOCOL.md 的 type 枚举（parseProtocolTypes 读文件不硬编码，防再次漂移）；
   * 无归属 type 拒绝入队并落审计（rejected-unowned），使提审方可感知并改提正确类型。
   */
  const protocolTypes = () => {
    try {
      const protoPath = path.join(reviewDir, 'PROTOCOL.md')
      if (!existsSync(protoPath)) return ['design', 'lesson', 'skill', 'arbitration'] // 文件缺失时保守放行已知全集
      return parseProtocolTypes(readFileSync(protoPath, 'utf8'))
    } catch { return ['design', 'lesson', 'skill', 'arbitration'] }
  }

  const submit = (opts) => {
    ensureDir()
    const requestId = opts.requestId || nextRequestId()
    // 035 approved 措施②：type 归属校验（防 027-034 无 monitor 认领卡死单槽重演）
    const reqType = opts.type || 'design'
    const known = protocolTypes()
    if (!known.includes(reqType)) {
      audit({ ts: new Date().toISOString(), action: 'rejected-unowned', requestId, title: opts.title, type: reqType, reason: `type=${reqType} 不在 PROTOCOL 枚举 ${JSON.stringify(known)} 内，无 monitor 认领——拒绝入队` })
      return { ok: false, queued: false, note: `提审被拒：type=${reqType} 无归属（PROTOCOL 枚举: ${known.join('/')}）。请改提 design/lesson/skill/arbitration。` }
    }
    // 025 approved：入队必审——queueMode=queue（默认）时排队不拒绝；'skip' 保留兼容旧配置
    const pendingCount = readQueue().filter((t) => t.tier === 'review' && (t.status === 'queued' || t.status === 'processing')).length
    if (config.queueMode === 'skip' && pendingCount > 0) {
      audit({ ts: new Date().toISOString(), action: 'skipped', title: opts.title })
      return { ok: false, queued: false, note: '队列已有 pending review 任务（单槽），跳过' }
    }
    // ETA 基线（025 approved：与 Hermes 商量——实测 result 历史耗时均值，随提审可核对）
    let etaMin = 25
    try {
      const res = readJson(path.join(reviewDir, 'result.json'))
      const req = readJson(path.join(reviewDir, 'request.json'))
      if (res && req && res.requestId === req.requestId && req.ts) {
        const dur = (Date.parse(res.ts || Date.now()) - Date.parse(req.ts)) / 60000
        if (dur > 0) etaMin = Math.round(dur)
      }
    } catch { /* 基线缺失用默认 */ }
    // 统一入队关卡（20260901-019 approved：gateByType——design=复用+模板；skill=仅复用；lesson=豁免）
    // 20260901-021 approved：pickGateContent——待写内容优先（新文件首次写入未落盘，防绕过窗口）
    let reuseCheck = { index: [], awesome: [], github: [] }
    try {
      if (opts.type === 'design' || opts.type === 'skill') {
        const content = pickGateContent({ ...opts, existsSync })
        if (content !== undefined) {
          const r = gateByType(opts.type, content)
          if (!r.ok) {
            audit({ ts: new Date().toISOString(), action: opts.type === 'skill' ? 'skill-reuse-reject' : 'reuse-reject', requestId, title: opts.title, reason: r.reason })
            return {
              ok: false, queued: false,
              note: `提审被拒：${r.reason}${opts.type === 'skill' ? '（skill 文件须内嵌「## 复用评估」节：三查引用或「无复用」声明）' : '。请补充「## 复用评估」节（三查：CAPABILITY-INDEX / awesome / GitHub 引用；全新功能可声明「无复用」）。'}`,
            }
          }
          reuseCheck = r.references
        }
      }
    } catch (e) {
      // fail-closed（20260901 教训：关卡异常时放行=被绕过，如 import 缺失 ReferenceError）
      audit({ ts: new Date().toISOString(), action: 'gate-check-failed', requestId, error: String(e).slice(0, 200) })
      return {
        ok: false, queued: false,
        note: `提审被拒：关卡检查异常（${String(e).slice(0, 80)}）。请重试；若持续失败报告插件故障。`,
      }
    }
    // 文档快照（013 建议 + 026：幂等双保险；消费端出队时也会落盘）
    // 20260902 修复：快照同样受"新文件未落盘"影响（021 只修了关卡检查）——
    // 新文件首写时 existsSync=false → 快照静默跳过 → docs 空洞 → 取号错位（007 lesson 洞）
    try {
      if (opts.docPath) {
        mkdirSync(docsDir, { recursive: true })
        const dst = path.join(docsDir, `${requestId}.md`)
        if (path.resolve(opts.docPath) !== path.resolve(dst)) {
          if (opts.content !== undefined) {
            writeFileSync(dst, opts.content)  // 待写内容优先（防新文件未落盘）
          } else if (existsSync(opts.docPath)) {
            copyFileSync(opts.docPath, dst)
          }
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
        reuseCheck,  // 003 approved：结构化复用检索结果（Hermes 可核对一致性）
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
    // 025 approved：排队位置 + ETA（入队必审，永不拒绝）
    const pos = q.filter((t) => t.tier === 'review' && (t.status === 'queued' || t.status === 'processing')).length
    return { ok: true, requestId, queued: pos > 1, queuePos: pos, etaMin }
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
            // 20260901-006 approved：lesson 跨 agent 传播（P1）——若 lesson 声明缺陷模式，
            // 扫描全机产出候选清单（限定 ~/.dsh + Workspace/dsh-*），交付发起会话复核。
            // 复核后由 agent 显式提审修复（tier=review 互审，禁止自动应用）。
            try {
              const docPath = path.join(reviewDir, 'docs', `${requestId}.md`)
              const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : ''
              const m = doc.match(/##\s*缺陷模式[^\n]*\n([^\n]+)/)
              const pattern = m ? m[1].trim() : ''
              if (pattern) {
                const roots = [
                  path.join(os.homedir(), '.dsh'),
                  path.join(os.homedir(), 'Documents', 'Workspace'),
                ]
                const candidates = scanDefectPattern(pattern, roots)
                audit({ ts: new Date().toISOString(), action: 'prop-scan', requestId, pattern, hits: candidates.length })
                deliver(sessionId, `🧬 lesson 传播扫描（${requestId}）：模式「${pattern}」命中 ${candidates.length} 处候选（前 10 条）：
${candidates.slice(0, 10).map((c) => `- ${c.file}:${c.line}  ${c.context}`).join('\n') || '（无）'}
请逐项复核（排除假阳性），确认真命中后按正常提审流程提交修复方案（tier=review 互审）。`)
              }
            } catch (e) {
              audit({ ts: new Date().toISOString(), action: 'prop-scan-failed', requestId, error: String(e) })
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
        return `✅ 已入队 ${r.requestId}（tier=review，第 ${r.queuePos} 位，预计等待 ~${(r.queuePos - 1) * r.etaMin}min）\n文档: ${args.docPath}\n结论将注入本会话。`
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
          defectPattern: { type: 'string', description: 'Defect pattern keyword for cross-agent propagation scan (optional, 006 approved: e.g. "kickstart -k")' },
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
          args.defectPattern ? `## 缺陷模式（传播扫描）\n${args.defectPattern}` : '',
          args.impact ? `## 影响面\n${args.impact}` : '',
          args.reproducible ? `## 可复现性\n${args.reproducible}` : '',
        ].filter(Boolean).join('\n')
        writeFileSync(docPath, content)
        // 021 approved 非阻塞修复：submit 传已算的 rid（否则 submit 再取号 = rid+1，
        // 导致 requestId 与 docs/<rid>.md 错位——009/012 的 changeFiles 指向旧号问题）
        const r = submit({ title: `[lesson] ${args.title}`, docPath, changeFiles: [docPath], tests: '', type: 'lesson', sessionId, requestId: rid, defectPattern: args.defectPattern || '' })
        if (!r.ok) return `⚠️ ${r.note}`
        startPolling(r.requestId, sessionId, args.title, 'lesson')
        return `✅ 已入队 ${r.requestId}（type=lesson）\napproved 后将防复发措施追加到 OPS-GUARDRAILS.md${args.defectPattern ? '，并按缺陷模式做传播扫描。' : '。'}`
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
      // 待写内容优先（20260901 修复：新文件首次写入时文件尚未落盘，readFileSync 读不到——
      // 用 exec.arguments.content 做关卡判定，避免"新文件绕过"窗口）
      const pendingContent = typeof args.content === 'string' ? args.content : ''
      let content = pendingContent
      if (!content) { try { content = readFileSync(filePath, 'utf8') } catch { /* 新文件 */ } }
      // 20260901-019 approved：isSkillDoc 优先（type=skill），否则 isDesignDoc（type=design）
      const docType = isSkillDoc(filePath) ? 'skill' : (isDesignDoc(filePath, (content || '').slice(0, 4000), config) ? 'design' : null)
      if (!docType) return next()
      const sessionId = String(exec.agent.session.id || '')
      // 035 approved 非阻塞⑤：同 path+docType 短窗口去重（5s）——一次 SKILL.md 修改多次
      // write/edit 事件只提审一次，防 027-034 八连提审重演（放大因子=每次写入触发一次 auto-submit）
      const dedupKey = `${filePath}|${docType}|${sessionId}`
      const dedupNow = Date.now()
      const lastAuto = autoSubmitRecent.get(dedupKey)
      if (lastAuto && dedupNow - lastAuto < 5000) return next()
      autoSubmitRecent.set(dedupKey, dedupNow)
      // 防 Map 无限增长：只保留 60s 内条目
      for (const [k, t] of autoSubmitRecent) {
        if (dedupNow - t > 60000) autoSubmitRecent.delete(k)
      }
      const r = submit({ title: `[${docType}] ${path.basename(filePath)}`, docPath: filePath, changeFiles: [filePath], type: docType, sessionId, content: content || undefined })
      if (r.ok) {
        audit({ ts: new Date().toISOString(), action: 'auto-submit', requestId: r.requestId, file: filePath, sessionId, docType })
        if (config.mode === 'mandatory') {
          deliver(sessionId, `检测到${docType}文档写入: ${filePath}\n已提审 ${r.requestId}（评审 pending，暂缓实施）`)
        } else {
          deliver(sessionId, `检测到${docType}文档写入: ${filePath}\n已提审 ${r.requestId}（advisory 通知）`)
        }
        startPolling(r.requestId, sessionId, path.basename(filePath), docType)
      } else {
        // 003 approved：关卡拒绝不再静默——作者收到原因 + 三查提示（audit 已在 submit 内记录）
        deliver(sessionId, `⚠️ ${docType}文档未通过复用评估关卡：${r.note}`)
      }
      return next()
    }, { prepend: true, global: true })

    // 20260902-019 approved：Git push 关卡（护栏+审计）——bash 工具拦截
    const offPush = ctx.on('tools/execute', async (exec, next) => {
      if (!config.gitPushGate) return next()
      if (exec?.name !== 'bash') return next()
      if (exec?.agent === undefined) return next()
      const args = exec.arguments ?? {}
      const cmd = String(args.command || args.cmd || '')
      const sessionId = String(exec.agent.session.id || '')
      const repo = String(args.cwd || exec.agent.session?.cwd || '')
      const now = Date.now()

      // 测试/预检命令登记（await next 观察结果：成功记 test-run，失败记 test-fail）
      if (isTestCmd(cmd) || isPrecheckCmd(cmd)) {
        const res = await next()
        const ok = !(res && (res.isError || res.exitCode > 0))
        const action = isPrecheckCmd(cmd) ? (ok ? 'gate-precheck' : 'gate-precheck-fail') : (ok ? 'test-run' : 'test-fail')
        audit({ ts: new Date().toISOString(), action, sessionId, repo, cmd: cmd.slice(0, 200) })
        return res
      }

      // git push 检查
      if (isGitPushCmd(cmd)) {
        const win = (config.testRunWindowMin || 30) * 60000
        const pwin = (config.precheckWindowMin || 30) * 60000
        let ok = true, why = ''
        // 测试成功记录（本会话 + 同 repo）
        if (!recentAudit('test-run', sessionId, repo, win)) { ok = false; why = '近 ' + (win/60000) + ' 分钟无测试成功记录（test-run）' }
        else {
          const fail = recentAudit('test-fail', sessionId, repo, win)
          if (fail) { ok = false; why = '最近测试失败（test-fail），请先修复' }
        }
        // 收录类：upstream diff 含 data/plugins → 需 gate-precheck
        if (ok && await isCatalogPush(repo)) {
          if (!recentAudit('gate-precheck', sessionId, repo, pwin)) { ok = false; why = '收录类 push 缺本地 gate 预检（gate-precheck）' }
        }
        audit({ ts: new Date().toISOString(), action: ok ? 'push-allowed' : 'push-blocked', sessionId, repo, cmd: cmd.slice(0, 300) })
        if (!ok) {
          const text = `⚠️ Git push 被拦（护栏）：${why}\n请按 git-submit-practice 流程：① 测试先行（node --test / python3 test 全绿）② 收录类先跑本地 gate 预检（check-submission.mjs）③ 再 push。`
          return { isError: true, error: text, content: [{ type: 'text', text }] }
        }
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
      offPush?.()
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
  buildRequest, buildGuardrailEntry, checkGuardrailConflict, checkReuseSection,
  checkTemplateSections, scanDefectPattern, isSkillDoc, gateByType, pickGateContent, OWN_WRITE_MARKER,
} from './core.js'
