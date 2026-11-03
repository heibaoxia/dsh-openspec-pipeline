// 离线回归共用的假宿主：顶层对话、事件流、动作接口都够用，不起 DSH。
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function makeSandbox(prefix = 'osp-') {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), prefix))
  process.env.DSH_PROFILE_DIR = path.join(sandbox, 'profile')
  mkdirSync(process.env.DSH_PROFILE_DIR, { recursive: true })
  return sandbox
}

export function makeProject(sandbox, name, changes) {
  const proj = path.join(sandbox, name)
  const dir = path.join(proj, 'openspec', 'changes')
  mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
  mkdirSync(path.join(dir, 'archive'), { recursive: true })
  for (const change of changes) {
    const base = path.join(dir, change)
    mkdirSync(path.join(base, 'specs', 'demo'), { recursive: true })
    writeFileSync(path.join(base, 'proposal.md'), `# ${change}\n`, 'utf8')
    writeFileSync(path.join(base, 'design.md'), `# ${change}\n`, 'utf8')
    writeFileSync(path.join(base, 'tasks.md'), '- [ ] 做事\n', 'utf8')
    writeFileSync(
      path.join(base, 'specs', 'demo', 'spec.md'),
      `## ADDED Requirements\n\n### Requirement: ${change}\n\nThe system SHALL do it.\n\n#### Scenario: works\n- **WHEN** 有人要它做\n- **THEN** 它做了\n`,
      'utf8',
    )
  }
  return proj
}

export function writePipeline(proj, nodes, supervisor) {
  writeFileSync(
    path.join(proj, 'openspec', 'pipeline.json'),
    JSON.stringify(
      {
        version: 1,
        name: '离线测试',
        maxParallel: 1,
        profiles: [],
        defaultProfileId: '',
        ...(supervisor ? { supervisor } : {}),
        nodes: [{ id: 'start', kind: 'start', change: '', deps: [], status: 'done' }, ...nodes],
      },
      null,
      2,
    ),
    'utf8',
  )
}

export function archiveChange(proj, name, as = `2026-11-03-${name}`) {
  renameSync(path.join(proj, 'openspec', 'changes', name), path.join(proj, 'openspec', 'changes', 'archive', as))
}

export function endTurn(session, reason = 'completed', text = '') {
  if (text) {
    session.push({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
  }
  session.push({ type: 'turn/end', data: { reason: { kind: reason } } })
}

// 起一个假宿主。onCreate / onPrompt / onCancel / onSelectModel 都是可选的钩子，
// 抛错就等价于宿主拒绝这一步。
export async function startHost(options = {}) {
  const { projects = [], onCreate, onPrompt, onCancel, onSelectModel } = options
  const sessions = new Map()
  const created = []
  const prompts = []
  const cancels = []
  const selected = []
  const tools = []
  const routes = []
  let sessionSeq = 0

  const host = { sessions, created, prompts, cancels, selected, tools, routes }

  function newSession(id) {
    const sessionId = id || `session-${++sessionSeq}`
    const events = []
    const session = {
      id: sessionId,
      seq: 0,
      events,
      push(event) {
        event.seq = ++this.seq
        events.push(event)
        return event
      },
      snapshotEvents(from = 0) {
        const start = Math.max(0, Number(from) || 0)
        return events.filter((event) => event.seq >= start)
      },
    }
    sessions.set(sessionId, session)
    return session
  }
  host.newSession = newSession

  const workspaces = projects.map((project, index) => ({
    id: `w${index + 1}`,
    title: path.basename(project),
    path: project,
  }))

  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    get(name) {
      if (name === 'sessionController') {
        return {
          async create(request) {
            created.push(request)
            const session = newSession()
            if (onCreate) await onCreate({ session, request, host })
            return { sessionId: session.id }
          },
          async prompt(request, signal) {
            const text = String(request.content?.[0]?.text || '')
            const sessionId = String(request.sessionId || '')
            if (!signal) throw new Error('prompt 少了取消信号')
            prompts.push({ sessionId, text })
            if (onPrompt) return onPrompt({ sessionId, text, request, session: sessions.get(sessionId), host })
            return { accepted: true }
          },
          async cancel(request) {
            cancels.push(request)
            if (onCancel) return onCancel(request, host)
            return undefined
          },
          async selectModel(request) {
            selected.push(request)
            if (onSelectModel) return onSelectModel(request, host)
            return { selected: { provider: request.provider, model: request.model } }
          },
        }
      }
      if (name === 'agents') {
        return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
      }
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'agentDefaultModel') return null
      if (name === 'workspaceRegistry') {
        return {
          list: () => workspaces,
          create: async (root, title) => {
            const row = { id: `w${workspaces.length + 1}`, title: title || path.basename(root), path: root }
            workspaces.push(row)
            return row
          },
        }
      }
      return undefined
    },
  }

  const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)
  host.cleanup = apply(ctx)
  if (!tools.length) throw new Error('工具没注册上')
  if (!routes.length) throw new Error('路由没注册上')

  async function call(method, url, body) {
    const req = {
      method,
      url,
      [Symbol.asyncIterator]: async function* () {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) {
        this.headers[key] = value
      },
      end(text) {
        this.body = text
      },
    }
    await routes[0].handler(req, res)
    const payload = res.body ? JSON.parse(res.body) : {}
    return { status: res.statusCode, payload, ok: payload.ok, text: payload.text, error: payload.error }
  }

  host.post = (body) => call('POST', '/openspec-pipeline/api/action', body)
  host.getState = (root) => call('GET', `/openspec-pipeline/api/state?root=${encodeURIComponent(root)}`)
  host.close = () => host.cleanup?.()
  host.promptsFor = (sessionId) => prompts.filter((row) => row.sessionId === sessionId)
  return host
}

export function makeChecker() {
  const failures = []
  function check(name, condition, detail) {
    if (condition) console.log(`  ok   ${name}`)
    else {
      console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 600)}` : ''}`)
      failures.push(name)
    }
  }
  function finish() {
    console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
    process.exit(failures.length ? 1 : 0)
  }
  return { check, finish, failures }
}

export async function waitFor(predicate, timeout = 8000, step = 50) {
  const started = Date.now()
  for (;;) {
    const hit = await predicate()
    if (hit) return hit
    if (Date.now() - started > timeout) return null
    await new Promise((resolve) => setTimeout(resolve, step))
  }
}
