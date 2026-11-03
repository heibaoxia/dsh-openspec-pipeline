// dsh-openspec-pipeline — Host half.
//
// 一张流水线图 = openspec/pipeline.json。图里每个节点是一个 OpenSpec change。
// 节点按依赖顺序开工：前置都跑完了才轮到它；同一层可以并行。
// 每个节点开工时在工作区里新建一个顶层普通对话（侧栏能看见、能点进去看过程，
// 可指定预置 / 模型 / 思考强度），发一句「执行 <change> Change」；节点上写了附加提示词
// 就接在后面。这一轮结束就算这一格完成 —— 验收和归档流水线不做，写在提示词里由人自己定。
// 归档门禁只查 archive/ 目录；节点上勾了「归档后提交」的，归档之后再补一次 git 提交。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { readFile, writeFile, rename, mkdir, readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const ROUTE = '/openspec-pipeline/api'
const STATE_FILE = path.join('openspec', 'pipeline.json')
const ACTIVE = new Set(['running'])
const TERMINAL = new Set(['done', 'failed', 'needs_human', 'skipped'])
// 「有人正在别处做」的判定窗口：change 目录 / tasks.md / proposal.md 在这个时间内被改过，
// 就当作有人在别处做 —— 刷新时归到「已在他处进行」，不给加进图，也不自动开工。
const ACTIVE_WINDOW_MS = 15 * 60 * 1000
// 有格子在等时（等归档 / 等写好），runner 不退，每隔这么久看一眼仓库。
// 归档一出现、规划一写完，就自己接着跑。
const WAIT_TICK_MS = 1000

// 只声明真正需要的服务。sessionController / agents 在开跑时才用，缺了只该让「开跑」失败，
// 不该让整个 Host 卡在 pending —— 那会让桌面端直接起不来。
export const inject = ['tools', 'webServer']

function stateDir() {
  const candidates = [
    process.env.DSH_PROFILE_DIR,
    process.env.DSH_HOME,
    path.join(os.homedir(), '.dsh'),
    os.tmpdir(),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      mkdirSync(candidate, { recursive: true })
      return candidate
    } catch {}
  }
  return os.tmpdir()
}

const STATE_DIR = stateDir()
const DIAG_FILE = path.join(STATE_DIR, 'openspec-pipeline.log')
const LOG_LIMIT = 512 * 1024
let logWrites = 0

function errorText(error) {
  try {
    return String((error && (error.stack || error.message)) || error).slice(0, 4000)
  } catch {
    return 'unknown error'
  }
}

function diag(message) {
  try {
    logWrites += 1
    // 客户端报错可能在轮询里反复写；超限就截断，别把日志撑爆磁盘。
    if (logWrites % 100 === 0) {
      try {
        if (statSync(DIAG_FILE).size > LOG_LIMIT) writeFileSync(DIAG_FILE, '')
      } catch {}
    }
    appendFileSync(DIAG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

// Host 半身的 apply 抛异常同样会让整机起不来（app-boot 的 assertEntriesActivated）。
// 所以外面永远套一层：里面出错只记日志，交一个空清理函数出去。
export function apply(ctx) {
  try {
    return mount(ctx)
  } catch (error) {
    diag(`apply 失败（不影响启动）：${errorText(error)}`)
    return () => {}
  }
}

function mount(ctx) {
  const runners = new Map()
  const disposers = []
  diag(`apply 开始；tools=${Boolean(ctx.tools)} webServer=${Boolean(ctx.webServer)} sessionController=${(() => { try { return Boolean(ctx.get?.('sessionController')) } catch { return 'err' } })()} origin=${(() => { try { return ctx.webServer?.getOrigin?.() ?? 'n/a' } catch { return 'err' } })()}`)

  // ---------- 文件与状态 ----------

  const ROOT_MEMO = path.join(STATE_DIR, 'openspec-pipeline-root.json')

  function looksLikeProject(dir) {
    if (!dir) return false
    let current = dir
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(path.join(current, 'openspec'))) return true
      const up = path.dirname(current)
      if (up === current) break
      current = up
    }
    return false
  }

  function projectAt(dir) {
    if (!dir) return undefined
    let current = dir
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(path.join(current, 'openspec'))) return current
      const up = path.dirname(current)
      if (up === current) break
      current = up
    }
    return undefined
  }

  async function rememberRoot(root) {
    try {
      await writeFile(ROOT_MEMO, JSON.stringify({ root, at: Date.now() }), 'utf8')
    } catch {}
  }

  async function memorizedRoot() {
    try {
      const value = JSON.parse(await readFile(ROOT_MEMO, 'utf8'))
      if (value?.root && looksLikeProject(value.root)) return projectAt(value.root)
    } catch {}
    return undefined
  }

  // 插件自己的默认工作区（settings.root）。跟着这台机器走，不跟某个仓库走。
  // 0.12 起它只是「上一次打开的那个」：面板每次请求都带着自己选的仓库，
  // 只有第一次打开（没带）和「手动切工作区」才读 / 写这一份。
  const SETTINGS_FILE = path.join(STATE_DIR, 'openspec-pipeline-settings.json')

  async function readSettings() {
    try {
      const value = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  async function writeSettings(patch) {
    const next = { ...(await readSettings()), ...patch }
    try {
      await mkdir(STATE_DIR, { recursive: true })
      await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
    } catch (error) {
      diag(`写插件设置失败：${errorText(error)}`)
      throw error
    }
    return next
  }

  function normalizePath(value) {
    try {
      return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase()
    } catch {
      return ''
    }
  }

  // runner / 推送 / 归档监听都按「同一个仓库只能有一份」来算。
  // 同一条路径换个写法（大小写、结尾斜杠、子目录）不能变成两份正在跑的流水线。
  function runnerKey(root) {
    const project = projectAt(root) || String(root || '')
    return normalizePath(project) || String(root || '')
  }

  function workspaceRows() {
    let list = []
    try {
      list = ctx.get('workspaceRegistry')?.list?.() ?? []
    } catch (error) {
      diag(`读工作区列表失败：${errorText(error)}`)
    }
    return list
      .map((workspace) => ({
        id: String(workspace?.id || ''),
        title: String(workspace?.title || ''),
        path: String(workspace?.path || ''),
        hasOpenspec: looksLikeProject(workspace?.path),
      }))
      .filter((workspace) => workspace.id && workspace.path)
      .sort((a, b) => Number(b.hasOpenspec) - Number(a.hasOpenspec) || a.title.localeCompare(b.title, 'zh-CN'))
  }

  function workspaceFor(root) {
    const target = normalizePath(root)
    return workspaceRows().find((workspace) => normalizePath(workspace.path) === target)
  }

  // 顶层对话必须挂在一个工作区里，否则会话列表看不见它。没登记过就登记一次。
  async function ensureWorkspace(root) {
    const found = workspaceFor(root)
    if (found) return found
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.create !== 'function') {
      throw new Error('这台宿主没有工作区服务，建不了顶层对话')
    }
    const created = await registry.create(root, path.basename(root) || root)
    return {
      id: String(created?.id || ''),
      title: String(created?.title || ''),
      path: String(created?.path || root),
      hasOpenspec: true,
    }
  }

  // 插件自己的「默认工作区」：最近一次被面板打开 / 被明确选中的那个仓库。
  //   设置里选过的 > 插件上次用的 > 登记过的 OpenSpec 工作区（按路径排序，结果稳定）。
  // 面板请求会先把「当前对话所在的工作区 / 面板自己选的那个」交上来（见 panelRoot），
  // 只有这两条都没结果时才落到这里 —— 所以这条链是默认值，不是唯一答案。
  async function resolveRoot() {
    const settings = await readSettings()
    if (settings.root && looksLikeProject(settings.root)) return projectAt(settings.root) || settings.root

    const remembered = await memorizedRoot()
    if (remembered) return stickRoot(remembered)

    // 都没有就挑一个登记过的 OpenSpec 工作区：按路径排序，谁来算都是同一个答案。
    const roots = workspaceRows()
      .filter((workspace) => workspace.hasOpenspec)
      .map((workspace) => projectAt(workspace.path))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, 'en'))
    for (const root of roots) return stickRoot(root)

    const fallback = projectAt(process.cwd())
    if (fallback) return stickRoot(fallback)
    return process.cwd()
  }

  // 把「这一次解析出的仓库」变成插件自己的显式选择：记忆 + 设置各写一份，此后不再猜。
  async function stickRoot(root) {
    const project = projectAt(root) || root
    await rememberRoot(project)
    try {
      const settings = await readSettings()
      if (!(settings.root && looksLikeProject(settings.root))) await writeSettings({ root: project })
    } catch (error) {
      diag(`记住工作区失败（不影响这次读取）：${errorText(error)}`)
    }
    return project
  }

  // 「最近打开的那个工作区」：面板每打开一次就记一次，是下一个没有对话依据的面板的默认值。
  // 和上面不同，这里**总是**覆盖（面板刚看的就是最新事实），不是「只在没设过时写」。
  async function setDefaultRoot(root) {
    const project = projectAt(root) || String(root || '')
    await rememberRoot(project)
    try {
      const settings = await readSettings()
      if (normalizePath(settings.root) !== normalizePath(project)) await writeSettings({ root: project })
    } catch (error) {
      diag(`记住默认工作区失败（不影响这次读取）：${errorText(error)}`)
    }
    return project
  }

  // 请求里带过来的「当前对话」：面板用它来挑默认工作区，别的一概不看它。
  // 字符串 / { sessionId, cwd } 两种写法都收，老客户端不带也没有关系。
  function seatOf(source) {
    const raw = source?.seat
    const sessionId = String((raw && typeof raw === 'object' ? raw.sessionId : raw) || source?.sessionId || '').trim()
    const cwd = String((raw && typeof raw === 'object' ? raw.cwd : '') || source?.cwd || '').trim()
    return sessionId || cwd ? { sessionId, cwd } : undefined
  }

  // 当前对话落在哪个工作区：先问工作区注册表（归档 / 重启之后也还在），
  // 再看会话自己的 cwd，最后才看客户端报上来的 cwd。
  // 只有那个目录真的有 openspec/ 才算数 —— 没有就交回默认值，别把人带去一个空图。
  async function seatWorkspaceRoot(seat) {
    if (!seat) return ''
    let list = []
    try {
      list = ctx.get?.('workspaceRegistry')?.list?.() ?? []
    } catch (error) {
      diag(`读工作区列表失败（挑默认工作区用）：${errorText(error)}`)
    }
    if (seat.sessionId) {
      const owner = list.find(
        (workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(seat.sessionId),
      )
      if (owner?.path && looksLikeProject(owner.path)) return projectAt(owner.path)
    }
    let live = ''
    try {
      live = String(ctx.get?.('sessions')?.get?.(seat.sessionId)?.header?.cwd || '')
    } catch {}
    for (const candidate of [live, seat.cwd]) {
      if (candidate && looksLikeProject(candidate)) return projectAt(candidate)
    }
    return ''
  }

  // 一个面板看哪个仓库，按这个顺序定：
  //   1) 面板自己选过的（它每次请求都带着，所以两个面板可以各看各的）；
  //   2) 当前对话所在的工作区（真的有 openspec/ 才算）；
  //   3) 上一次打开的那个工作区（见 setDefaultRoot）。
  // 返回 from 是为了让面板说清楚这个仓库是怎么来的（跟着对话 / 上次打开的 / 自己选的）。
  async function panelRoot(requested, seat) {
    const explicit = String(requested || '').trim()
    if (explicit && looksLikeProject(explicit)) return { root: projectAt(explicit) || explicit, from: 'panel' }
    const fromSeat = await seatWorkspaceRoot(seat)
    if (fromSeat) return { root: fromSeat, from: 'seat' }
    return { root: await resolveRoot(), from: 'default' }
  }

  // 一套运行配方（对话模式 / 运营商 / 模型 / 强度 / 附加提示词），存下来可以反复套到别的节点上。
  function normalizeProfile(raw) {
    const name = String(raw?.name || '').trim()
    const profile = {
      id: String(raw?.id || '').trim() || `p${Math.random().toString(36).slice(2, 8)}`,
      name: name || '未命名组合',
      preset: raw?.preset || '',
      provider: raw?.provider || '',
      model: raw?.model || '',
      effort: raw?.effort || '',
      prompt: raw?.prompt || '',
    }
    // 「归档后提交」在组合里是三态：存过（true / false）就照办；没存过（0.14 及以前的老组合）
    // 就不带这个键 —— 套用 / 播种时不碰节点上已经勾好的那一项。
    if (raw?.commit !== undefined && raw?.commit !== null) profile.commit = Boolean(raw.commit)
    return profile
  }

  // 四样运行设置。开跑时「节点四样全空 → 用默认组合」的兜底只走这里：
  // 提示词永远取节点自己的，免得节点上手写的口径被默认组合悄悄盖掉。
  function settingsOfProfile(profile) {
    return {
      preset: profile?.preset || '',
      provider: profile?.provider || '',
      model: profile?.model || '',
      effort: profile?.effort || '',
    }
  }

  // 完整配方：四样 + 提示词 + （存过的）归档后提交。新加节点用它播种，勾也一起带上。
  function recipeOfProfile(profile) {
    const recipe = { ...settingsOfProfile(profile), prompt: profile?.prompt || '' }
    if (profile && profile.commit !== undefined) recipe.commit = Boolean(profile.commit)
    return recipe
  }

  // 默认组合跟着仓库走。id 失效（组合被删/改名）就当没设。
  function defaultProfileOf(state) {
    const id = String(state?.defaultProfileId || '').trim()
    if (!id) return null
    return (state.profiles || []).find((profile) => profile.id === id) || null
  }

  function defaultProfileIdOf(rawId, profiles) {
    const id = String(rawId || '').trim()
    return id && profiles.some((profile) => profile.id === id) ? id : ''
  }

  // 节点四样全留空 = 没单独设置，开跑时用默认组合。
  // 只要设了其中一样，就按节点自己的来，不再和默认混。
  function resolveRunSettings(state, node) {
    const configured = Boolean(node?.preset || node?.provider || node?.model || node?.effort)
    if (configured) return settingsOfProfile(node)
    return settingsOfProfile(defaultProfileOf(state))
  }

  function clean(state) {
    const profiles = (state.profiles || []).map(normalizeProfile)
    return {
      version: 1,
      name: state.name || '未命名流水线',
      maxParallel: Math.max(1, Number(state.maxParallel) || 1),
      // 跑完当前这一格就收工，不自动往下拉。运行中改这个开关也生效。
      pauseAfterNode: Boolean(state.pauseAfterNode),
      // 默认运行设置：新加的节点自动带上；老节点四样全空时开跑兜底。
      defaultProfileId: defaultProfileIdOf(state.defaultProfileId, profiles),
      profiles,
      supervisor: normalizeSupervisor(state.supervisor),
      nodes: (state.nodes || []).map((n) => ({
        id: n.id,
        kind: n.kind === 'start' ? 'start' : 'change',
        change: n.change,
        x: Number.isFinite(n.x) ? n.x : null,
        y: Number.isFinite(n.y) ? n.y : null,
        deps: n.deps || [],
        preset: n.preset || '',
        provider: n.provider || '',
        model: n.model || '',
        effort: n.effort || '',
        prompt: n.prompt || '',
        // 勾了的格子：change 进了 archive/ 之后，Host 自己在工作区里提交一次。
        commit: Boolean(n.commit),
        approved: n.approved || '',
        status: normalizeStatus(n.status),
        note: n.note || '',
        sessionId: n.sessionId || '',
        updatedAt: n.updatedAt || '',
      })),
    }
  }

  const START = {
    id: 'start',
    kind: 'start',
    change: '',
    x: null,
    y: null,
    deps: [],
    preset: '',
    provider: '',
    model: '',
    effort: '',
    prompt: '',
    commit: false,
    approved: '',
    status: 'done',
    note: '',
    sessionId: '',
    updatedAt: '',
  }

  // 图上永远有一个「开工」节点。没从它连出来的节点只是摆着，不会执行。
  function withStart(nodes) {
    return [START, ...nodes.filter((node) => node.id !== 'start')]
  }

  function normalize(raw, options = {}) {
    const profiles = Array.isArray(raw?.profiles) ? raw.profiles.map(normalizeProfile) : []
    const state = {
      version: 1,
      name: raw?.name || '未命名流水线',
      maxParallel: Math.max(1, Number(raw?.maxParallel) || 1),
      pauseAfterNode: Boolean(raw?.pauseAfterNode),
      defaultProfileId: defaultProfileIdOf(raw?.defaultProfileId, profiles),
      profiles,
      // 值班对话（监工）：插件建的那个会话的 id 和它的运行设置。没有它就没有监工。
      supervisor: normalizeSupervisor(raw?.supervisor),
      nodes: Array.isArray(raw?.nodes) ? raw.nodes.map(normalizeNode) : [],
    }
    // 只有「上一个进程真的没了」才把 running 标成中断。
    // 进程还活着、runner 正在跑的时候读同一个文件，绝不能这样改，否则面板会把
    // 正在干活的格子显示成「失败」。
    if (options.recover !== false) {
      for (const node of state.nodes) {
        if (ACTIVE.has(node.status)) {
          node.status = 'failed'
          node.note = node.note || '上次运行中断，这一格没跑完'
        }
      }
    }
    state.nodes = withStart(state.nodes)
    return clean(state)
  }

  // change 现在在仓库的哪个位置：还在 changes/、已经进 archive/、还是两边都没有。
  // 「已归档」必须能认出来：Agent 归档完的格子如果被当成失败，下游就永远等不到它。
  function archivedState(root, change) {
    const changesDir = path.join(root, 'openspec', 'changes')
    if (existsSync(path.join(changesDir, change))) {
      return { active: true, archived: false, as: '' }
    }
    let names = []
    try {
      names = readdirSync(path.join(changesDir, 'archive'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {}
    const as = names.find((name) => name === change || name.endsWith(`-${change}`)) || ''
    return { active: false, archived: Boolean(as), as }
  }

  // 前置算「满足」：这一格自己跑完了，或者它的 change 已经进了 archive/。
  // 只有手动「启动」按这个口径 —— 人明确点了，就不必等上游那一轮收尾。
  // 整批「开始」仍然只认 done：没验完就往下跑，两个 change 会混在一起。
  function depSettled(root, byId, id) {
    if (id === 'start') return true
    const node = byId.get(id)
    if (!node) return false
    if (node.status === 'done') return true
    return archivedState(root, node.change).archived
  }

  // 0.7 及更早的文件里还留着 verifying / archiving 两种状态。0.8 起没有验收和归档了，
  // 这两种状态只会出现在「上次跑到一半就被关掉」的格子上，一律按失败处理，
  // 否则它会停在既不跑、也不失败的位置，点「开始」也回收不到。
  const LEGACY_STATUS = { verifying: 'failed', archiving: 'failed' }

  function normalizeStatus(value) {
    const status = String(value || '')
    if (LEGACY_STATUS[status]) return LEGACY_STATUS[status]
    if (
      status === 'running' ||
      status === 'done' ||
      status === 'failed' ||
      status === 'needs_human' ||
      status === 'skipped'
    ) {
      return status
    }
    return 'pending'
  }

  function normalizeNode(raw, index) {
    const id = String(raw?.id ?? raw?.change ?? `N${index + 1}`).trim()
    const deps = Array.isArray(raw?.deps) ? raw.deps.map(String).map((s) => s.trim()).filter(Boolean) : []
    if (id === 'start') return { ...START }
    return {
      id,
      kind: 'change',
      change: String(raw?.change ?? id).trim(),
      x: Number.isFinite(raw?.x) ? raw.x : null,
      y: Number.isFinite(raw?.y) ? raw.y : null,
      deps: deps.filter((d) => d !== id),
      preset: raw?.preset || '',
      provider: raw?.provider || '',
      model: raw?.model || '',
      effort: raw?.effort || '',
      prompt: raw?.prompt || '',
      commit: Boolean(raw?.commit),
      approved: raw?.approved || '',
      status: normalizeStatus(raw?.status),
      note: raw?.note || '',
      sessionId: raw?.sessionId || '',
      updatedAt: raw?.updatedAt || '',
    }
  }

  async function loadState(root, options = {}) {
    const file = path.join(root, STATE_FILE)
    try {
      return normalize(JSON.parse(await readFile(file, 'utf8')), options)
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
      return normalize({}, options)
    }
  }

  let writeChain = Promise.resolve()
  function saveState(root, state) {
    const payload = JSON.stringify(clean(state), null, 2)
    const file = path.join(root, STATE_FILE)
    writeChain = writeChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, payload, 'utf8')
      // Windows 上目标文件正被面板读着时 rename 会 EPERM，退几步重试；再不行就直接覆盖写。
      for (let attempt = 0; attempt <= 5; attempt += 1) {
        try {
          await rename(tmp, file)
          return
        } catch (error) {
          if (attempt === 5) break
          await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
        }
      }
      await writeFile(file, payload, 'utf8')
    })
    return writeChain
  }

  // 从某一格顺着线能走到的节点（不含起点自己）。
  function reachableFrom(nodes, from) {
    const children = new Map()
    for (const node of nodes) {
      for (const dep of node.deps || []) {
        if (!children.has(dep)) children.set(dep, [])
        children.get(dep).push(node.id)
      }
    }
    const seen = new Set()
    const stack = [from]
    while (stack.length) {
      const id = stack.pop()
      for (const child of children.get(id) || []) {
        if (seen.has(child)) continue
        seen.add(child)
        stack.push(child)
      }
    }
    return seen
  }

  // 从「开工」顺着线能走到的节点；走不到的就是摆在图上的草稿。
  function reachableFromStart(nodes) {
    return reachableFrom(nodes, 'start')
  }

  function depthsFromStart(nodes) {
    const children = new Map()
    for (const node of nodes) {
      for (const dep of node.deps || []) {
        if (!children.has(dep)) children.set(dep, [])
        children.get(dep).push(node.id)
      }
    }
    const depth = new Map([['start', 0]])
    let frontier = ['start']
    while (frontier.length) {
      const next = []
      for (const id of frontier) {
        for (const child of children.get(id) || []) {
          const value = (depth.get(id) || 0) + 1
          if ((depth.get(child) ?? -1) >= value) continue
          depth.set(child, value)
          next.push(child)
        }
      }
      frontier = next
    }
    return depth
  }

  function derive(state) {
    const byId = new Map(state.nodes.map((n) => [n.id, n]))
    const reachable = reachableFromStart(state.nodes)
    return state.nodes.map((n) => {
      const isStart = n.id === 'start'
      const blocking = (n.deps || []).filter((d) => d !== 'start' && byId.get(d)?.status !== 'done')
      const wired = isStart || reachable.has(n.id)
      return {
        ...n,
        blocking,
        wired,
        ready: !isStart && n.status === 'pending' && wired && blocking.length === 0,
      }
    })
  }

  // ---------- 数一下仓库里现在有哪些 change ----------

  function countTasks(text) {
    const total = (text.match(/^[ \t]*[-*][ \t]*\[[ xX]\]/gm) || []).length
    const done = (text.match(/^[ \t]*[-*][ \t]*\[[xX]\]/gm) || []).length
    return { total, done }
  }

  // ---------- 读 openspec CLI：任务做到哪，用官方口径 ----------
  //
  // 为什么不自己数 tasks.md 了：`openspec list --json` 一项一项给
  // completedTasks / totalTasks / status（complete / in-progress / no-tasks）/
  // lastModified，跟 OpenSpec 自己的判断完全一致。以后它换目录结构，我们不用跟着改。
  //
  // 为什么留着回退：CLI 没装、不在 PATH、或者退出码不是 0 的时候，插件照旧自己数勾。
  // 宁可少一个字段，也不能让面板白屏 —— 这条纪律从 0.8 起就没变过。

  // change 名只允许这些字符。它会进命令行，所以先卡死，别让奇怪的名字跑进 cmd。
  const CHANGE_NAME_OK = /^[A-Za-z0-9._-]+$/

  // 跑一个子进程。永远 resolve，不抛：没装、超时、非 0 退出都变成结果。
  function runChild(command, argv, { cwd, timeoutMs = 30000, label = '' } = {}) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(command, argv, {
          cwd,
          windowsHide: true,
          env: { ...process.env, NO_COLOR: '1', OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1' },
        })
      } catch (error) {
        resolve({ ok: false, code: null, stdout: '', stderr: errorText(error), missing: true })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {}
        finish({
          ok: false,
          code: null,
          stdout,
          stderr: `${stderr}\n（${label || command} 超过 ${Math.round(timeoutMs / 1000)} 秒没结束，已放弃）`,
          timeout: true,
        })
      }, timeoutMs)
      child.stdout?.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', (error) =>
        finish({ ok: false, code: null, stdout, stderr: `${stderr}\n${errorText(error)}`, missing: true }),
      )
      child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }))
    })
  }

  // 跑一条 openspec 命令。
  function runOpenspec(root, args, timeoutMs = 30000) {
    const isWin = process.platform === 'win32'
    // Windows 上 npm 全局命令是 .cmd 批处理，Node 22 起 spawn 它不带 shell 会直接 EINVAL。
    // 走 cmd.exe /d /s /c 比 shell:true 干净：参数仍然一个一个传，不拼字符串。
    const command = isWin ? 'cmd.exe' : 'openspec'
    const argv = isWin ? ['/d', '/s', '/c', 'openspec', ...args] : args
    return runChild(command, argv, { cwd: root, timeoutMs, label: `openspec ${args[0] || ''}` })
  }

  // 跑一条 git 命令。git 是 .exe，不像 npm 那个 .cmd 要过 cmd.exe —— 多一道反而会把
  // 带空格的提交信息拆坏，所以这里直接 spawn。
  function runGit(root, args, timeoutMs = 30000) {
    return runChild('git', args, { cwd: root, timeoutMs, label: `git ${args[0] || ''}` })
  }

  // 缓存按工作区各存一份。两个面板各看一个仓库时，共用一份缓存会互相冲掉 ——
  // 一冲掉就得重新 spawn openspec，两个面板轮流刷新就变成每次请求都开两个子进程。
  const CACHE_TTL_MS = 3000
  const CACHE_LIMIT = 8
  const rootCaches = new Map() // runnerKey -> { cli, planning, scan }

  function cacheFor(root) {
    const key = runnerKey(root)
    let bucket = rootCaches.get(key)
    if (!bucket) {
      bucket = { cli: null, planning: null, scan: null }
      rootCaches.set(key, bucket)
      // 只留最近这几个仓库：工作区再多也不该把内存攒成无底洞。
      if (rootCaches.size > CACHE_LIMIT) {
        const oldest = rootCaches.keys().next().value
        if (oldest !== key) rootCaches.delete(oldest)
      }
    }
    return bucket
  }

  // 缓存 3 秒：面板一次刷新要读好几处，别为同一个答案开好几个子进程。
  async function cliChanges(root, force = false) {
    const cache = cacheFor(root)
    if (!force && cache.cli && Date.now() - cache.cli.at < CACHE_TTL_MS) return cache.cli.value
    const result = await runOpenspec(root, ['list', '--json'])
    let value = { ok: false, error: '', map: new Map() }
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.stdout)
        const map = new Map()
        for (const row of parsed?.changes || []) {
          const name = String(row?.name || '')
          if (!name) continue
          map.set(name, {
            done: Number(row?.completedTasks) || 0,
            total: Number(row?.totalTasks) || 0,
            status: String(row?.status || ''),
            modified: Date.parse(row?.lastModified || '') || 0,
          })
        }
        value = { ok: true, error: '', map }
      } catch (error) {
        value = { ok: false, error: `openspec list --json 的输出读不懂：${errorText(error)}`, map: new Map() }
      }
    } else {
      const detail = `${result.stderr || ''}${result.stdout || ''}`.trim().slice(0, 300)
      value = {
        ok: false,
        error: result.missing
          ? '找不到 openspec 命令（没装，或者不在 PATH 里）；任务进度改由插件自己数 tasks.md'
          : `openspec list --json 失败（退出码 ${result.code}）${detail ? `：${detail}` : ''}`,
        map: new Map(),
      }
    }
    cache.cli = { at: Date.now(), value }
    return value
  }

  // ---------- 读 openspec status：规划写到第几件了 ----------
  //
  // `list --json` 只看 tasks.md：没有它就是 no-tasks，分不清「只写了提案」和
  // 「四件套只差 tasks」。这两种差得很远 —— 前者开跑等于让对话凭空开工，
  // 后者差一步就能 apply。所以再读一条 `status --all --json`：
  // 一次调用拿全部未归档 change 的 artifacts（done / ready / blocked）、
  // isPlanningComplete 和 nextSteps（下一步该跑哪条命令，原话）。
  //
  // 同样缓存 3 秒、同样可降级：读不到就是 null，面板不显示规划进度，别的照旧。
  async function cliPlanning(root, force = false) {
    const cache = cacheFor(root)
    if (!force && cache.planning && Date.now() - cache.planning.at < CACHE_TTL_MS) return cache.planning.value
    const result = await runOpenspec(root, ['status', '--all', '--json'])
    let value = { ok: false, error: '', map: new Map() }
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.stdout)
        const map = new Map()
        for (const item of Array.isArray(parsed?.changes) ? parsed.changes : []) {
          const name = String(item?.changeName || '')
          if (!name) continue
          const artifacts = Array.isArray(item?.artifacts) ? item.artifacts : []
          map.set(name, {
            complete: Boolean(item?.isPlanningComplete),
            done: artifacts.filter((entry) => entry?.status === 'done').length,
            total: artifacts.length,
            missing: artifacts.filter((entry) => entry?.status !== 'done').map((entry) => String(entry?.id || '')),
            next: Array.isArray(item?.nextSteps) && item.nextSteps.length ? String(item.nextSteps[0]) : '',
          })
        }
        value = { ok: true, error: '', map }
      } catch (error) {
        value = { ok: false, error: `openspec status --all --json 的输出读不懂：${errorText(error)}`, map: new Map() }
      }
    } else {
      const detail = `${result.stderr || ''}${result.stdout || ''}`.trim().slice(0, 300)
      value = {
        ok: false,
        error: result.missing
          ? '找不到 openspec 命令，规划进度读不到（不影响开跑）'
          : `openspec status --all --json 失败（退出码 ${result.code}）${detail ? `：${detail}` : ''}`,
        map: new Map(),
      }
    }
    cache.planning = { at: Date.now(), value }
    return value
  }

  // 把 validate --json 里的 issues 摊成一行一条，给人看、给人复制。
  function validateIssues(stdout) {
    let parsed = null
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return []
    }
    const lines = []
    for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
      for (const issue of Array.isArray(item?.issues) ? item.issues : []) {
        const level = String(issue?.level || '').toUpperCase()
        if (!level) continue
        const where = issue?.path ? `${issue.path}：` : ''
        lines.push(`[${level}] ${where}${issue?.message || ''}`)
      }
    }
    return lines
  }

  async function scanChanges(root, force = false) {
    const cache = cacheFor(root)
    if (!force && cache.scan && Date.now() - cache.scan.at < CACHE_TTL_MS) return cache.scan.value
    const cli = await cliChanges(root, force)
    const planning = await cliPlanning(root, force)
    const dir = path.join(root, 'openspec', 'changes')
    let names = []
    let archived = 0
    const recentArchived = []
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      names = entries.filter((entry) => entry.isDirectory() && entry.name !== 'archive').map((entry) => entry.name)
    } catch {
      names = []
    }
    try {
      const entries = await readdir(path.join(dir, 'archive'), { withFileTypes: true })
      const dirs = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        archived += 1
        let modified = 0
        try {
          modified = (await stat(path.join(dir, 'archive', entry.name))).mtimeMs || 0
        } catch {}
        dirs.push({ name: entry.name, modified })
      }
      dirs.sort((a, b) => b.modified - a.modified)
      for (const row of dirs.slice(0, 5)) {
        let total = 0
        let done = 0
        try {
          const counted = countTasks(await readFile(path.join(dir, 'archive', row.name, 'tasks.md'), 'utf8'))
          total = counted.total
          done = counted.done
        } catch {}
        recentArchived.push({ name: row.name, done, total, modified: row.modified })
      }
    } catch {}

    const rows = []
    for (const name of names) {
      const base = path.join(dir, name)
      const fromCli = cli.map.get(name)
      let total = 0
      let done = 0
      let hasTasks = false
      let hasProposal = false
      let modified = 0
      if (fromCli) {
        // 官方口径优先：status 是 complete / in-progress / no-tasks。
        total = fromCli.total
        done = fromCli.done
        hasTasks = fromCli.status !== 'no-tasks'
      } else {
        try {
          const text = await readFile(path.join(base, 'tasks.md'), 'utf8')
          const counted = countTasks(text)
          total = counted.total
          done = counted.done
          hasTasks = true
        } catch {}
      }
      try {
        const info = await stat(path.join(base, 'proposal.md'))
        hasProposal = info.isFile()
      } catch {}
      try {
        modified = (await stat(base)).mtimeMs || 0
      } catch {}
      try {
        const info = await stat(path.join(base, 'tasks.md'))
        if (info.mtimeMs > modified) modified = info.mtimeMs
      } catch {}
      try {
        const info = await stat(path.join(base, 'proposal.md'))
        if (info.mtimeMs > modified) modified = info.mtimeMs
      } catch {}
      // CLI 的 lastModified 是 OpenSpec 自己的「最后动过」；和文件时间取大的那个，
      // 免得它只给了目录时间、漏掉刚改的 tasks.md。
      if (fromCli?.modified) modified = Math.max(modified, fromCli.modified)
      // 实现状态：只有提案 / 还没开工 / 做了一半 / 全做完等归档
      let stage = 'proposal'
      if (hasTasks && total > 0) {
        if (done <= 0) stage = 'todo'
        else if (done >= total) stage = 'implemented'
        else stage = 'doing'
      }
      // CLI 的 status 比我们自己数的更权威：complete 就是 complete。
      if (fromCli?.status === 'complete') stage = 'implemented'
      if (fromCli?.status === 'no-tasks') stage = 'proposal'
      // 有人在别处改它吗：只有「做了一半」才算。
      // 刚建好的 change（只有提案 / 还没勾任务）文件时间也一定是新的，
      // 但那是「刚写完」，不等于有人在推进，不能判成他处进行。
      const idle = modified ? Date.now() - modified : Number.POSITIVE_INFINITY
      const external = stage === 'doing' && idle < ACTIVE_WINDOW_MS
      rows.push({
        name,
        done,
        total,
        hasTasks,
        hasProposal,
        modified,
        stage,
        // 官方状态：complete / in-progress / no-tasks。CLI 不可用时是空字符串。
        cliStatus: fromCli?.status || '',
        // 规划写到第几件（proposal / specs / design / tasks）。读不到就是 null。
        planning: planning.map.get(name) || null,
        activeMinutes: Number.isFinite(idle) ? Math.floor(idle / 60000) : null,
        external,
        addable: stage !== 'implemented' && !external,
      })
    }
    rows.sort((a, b) => b.modified - a.modified)
    cache.scan = { at: Date.now(), value: { changes: rows, archived, recentArchived } }
    return cache.scan.value
  }

  // 单独看图上这一格：多久没动过、是不是别人正在动。
  // 只有「做了一半」（勾了一些、还没勾完）才算他处进行：
  // 刚建好提案 / 还没勾第一项的 change，文件时间也一定是新的，那只是「刚写完」。
  // 另外，我们自己拉起对话时也会改这些文件，所以「最后改动时间」跟我们最后一次写它的时间
  // 挨得近，就算自己人，不算「他处进行」。
  async function changeStage(root, change) {
    // 先问 CLI。自己数勾只是它不在了才走的退路 —— 口径跟 `openspec list` 不一致，
    // 两套结果打架了对谁都没好处。
    const cli = await cliChanges(root)
    const row = cli.map.get(change)
    if (row) {
      if (row.status === 'complete') return 'implemented'
      if (row.status === 'no-tasks') return 'proposal'
      return row.done > 0 ? 'doing' : 'todo'
    }
    try {
      const counted = countTasks(await readFile(path.join(root, 'openspec', 'changes', change, 'tasks.md'), 'utf8'))
      if (counted.total <= 0) return 'proposal'
      if (counted.done <= 0) return 'todo'
      if (counted.done >= counted.total) return 'implemented'
      return 'doing'
    } catch {
      return 'proposal'
    }
  }

  async function nodeActivity(root, node, windowMs = ACTIVE_WINDOW_MS) {
    const base = path.join(root, 'openspec', 'changes', node.change)
    let touchedAt = 0
    for (const candidate of [base, path.join(base, 'tasks.md'), path.join(base, 'proposal.md')]) {
      try {
        const info = await stat(candidate)
        if (info.mtimeMs > touchedAt) touchedAt = info.mtimeMs
      } catch {}
    }
    if (!touchedAt) return { touchedAt: 0, external: false, activeMinutes: null }
    const idle = Date.now() - touchedAt
    const activeMinutes = Math.floor(idle / 60000)
    if (idle >= windowMs) return { touchedAt, external: false, activeMinutes }
    const stage = await changeStage(root, node.change)
    if (stage !== 'doing') return { touchedAt, external: false, activeMinutes }
    const ours = Date.parse(node.updatedAt || '') || 0
    const oursNear = ours > 0 && Math.abs(touchedAt - ours) <= 90 * 1000
    const external = !oursNear && !ACTIVE.has(node.status) && !node.sessionId
    return { touchedAt, external, activeMinutes }
  }

  // 图上每一格对应的 change 现在在仓库里是什么样：还在不在、是不是已经归档、
  // 是不是有人在别处做、任务做到哪。
  async function nodeRepoState(root, nodes) {
    const cli = await cliChanges(root)
    const planning = await cliPlanning(root)
    const changesDir = path.join(root, 'openspec', 'changes')
    let archiveNames = []
    try {
      const entries = await readdir(path.join(changesDir, 'archive'), { withFileTypes: true })
      archiveNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {}

    const map = new Map()
    for (const node of nodes) {
      if (node.kind === 'start') continue
      const dir = path.join(changesDir, node.change)
      const exists = existsSync(dir)
      const archivedAs = archiveNames.find((name) => name === node.change || name.endsWith(`-${node.change}`)) || ''
      let taskDone = 0
      let taskTotal = 0
      let hasTasks = false
      let cliStatus = ''
      if (exists) {
        const fromCli = cli.map.get(node.change)
        if (fromCli) {
          taskDone = fromCli.done
          taskTotal = fromCli.total
          hasTasks = fromCli.status !== 'no-tasks'
          cliStatus = fromCli.status
        } else {
          try {
            const counted = countTasks(await readFile(path.join(dir, 'tasks.md'), 'utf8'))
            taskDone = counted.done
            taskTotal = counted.total
            hasTasks = true
          } catch {}
        }
      }
      const activity = exists ? await nodeActivity(root, node) : { external: false, activeMinutes: null }
      map.set(node.id, {
        exists,
        archived: !exists && Boolean(archivedAs),
        missing: !exists && !archivedAs,
        external: activity.external,
        activeMinutes: activity.activeMinutes,
        archivedAs,
        taskDone,
        taskTotal,
        hasTasks,
        cliStatus,
        // 图里这一格的规划进度：规划没写完的格子，开跑等于让对话凭空开工。
        planning: planning.map.get(node.change) || null,
      })
    }
    return map
  }

  // 执行标准：这一格能不能拉起来跑。三条同时成立才算达标 ——
  //   1) openspec/changes/<change>/ 还在；2) 有任务清单且至少一条任务；
  //   3) openspec status 说 isPlanningComplete 为真。
  // 判定只取 nodeRepoState 已经算好的事实：整批开跑、手动「启动」用的是同一套。
  // 第三条允许降级：读不到 openspec status（planning 为 null）就不看它 —— 那是我们这边的问题，
  // 不该让整张图停摆；前两条是文件事实，任何机器上都判得了。
  function executionGate(repo) {
    if (!repo || !repo.exists) return { ok: false, why: 'openspec/changes/ 里已经没有这个 change' }
    if (!repo.hasTasks || repo.taskTotal <= 0) return { ok: false, why: '还没有任务清单（tasks.md）' }
    if (repo.planning && repo.planning.complete === false) {
      const missing = (repo.planning.missing || []).filter(Boolean)
      return {
        ok: false,
        why: missing.length ? `规划还没写完，还差 ${missing.join('、')}` : '规划还没写完（openspec status 说 isPlanningComplete 是 false）',
      }
    }
    return { ok: true, why: '' }
  }

  // ---------- 开工提示词 ----------

  // 只有「执行 xxx Change」一句。节点上写了附加提示词就接在后面，
  // 不带提示词时这就是全部 —— 验收口径、要不要归档，都由人自己写在这里。
  function buildPrompt(node) {
    const base = `执行 ${node.change} Change`
    const extra = String(node.prompt || '').trim()
    return extra ? `${base}\n\n${extra}` : base
  }

  // 保存：只把「连线、位置、设置、增删」这些画布上的东西应用到图里；
  // 状态 / 说明 / sessionId / 批准时间 一律以服务器为准，不能被一次保存覆盖或弄丢。
  // 运行中和平时都走这里（0.12 起画布自动落盘，频率高，客户端那份状态随时可能旧一截）。
  // 这样在 N2 跑着的时候把 N3 从线上摘掉，N2 收尾后就真的不会拉 N3。
  function mergeRunningGraph(current, incoming) {
    const liveById = new Map(current.nodes.map((node) => [node.id, node]))
    const nodes = []
    for (const raw of incoming.nodes || []) {
      const next = normalizeNode(raw, nodes.length)
      const live = liveById.get(next.id)
      if (live) {
        next.kind = live.kind
        next.status = live.status
        next.note = live.note
        next.sessionId = live.sessionId
        next.updatedAt = live.updatedAt
        next.approved = live.approved || next.approved
      } else {
        // 运行中新加的格子一律从「待跑」开始，别继承草稿里的旧状态。
        next.status = 'pending'
        next.note = ''
        next.sessionId = ''
        next.updatedAt = ''
      }
      nodes.push(next)
    }
    // 正在跑的格子不能被一次保存弄丢；等它收尾再说。
    for (const live of current.nodes) {
      if (nodes.some((node) => node.id === live.id)) continue
      if (live.id === 'start' || ACTIVE.has(live.status)) nodes.push(live)
    }
    return clean({
      ...current,
      name: incoming.name || current.name,
      maxParallel: incoming.maxParallel || current.maxParallel,
      pauseAfterNode: Boolean(incoming.pauseAfterNode),
      defaultProfileId: incoming.defaultProfileId === undefined ? current.defaultProfileId : incoming.defaultProfileId,
      profiles: incoming.profiles || current.profiles,
      nodes: withStart(nodes),
    })
  }

  // ---------- 跑批 ----------

  // 等这一轮真正结束。顶层对话是普通会话：turn/end 落进日志才算完，
  // 不能只看 agent 忙不忙 —— 刚投完话的那一瞬间它还是 idle。
  // 每轮只扫新增的那一段，长对话不会越等越贵。
  async function waitForTurnEnd(session, fromSeq, signal, pollMs = 500) {
    let cursor = Math.max(0, Number(fromSeq) || 0)
    for (;;) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('已停止')
      let events = []
      try {
        events = session?.snapshotEvents?.(cursor) ?? []
      } catch {}
      const end = events.find((event) => event?.type === 'turn/end')
      if (end) return end
      if (events.length) cursor = Number(events[events.length - 1].seq || cursor) + 1
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  // 节点换模型本来会顺手把 DSH 的全局默认模型改掉；流水线不该改用户的默认。
  // selectModel 内部的保存是排队写，这里紧接着再写回旧值，同一队列里后写生效。
  async function selectModelKeepingDefault(controller, request) {
    const defaults = ctx.get?.('agentDefaultModel')
    const before = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : null
    try {
      return await controller.selectModel(request)
    } finally {
      if (before && defaults && typeof defaults.saveSelection === 'function') {
        try {
          await defaults.saveSelection(before)
        } catch {}
      }
    }
  }

  // 可中断的 sleep：点「停止」时立刻醒来，不会卡在这一秒里。
  function sleep(ms, signal) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener?.('abort', done, { once: true })
    })
  }

  // ---------- 归档后提交 ----------
  //
  // 勾了「归档后提交」的格子：change 进了 archive/ 之后，Host 自己在工作区里
  // `git add -A` + `git commit`，信息是 `openspec: <change>`，正文写 archive/<as>。
  // 不推、不挑文件、不做任何判断 —— 和「只查目录」是同一条底线。
  // 提交没成就不算完成：检查点没落下来，下一格接着写，两个 change 就再也分不开了。

  // 同一个工作区一次只提交一个：两格同时收尾时 git 的 index.lock 会打架，
  // 而且 add -A 会把对方刚写完的文件一起带上 —— 串起来至少顺序是确定的。
  const commitChains = new Map()

  function gitText(result) {
    return `${result.stdout}\n${result.stderr}`.trim() || `退出码 ${result.code}`
  }

  async function commitOnce(root, node, as) {
    const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree'], 15000)
    if (!inside.ok) return { ok: false, skipped: false, text: `这儿不是 git 仓库（${gitText(inside)}）` }
    // 分离 HEAD、正在 merge 的时候，提交出去没人找得到；也不替人做这个决定，直接不提交。
    const branch = await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'], 15000)
    if (!branch.ok) return { ok: false, skipped: false, text: 'HEAD 是分离的（不在任何分支上），没提交' }
    const merging = await runGit(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], 15000)
    if (merging.ok) return { ok: false, skipped: false, text: '仓库正在 merge，没提交' }

    const added = await runGit(root, ['add', '-A'], 120000)
    if (!added.ok) return { ok: false, skipped: false, text: `git add 失败：${gitText(added)}` }
    const staged = await runGit(root, ['diff', '--cached', '--name-only'], 30000)
    if (!staged.ok) return { ok: false, skipped: false, text: `git diff 失败：${gitText(staged)}` }
    // 没有改动不是失败：这一格本来就没改东西，检查点跟上一格一样。
    if (!staged.stdout.trim()) return { ok: true, skipped: true, text: '没有改动可提交' }

    const args = ['commit', '-m', `openspec: ${node.change}`]
    if (as) args.push('-m', `archive/${as}`)
    const committed = await runGit(root, args, 180000)
    if (!committed.ok) return { ok: false, skipped: false, text: `git commit 失败：${gitText(committed)}` }
    const head = await runGit(root, ['rev-parse', '--short', 'HEAD'], 15000)
    const sha = head.ok ? head.stdout.trim() : ''
    return { ok: true, skipped: false, sha, text: sha ? `已提交 ${sha}` : '已提交' }
  }

  function commitForNode(root, node, as) {
    const key = runnerKey(root)
    const prev = commitChains.get(key) || Promise.resolve()
    const task = prev.then(
      () => commitOnce(root, node, as),
      () => commitOnce(root, node, as),
    )
    commitChains.set(
      key,
      task.catch(() => {}),
    )
    return task
  }

  class PipelineRunner {
    constructor(root, options = {}) {
      this.root = root
      this.options = options
      this.controller = new AbortController()
      this.tasks = new Map()
      this.sessions = new Set()
      this.state = null
      this.done = false
      this.ranAny = false
      this.paused = false
      this.lastMessage = ''
      // 挂了「等你」但其实在等归档的格子：归档出现就补记完成，用户不用再点「开始」。
      this.awaitingArchive = new Set()
      // 挂了「等你」但其实在等写好的格子：不达标就不开对话，达标了自动放回待跑。
      this.awaitingReady = new Set()
      // 手动「启动」：只跑这一格和它下游那一截，池子外的格子这一轮不碰。
      this.from = String(options.from || '')
      this.pool = null
      // 人点过「停止」：这一条不许被「图又变了」自动接回去。
      this.stopped = false
      // 自然收工时还没跑完的格子。只有它还非空，才说明上一轮是被打断的、可以接。
      this.leftover = []
      // 接上一轮（不是人点「开始」）：不许把 failed / needs_human 重新打开。
      this.resume = Boolean(options.resume)
    }

    get running() {
      return !this.done
    }

    async start() {
      this.state = await loadState(this.root)
      if (this.options.maxParallel) this.state.maxParallel = Math.max(1, Number(this.options.maxParallel) || 1)
      if (this.from) {
        this.pool = reachableFrom(this.state.nodes, this.from)
        this.pool.add(this.from)
      }
      for (const node of this.state.nodes) {
        // 从某一格单独启动时不动别人的状态：别的格子这一轮没被点到。
        if (this.pool && !this.pool.has(node.id)) continue
        // 接上一轮：只把残留的「跑着」放回排队。failed / needs_human 一个都不碰 ——
        // 这不是人重新点了「开始」，是同一批接着跑。
        if (this.resume) {
          if (ACTIVE.has(node.status)) node.status = 'pending'
          continue
        }
        // 点「开始」是明确的重跑意图：上次失败 / 停在等人的格子都放回待跑，
        // 否则失败一次就永远卡死，只能手改 JSON。
        if (node.status === 'failed' || node.status === 'needs_human') node.status = 'pending'
      }
      await saveState(this.root, this.state)
      this.loop().catch((error) => {
        this.lastMessage = `流水线自己出错了：${error?.message || error}`
        this.done = true
      })
      return this
    }

    stop() {
      this.stopped = true
      this.controller.abort()
      this.done = true
      // 已经开起来的顶层对话是普通会话，不强杀；只把它正在跑的那一轮取消掉。
      const controller = ctx.get?.('sessionController')
      for (const sessionId of this.sessions) {
        try {
          controller?.cancel?.({ sessionId })
        } catch (error) {
          diag(`停止时取消 ${sessionId} 失败：${errorText(error)}`)
        }
      }
      this.sessions.clear()
      for (const task of this.tasks.values()) task.catch(() => {})
    }

    async persist() {
      await saveState(this.root, this.state)
      // 状态落盘之后再推：面板收到就会重读，读到的已经是新状态。
      pushEvent(this.root, { type: 'nodes' })
    }

    markNode(id, patch) {
      const node = this.state.nodes.find((n) => n.id === id)
      if (!node) return
      Object.assign(node, patch, { updatedAt: new Date().toISOString() })
    }

    // 「这一格完成了」只有这一个出口：先提交（勾了的话），再记 done。
    // 写在外面的 markNode 会让另一条路径悄悄漏掉提交 —— 这个功能有四条记完成的路径。
    async settleDone(node, note, as) {
      const committed = node.commit ? await commitForNode(this.root, node, as) : null
      if (committed && !committed.ok) {
        this.markNode(node.id, { status: 'needs_human', note: `${note}\n提交没成：${committed.text}` })
        await this.persist()
        return false
      }
      this.markNode(node.id, { status: 'done', note: committed ? `${note}\n${committed.text}` : note })
      await this.persist()
      return true
    }

    async loop() {
      while (!this.done && !this.controller.signal.aborted) {
        // 勾了「跑完当前这一格就停」：这一轮跑完、手上没有别的活，就收工。
        if (this.state.pauseAfterNode && this.ranAny && this.tasks.size === 0) {
          this.paused = true
          break
        }
        // 在等写好的格子：先看有没有写完的。写完的放回待跑，这一圈往下算；这一圈重算。
        if (await this.resumeAwaitingReady()) continue
        const reachable = reachableFromStart(this.state.nodes)
        const byId = new Map(this.state.nodes.map((n) => [n.id, n]))
        const inPool = (id) => !this.pool || this.pool.has(id)
        const pending = this.state.nodes.filter(
          (n) => n.status === 'pending' && n.id !== 'start' && inPool(n.id) && (this.pool || reachable.has(n.id)),
        )
        const active = this.state.nodes.filter((n) => ACTIVE.has(n.status) && inPool(n.id))
        // 手动启动的那一格直接放行：它的前置在 start-node 里已经按「跑完或已归档」验过了，
        // 再拿 done 卡它一次，按钮就白点了。它下游照旧只认 done。
        const ready = pending.filter((n) =>
          n.id === this.from
            ? true
            : (n.deps || []).every((d) => d === 'start' || byId.get(d)?.status === 'done'),
        )

        // 没有够格的、也没有在跑的：先看是不是有格子在等归档 / 等写好。
        // 等到了就补记完成 / 放回待跑、重算一轮接着跑；没等到就再等一会儿 ——
        // 不退出，用户不用再点「开始」。
        if (!ready.length && !active.length) {
          if (await this.resumeAwaitingArchive()) continue
          if (this.awaitingArchive.size || this.awaitingReady.size) {
            await sleep(WAIT_TICK_MS, this.controller.signal)
            continue
          }
          break
        }

        const slots = Math.max(1, Number(this.state.maxParallel) || 1) - this.tasks.size
        // 已经开了工的格子还会在这份 ready 里（状态要等 runNode 第一段 await 回来才写成
        // running）。按「还能开几个位置」去 slice，会一直拿到同一批已经开着的格子 ——
        // spawn 是空操作，又直接 continue，这一圈没有任何 await，整个进程会被这一个
        // 死循环占死（maxParallel ≥ 2 且当下只有一个够格时必现）。所以先滤掉在跑的。
        const idle = ready.filter((n) => !this.tasks.has(n.id))
        // 执行标准：不够格的这一圈不开，记「等你」+ 差什么，进等待名单。
        // 不能改成「收工」—— 那样就没人盯着仓库了，写完也不会自动放行。
        if (idle.length) {
          const facts = await nodeRepoState(this.root, idle)
          const held = []
          for (const node of idle) {
            const repo = facts.get(node.id)
            // 已归档 / 哪儿都找不到的交给 runNode 自己处理：它认得出来，会把状态补对
            // （归档的记完成、找不到的记失败）。这道闸只管「还没写好」。
            if (repo && (repo.archived || repo.missing)) continue
            const gate = executionGate(repo)
            if (gate.ok) continue
            this.awaitingReady.add(node.id)
            this.markNode(node.id, {
              status: 'needs_human',
              note:
                `${gate.why}。\n还没达到执行标准就不开对话：把它写完，写好后会自动接着跑（不用再点「开始」）；想现在停就点「停止」。`,
            })
            held.push(node.id)
          }
          if (held.length) {
            await this.persist()
            continue
          }
        }
        if (slots > 0 && idle.length) {
          for (const node of idle.slice(0, slots)) this.spawn(node)
          continue
        }
        if (!this.tasks.size) break
        // 有格子在等的时候，不能等到正在跑的那一格收尾才醒：一个跑十分钟的对话会把
        // 「写完十秒内自动接着跑」拖成十分钟。所以等着的同时一秒醒一次。
        const running = [...this.tasks.values()].map((p) => p.catch(() => {}))
        if (this.awaitingReady.size || this.awaitingArchive.size) {
          await Promise.race([...running, sleep(WAIT_TICK_MS, this.controller.signal)])
          continue
        }
        await Promise.race(running)
      }
      this.done = true
      const left = this.state.nodes.filter((n) => !TERMINAL.has(n.status))
      // 记下「这一轮还有谁没跑完」：图再变的时候，靠它判断要不要把这一轮接上。
      this.leftover = left.map((n) => n.id)
      if (this.paused) this.lastMessage = '按设置停在当前这一格之后；后面的没动'
      else this.lastMessage = left.length
        ? `停下：还有 ${left.map((n) => n.id).join('、')} 没跑完`
        : '这一批都处理完了'
    }

    // 等归档的格子：archive/ 里出现了就补记「完成」，让下游接着跑。
    // 返回 true 表示状态变了，该重算一轮。格子从图里删掉了才不再等；两边都找不到就判失败。
    //
    // 这里故意不看「还接不接在开工后面」：断开一根线只是画布上的一次改动，人可能下一秒就接回来。
    // 旧口径把「暂时被断开」当成「撤出图了」，等待名单当场清空、runner 立刻收工；
    // 接回来之后没有任何人在看 archive/，归档就没人认了。想提前收工，点「停止」。
    async resumeAwaitingArchive() {
      if (!this.awaitingArchive.size) return false
      let changed = false
      for (const id of [...this.awaitingArchive]) {
        const node = this.state.nodes.find((n) => n.id === id)
        if (!node) {
          this.awaitingArchive.delete(id)
          changed = true
          continue
        }
        const repo = archivedState(this.root, node.change)
        if (repo.archived) {
          this.awaitingArchive.delete(id)
          await this.settleDone(node, `归档了（archive/${repo.as}），自动接着往下跑`, repo.as)
          changed = true
        } else if (!repo.active) {
          this.awaitingArchive.delete(id)
          this.markNode(id, { status: 'failed', note: `changes/${node.change}/ 没了，archive/ 里也找不到；补好再点「开始」` })
          changed = true
        }
      }
      if (changed) await this.persist()
      return changed
    }

    // 等写好的格子：一达到执行标准就放回「待跑」，接着往下跑；
    // 等待期间被归档的直接补记完成（下游接着跑）；changes/ 和 archive/ 都找不到的记失败。
    // 返回 true 表示状态变了，该重算一轮。
    async resumeAwaitingReady() {
      if (!this.awaitingReady.size) return false
      let changed = false
      const waiting = []
      for (const id of [...this.awaitingReady]) {
        const node = this.state.nodes.find((n) => n.id === id)
        if (node) waiting.push(node)
        else {
          // 格子从图里删掉了：不再等它（图又被改回来了就重新按执行标准判）。
          this.awaitingReady.delete(id)
          changed = true
        }
      }
      if (!waiting.length) {
        if (changed) await this.persist()
        return changed
      }
      const facts = await nodeRepoState(this.root, waiting)
      for (const node of waiting) {
        const repo = facts.get(node.id)
        if (repo?.archived) {
          this.awaitingReady.delete(node.id)
          await this.settleDone(node, `等写好的时候它已经归档了（archive/${repo.archivedAs}），直接记完成`, repo.archivedAs)
          changed = true
          continue
        }
        if (repo?.missing) {
          this.awaitingReady.delete(node.id)
          this.markNode(node.id, {
            status: 'failed',
            note: `changes/${node.change}/ 没了，archive/ 里也找不到；补好再点「开始」`,
          })
          changed = true
          continue
        }
        if (!executionGate(repo).ok) continue
        this.awaitingReady.delete(node.id)
        this.markNode(node.id, { status: 'pending', note: '' })
        changed = true
      }
      if (changed) await this.persist()
      return changed
    }

    spawn(node) {
      // 同一格不会同时开两个对话：状态要等 runNode 第一段 await 回来才写成 running，
      // 而 loop 是同步重算的，中间这点缝足够再 spawn 一次。
      if (this.tasks.has(node.id)) return
      this.ranAny = true
      const task = this.runNode(node)
        .catch((error) => {
          this.markNode(node.id, { status: 'failed', note: `跑的时候出错：${error?.message || error}` })
        })
        .finally(() => {
          this.tasks.delete(node.id)
          this.persist().catch(() => {})
        })
      this.tasks.set(node.id, task)
    }

    async runNode(node) {
      const changeDir = path.join(this.root, 'openspec', 'changes', node.change)
      if (!existsSync(changeDir)) {
        // 已经归档（人或别的对话归档了）就直接算完成，别再拉对话。
        // 下游只认 done，所以这里必须把状态补上，否则整条链就停在这。
        const repo = archivedState(this.root, node.change)
        if (repo.archived) {
          await this.settleDone(node, `这一格已经归档（archive/${repo.as}）`, repo.as)
          return
        }
        this.markNode(node.id, {
          status: 'failed',
          note: `openspec/changes/${node.change} 不在，可能已经归档或名字写错了`,
        })
        await this.persist()
        return
      }

      // 有人在别处做这一格时不开工：重复做比慢更糟。
      const activity = await nodeActivity(this.root, node)
      if (activity.external) {
        this.markNode(node.id, {
          status: 'needs_human',
          note: `这个 change ${activity.activeMinutes ?? '?'} 分钟前还有改动，像是有别的对话在同时做。这一格先不动；确认那边收工后再重跑。`,
        })
        await this.persist()
        return
      }

      this.markNode(node.id, { status: 'running', note: '' })
      await this.persist()

      // 不再要求预先批准：点「开始」那一刻就是批准。这里只是兜底盖个时间戳。
      if (!node.approved) this.markNode(node.id, { approved: new Date().toISOString() })

      const controller = ctx.get?.('sessionController')
      if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
        this.markNode(node.id, {
          status: 'failed',
          note: '这台宿主的插件接口里没有 sessionController，拉不起工作区里的顶层对话。',
        })
        await this.persist()
        return
      }

      let sessionId = ''
      // 节点四样全空时用默认组合；设了一样就按节点自己的来。
      const runSettings = resolveRunSettings(this.state, node)
      try {
        // 跟 GUI 的「新建对话」走同一条路：建一个普通会话、挂到工作区。
        // 会话进左侧栏还要看左栏的排序：手动排序会把它排到分组末尾，切成「最近更新」才看得到。
        const workspace = await ensureWorkspace(this.root)
        const created = await controller.create({
          workspaceId: workspace.id,
          ...(runSettings.preset ? { agentPreset: runSettings.preset } : {}),
        })
        sessionId = String(created?.sessionId || '')
        if (!sessionId) throw new Error('宿主没有返回会话 id')
      } catch (error) {
        this.markNode(node.id, { status: 'failed', note: `拉不起对话：${error?.message || error}` })
        await this.persist()
        return
      }

      this.markNode(node.id, { sessionId })
      this.sessions.add(sessionId)
      await this.persist()

      try {
        if (runSettings.provider && runSettings.model) {
          await selectModelKeepingDefault(controller, {
            sessionId,
            provider: runSettings.provider,
            model: runSettings.model,
            ...(runSettings.effort ? { reasoningEffort: runSettings.effort } : {}),
          })
        }
      } catch (error) {
        this.sessions.delete(sessionId)
        this.markNode(node.id, { status: 'failed', note: `这个模型用不了：${error?.message || error}` })
        await this.persist()
        return
      }

      const liveAgent = ctx.get?.('agents')?.get?.(sessionId)
      const session = liveAgent?.session || ctx.get?.('sessions')?.get?.(sessionId)
      if (!session) {
        this.sessions.delete(sessionId)
        this.markNode(node.id, { status: 'failed', note: '会话建出来了，但没挂到宿主的 sessions 上，等不到它的收尾。' })
        await this.persist()
        return
      }
      const startSeq = Number(session.seq || 0)

      try {
        await controller.prompt(
          {
            sessionId,
            content: [{ type: 'text', text: buildPrompt(node) }],
            requestId: randomUUID(),
          },
          this.controller.signal,
        )
      } catch (error) {
        this.sessions.delete(sessionId)
        this.markNode(node.id, { status: 'failed', note: `话没送进去：${error?.message || error}` })
        await this.persist()
        return
      }

      let turnEnd
      try {
        turnEnd = await waitForTurnEnd(session, startSeq, this.controller.signal)
      } catch (error) {
        this.sessions.delete(sessionId)
        this.markNode(node.id, { status: 'failed', note: `这一轮没等到收尾：${error?.message || error}` })
        await this.persist()
        return
      }
      this.sessions.delete(sessionId)

      const reason = String(turnEnd?.data?.reason?.kind || '')
      if (reason && reason !== 'completed') {
        this.markNode(node.id, { status: 'failed', note: `对话没正常收尾（${reason}）` })
        await this.persist()
        return
      }

      // 归档门禁：这一轮结束了，但 change 必须真的进了 archive/ 才放行下一格。
      // 只查目录在不在 —— 不验规格、不查 tasks，归档怎么做是提示词的事。
      const repo = archivedState(this.root, node.change)
      if (!repo.archived) {
        // 还在 changes/：挂「等你」，但 runner 不退 —— 归档一出现就自动补记完成、接着跑下一格。
        if (repo.active) this.awaitingArchive.add(node.id)
        this.markNode(node.id, {
          status: 'needs_human',
          note: repo.active
            ? `对话收尾了，但 openspec/changes/${node.change}/ 还在，没归档。\n` +
              `归档之后会自动接着跑（openspec archive ${node.change} -y，或在那个对话里补上），不用再点「开始」；想现在停就点「停止」。`
            : `对话收尾了，但 changes/${node.change}/ 没了、archive/ 里也找不到（被删或改名了？）。补好之后点「开始」。`,
        })
        await this.persist()
        // 卡住的第二种情况：对话收尾了、change 还在，等人回话或补归档。
        // 有监工就投一张值班单（没开就什么也不做）。
        if (repo.active) {
          const last = lastAssistantText(session)
          await notifySupervisor(this.root, this.state, {
            kind: 'paused',
            nodeId: node.id,
            title: `${node.id} 停住了：对话收尾了，但 ${node.change} 还没归档`,
            lines: [
              `这一格：${node.id}（${node.change}），状态「等你」`,
              `它最后说的话：${last ? last.replace(/\s+/g, ' ').slice(0, 800) : '（读不到，会话可能已经不在）'}`,
              ...describeGraph(this.state),
            ],
          })
        }
        return
      }

      await this.settleDone(node, `对话跑完了，已归档（archive/${repo.as}）`, repo.as)
    }
  }

  function runnerFor(root) {
    const runner = runners.get(runnerKey(root))
    return runner && runner.running ? runner : undefined
  }

  // 图里现在有哪些格子够格开工（待跑、接在开工后面、前置全是 done）。
  function readyIds(state) {
    const byId = new Map(state.nodes.map((n) => [n.id, n]))
    const reachable = reachableFromStart(state.nodes)
    return state.nodes
      .filter(
        (n) =>
          n.id !== 'start' &&
          n.status === 'pending' &&
          reachable.has(n.id) &&
          (n.deps || []).every((dep) => dep === 'start' || byId.get(dep)?.status === 'done'),
      )
      .map((n) => n.id)
  }

  // 上一轮已经自然收工，图又变了：如果这次改动刚好把某个格子接在「跑完的格子」后面、
  // 让它够格了，就把这一轮接上（人不用再点「开始」）。
  //
  // 为什么要有这条：runner 收工之后，任何一次保存都不会再惊动它。断开再连回来这种
  // 「差半秒」的操作就会把流水线留在「该跑没人跑」的状态 —— 归档认得出来，后面不动。
  //
  // 只接「本来就该跑、现在条件满足了」的格子，三条闸门：
  //   1. 上一轮是自然收工，不是人手点的「停止」（停止会把 runner 从表里摘掉，这里根本看不到）；
  //   2. 这次保存新增了一个够格的格子，而且它至少有一个前置是 done 的真节点（不是只有「开工」）——
  //      单纯把一格草稿挂到「开工」下面，不算「接着跑」；
  //   3. failed / needs_human 一个都不碰（resume 模式不重置状态）。
  function resumeIdleRun(root, before, after) {
    const key = runnerKey(root)
    const previous = runners.get(key)
    if (!previous || previous.running || previous.stopped || previous.paused) return undefined
    if (!previous.leftover.length) return undefined
    const known = new Set(readyIds(before))
    const byId = new Map(after.nodes.map((n) => [n.id, n]))
    const fresh = readyIds(after).filter((id) => {
      if (known.has(id)) return false
      const node = byId.get(id)
      return (node.deps || []).some((dep) => dep !== 'start' && byId.get(dep)?.status === 'done')
    })
    if (!fresh.length) return undefined
    const runner = new PipelineRunner(root, {
      maxParallel: after.maxParallel,
      from: previous.from,
      resume: true,
    })
    // 先占位再 await：连着两次保存进来时，第二次看到的已经是「在跑了」。
    runners.set(key, runner)
    runner.start().catch((error) => {
      runner.lastMessage = `接上一轮失败：${error?.message || error}`
      runner.done = true
      if (runners.get(key) === runner) runners.delete(key)
    })
    return runner
  }

  // ---------- 面板推送 ----------
  //
  // 面板只在打开 / 切对话 / 点刷新时读盘，跑完一格它自己不会知道。
  // 这里补一条 Host → 面板的推送：一条 SSE 长连接。事件只说明「变了」，
  // 面板收到就静默重读一次 /state（有没保存的草稿时不会覆盖草稿）。
  //
  // 触发点只有两个，不用定时器、不轮询磁盘：
  //   1. runner 每次写状态（跑着 / 完成 / 失败 / 等你）；
  //   2. fs.watch 看到 change 被移进 archive/ —— 这就是「对话确定归档完成」。
  //
  // 连接按工作区分开：work-1 的格子跑完，只该惊动正在看 work-1 的那个面板。
  // 两个面板可以同时各看一个仓库，互不打扰。
  const streams = new Map() // res -> runnerKey

  function streamsFor(key) {
    let count = 0
    for (const value of streams.values()) if (value === key) count += 1
    return count
  }

  function pushEvent(root, event) {
    const key = runnerKey(root)
    if (!streams.size || !key) return
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const [res, value] of streams) {
      if (value !== key) continue
      try {
        res.write(line)
      } catch {
        streams.delete(res)
      }
    }
  }

  function openEventStream(req, res, root) {
    try {
      const key = runnerKey(root)
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-cache, no-transform')
      res.setHeader('connection', 'keep-alive')
      res.setHeader('x-accel-buffering', 'no')
      try {
        res.flushHeaders?.()
      } catch {}
      // retry：浏览器断线后 3 秒自己重连。
      res.write('retry: 3000\n\n')
      res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`)
      streams.set(res, key)
      diag(`面板推送连接 +1（${key}；现在 ${streams.size} 条）`)
      // 心跳用注释行，不会触发面板的 onmessage；太长没数据会被中间层当死连接掐掉。
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {}
      }, 25_000)
      const close = () => {
        clearInterval(ping)
        streams.delete(res)
        // 最后一个面板断开只退掉「面板」这一份：监工还开着就继续盯，两份都退了才真停。
        if (!streamsFor(key)) releaseArchiveWatch(root, 'panel')
      }
      req.on('close', close)
      req.on('error', close)
    } catch (error) {
      // 这条路径自己不能把异常抛给上层，否则会被当成普通 400 再写一次响应。
      diag(`打开推送连接失败：${errorText(error)}`)
      try {
        res.destroy()
      } catch {}
    }
  }

  // 归档监听只盯这两个目录：不递归、不扫全仓库。每个工作区各一份，按持有者登记：
  // 面板连接一份、开着的监工一份。谁需要谁持有，都不需要了才停 ——
  // 不能像以前那样「最后一个面板断开就停」，那会让关掉面板的整夜值守聋掉。
  const archiveWatches = new Map() // runnerKey -> { root, holders, watchers, timer, seen }

  function stopArchiveWatch(root) {
    const key = runnerKey(root)
    const watching = archiveWatches.get(key)
    if (!watching) return
    archiveWatches.delete(key)
    for (const watcher of watching.watchers.splice(0)) {
      try {
        watcher.close()
      } catch {}
    }
    if (watching.timer) clearTimeout(watching.timer)
  }

  // 退掉一份持有。没人持有了才真停监听。
  function releaseArchiveWatch(root, holder) {
    if (!root) return
    const watching = archiveWatches.get(runnerKey(root))
    if (!watching) return
    watching.holders.delete(holder)
    if (!watching.holders.size) stopArchiveWatch(root)
  }

  // 监工开着就一直持有监听。宿主重启会丢掉内存里的监听，所以读状态、开跑这些常见路径上
  // 顺手挂回来，不要求人再点一次「启用监工」。
  function holdSupervisorWatch(root, state) {
    if (normalizeSupervisor(state?.supervisor).enabled) watchArchives(root, 'supervisor')
  }

  function stopAllArchiveWatches() {
    for (const key of [...archiveWatches.keys()]) stopArchiveWatch(key)
  }

  // 连上时先同步记一次底数：本来就已归档的格子不用再提醒一遍。
  // 只用同步调用（读一次 pipeline.json + 两个目录判断），不会和后面的事件抢跑。
  function archivedNodeIds(root) {
    let nodes = []
    try {
      const parsed = JSON.parse(readFileSync(path.join(root, STATE_FILE), 'utf8'))
      nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : []
    } catch {
      return new Set()
    }
    const ids = new Set()
    for (const node of nodes) {
      if (!node || node.id === 'start' || !node.change) continue
      if (archivedState(root, node.change).archived) ids.add(String(node.id))
    }
    return ids
  }

  function watchArchives(root, holder = 'panel') {
    if (!root) return
    const key = runnerKey(root)
    const existing = archiveWatches.get(key)
    if (existing) {
      existing.holders.add(holder)
      return
    }
    const watching = { root, holders: new Set([holder]), watchers: [], timer: null, seen: archivedNodeIds(root) }
    archiveWatches.set(key, watching)
    // 递归盯 changes/：对话在里面写 proposal / tasks / specs，归档只是其中一种动静。
    // 面板要「时刻最新」，就不能只盯 archive/。非递归的平台（部分 Linux）会抛，
    // 由下面那两个目录级 watcher 兜底；重复事件交给 400ms 的合并。
    const targets = [
      { dir: path.join(root, 'openspec', 'changes'), recursive: true },
      { dir: path.join(root, 'openspec', 'changes'), recursive: false },
      { dir: path.join(root, 'openspec', 'changes', 'archive'), recursive: false },
    ]
    for (const target of targets) {
      try {
        // persistent: false —— 监听不该把进程挂住（测试里尤其明显）。
        const watcher = watch(target.dir, { persistent: false, recursive: target.recursive }, () => {
          if (watching.timer) clearTimeout(watching.timer)
          // 一次归档 / 一次写文件会连着来好几个事件，凑一下再查。
          watching.timer = setTimeout(() => {
            watching.timer = null
            reportArchives(root).catch(() => {})
            // 文件动了：面板重读一次（tasks 勾到几了、change 是不是没了，都是这里变的新鲜事）。
            pushEvent(root, { type: 'changes' })
          }, 400)
        })
        watcher.on('error', () => {})
        watching.watchers.push(watcher)
      } catch (error) {
        diag(`监听 ${target.dir} 失败（只影响面板自动刷新）：${errorText(error)}`)
      }
    }
  }

  async function reportArchives(root) {
    const watching = archiveWatches.get(runnerKey(root))
    if (!watching) return
    const state = await loadState(root, { recover: false })
    const hits = []
    for (const node of state.nodes) {
      if (node.kind === 'start' || !node.change) continue
      const repo = archivedState(root, node.change)
      if (repo.archived) hits.push({ id: node.id, change: node.change, as: repo.as })
    }
    const next = new Set(hits.map((hit) => hit.id))
    for (const hit of hits) {
      if (!watching.seen.has(hit.id)) pushEvent(root, { type: 'archived', ...hit })
    }
    watching.seen = next
    // 卡住的第一种情况：上一格归档了，但下一格没启动（这一格没记完成，或者没有 runner 接着跑）。
    // 有监工就投单；没开监工就只是面板上看得见。
    if (runnerFor(root)) return
    const stale = hits
      .map((hit) => state.nodes.find((node) => node.id === hit.id))
      .filter((node) => node && node.kind !== 'start' && node.status !== 'done')
    const ready = readyIds(state)
    if (!stale.length && !ready.length) return
    await notifySupervisor(root, state, {
      kind: 'stuck',
      nodeId: stale[0]?.id || '',
      title: stale.length
        ? `${stale.map((node) => node.id).join('、')} 已经归档了，但还没记完成`
        : '上一格归档了，下一格没启动',
      lines: [
        ...(stale.length
          ? [`已归档但没记完成：${stale.map((node) => `${node.id}（${node.change}，状态 ${node.status}）`).join('、')}`]
          : []),
        ...(ready.length ? [`够格但没开跑：${ready.join('、')}`] : []),
        ...describeGraph(state),
      ],
    })
  }

  // 对话模式（预置）只认这台机器上真有的：问宿主的 agentPresets 服务，问不到就是空名单。
  // 这里以前留了一份写死的兜底（standard / ptc / minimal / cordis / master-control），
  // 那是开发机自己的预置；别人装了这个插件，看到的全是开不起来的模式。
  // 服务自己的 list() 回裸数组，RPC 那边才包成 { presets: [...] } —— 两种都收。
  async function listPresets() {
    let raw = []
    let error = ''
    try {
      const service = ctx.get('agentPresets')
      if (!service || typeof service.list !== 'function') {
        error = '这台宿主的插件接口里没有 agentPresets，列不出对话模式。'
      } else {
        const result = await service.list()
        raw = Array.isArray(result) ? result : Array.isArray(result?.presets) ? result.presets : []
        if (!raw.length) error = '这台机器上还没有装任何对话模式。'
      }
    } catch (error_) {
      error = `读不到对话模式：${errorText(error_)}`
    }
    const presets = raw
      .filter((preset) => preset && preset.id)
      .map((preset) => ({
        id: String(preset.id),
        name: String(preset.name || preset.id),
        description: String(preset.description || ''),
        isDefault: Boolean(preset.isDefault),
        // 宿主的原话：这个预置为什么组不起来。有它就说明选了也开不了对话。
        broken: String(preset.broken || ''),
      }))
    return { presets, error: presets.length ? '' : error }
  }

  // 当前 DSH 里真实可用的运营商 / 模型。直接问 llm 服务，不维护第二份名单。
  // 一次扫描可能要问好几个适配器，所以缓存一分钟：面板只在打开/刷新时取。
  let modelsCache = { at: 0, value: [] }

  async function listModelDirectory(force = false) {
    if (!force && Date.now() - modelsCache.at < 60_000) return modelsCache.value
    const llm = ctx.get('llm')
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      // 宿刚刚启动、适配器还没挂上时，这里是空的。别缓存空结果，下一次请求要能自愈。
      return []
    }
    let providers = []
    try {
      providers = llm.listProviders() || []
    } catch (error) {
      diag(`读运营商目录失败：${errorText(error)}`)
      return []
    }
    const rows = await Promise.all(
      providers.map(async (provider) => {
        const id = String(provider?.id || '')
        let models = []
        try {
          const pending = Promise.resolve(llm.listModels(id))
          // 超时只放弃等待；原请求自己失败时也要吞掉，否则会变成 unhandled rejection。
          pending.catch(() => {})
          models = await Promise.race([
            pending,
            new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
          ])
        } catch (error) {
          diag(`读 ${id} 的模型失败：${errorText(error)}`)
          models = []
        }
        return {
          id,
          name: String(provider?.name || id),
          models: (models || []).map((model) => ({ id: String(model.id), name: String(model.name || model.id) })),
        }
      }),
    )
    const value = rows.filter((row) => row.id)
    // 只有读到东西才缓存。空目录说明适配器还没注册完，缓存它等于把面板锁死在空下拉上。
    if (value.length) modelsCache = { at: Date.now(), value }
    return value
  }

  // 某个具体模型支持哪些思考强度。适配器知道，别让我们猜。
  async function resolveModelEfforts(provider, model) {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.resolveModelInfo !== 'function' || !provider || !model) return null
    try {
      const info = await llm.resolveModelInfo(provider, model)
      return {
        efforts: (info?.reasoning?.efforts || []).map((entry) => ({
          id: String(entry.id),
          name: String(entry.name || entry.id),
        })),
        defaultEffort: String(info?.reasoning?.defaultEffort || ''),
        contextWindow: info?.context?.contextWindow ?? null,
      }
    } catch (error) {
      return { efforts: [], defaultEffort: '', contextWindow: null, error: errorText(error) }
    }
  }

  async function snapshot(root, options = {}) {
    // 这个工作区还连着推送通道，面板这一份就还在；切工作区之后由新连接自己挂上。
    if (streamsFor(runnerKey(root))) watchArchives(root, 'panel')
    // 这个进程里还有 runner 在跑时，磁盘上的 running 是「正在进行」，不是「上次中断」。
    const runner = runnerFor(root)
    const state = await loadState(root, { recover: !runner })
    holdSupervisorWatch(root, state)
    const inGraph = new Set(state.nodes.map((node) => node.change))
    let available = []
    let archived = 0
    let recentArchived = []
    try {
      // 手动刷新要的是「现在」的样子，不吃缓存；工具里的 status 走缓存就够了。
      const scanned = await scanChanges(root, Boolean(options.fresh))
      archived = scanned.archived
      recentArchived = scanned.recentArchived || []
      // 我们自己正在跑 / 已经跑过的 change，不能算「他处进行」。
      // 列表走的是另一条扫描路径，不知道图里谁在跑；这里按图上的事实盖掉。
      const ours = new Set(
        state.nodes
          .filter((node) => node.kind !== 'start' && node.change && (node.sessionId || ACTIVE.has(node.status)))
          .map((node) => node.change),
      )
      available = scanned.changes.map((row) => {
        const external = ours.has(row.name) ? false : row.external
        return {
          ...row,
          external,
          addable: row.stage !== 'implemented' && !external,
          inGraph: inGraph.has(row.name),
        }
      })
    } catch {
      available = []
    }
    const nodes = derive(state)
    try {
      const repo = await nodeRepoState(root, state.nodes)
      for (const node of nodes) Object.assign(node, repo.get(node.id) || {})
    } catch {}
    const currentWorkspace = workspaceRows().find((workspace) => normalizePath(workspace.path) === normalizePath(root))
    const presetRoster = await listPresets()
    return {
      root,
      // 这个面板的仓库是怎么来的：panel（面板自己选的）/ seat（跟着当前对话）/ default（上一次打开的）。
      rootFrom: String(options.from || ''),
      seat: options.seat
        ? {
            sessionId: options.seat.sessionId || '',
            cwd: options.seat.cwd || '',
            workspaceId: currentWorkspace?.id || '',
          }
        : null,
      state,
      nodes,
      available,
      archived,
      recentArchived,
      activeWindowMinutes: Math.round(ACTIVE_WINDOW_MS / 60000),
      addableCount: available.filter((row) => row.addable && !row.inGraph).length,
      running: Boolean(runner),
      // 这一轮在等谁：等写好（写完后自动放行）/ 等归档。面板顶栏靠它说清楚。
      waiting: {
        ready: runner ? [...runner.awaitingReady] : [],
        archive: runner ? [...runner.awaitingArchive] : [],
      },
      // 哪些工作区现在有流水线在跑：下拉框里标出来，切过去之前就知道那边在动。
      runningRoots: [...runners.values()].filter((item) => item.running).map((item) => item.root),
      workspaces: workspaceRows(),
      // 任务进度从哪来：CLI 能用就用官方口径，用不了会写明原因，面板好提示。
      // 读的是这个仓库自己的缓存（上面 scanChanges 刚填过）。
      cli: {
        ok: cacheFor(root).cli?.value.ok ?? false,
        error: cacheFor(root).cli?.value.error ?? '',
        planning: {
          ok: cacheFor(root).planning?.value.ok ?? false,
          error: cacheFor(root).planning?.value.error ?? '',
        },
      },
      // 顶层对话能力：没有 sessionController 就只能停在报错上，面板要提前说清楚。
      capabilities: {
        topLevel: (() => {
          const controller = ctx.get?.('sessionController')
          return Boolean(controller && typeof controller.create === 'function' && typeof controller.prompt === 'function')
        })(),
      },
      presets: presetRoster.presets,
      // 名单是空的就写清楚为什么空：没装、还是读不到。别让人对着空下拉猜。
      presetError: presetRoster.error,
      providers: await listModelDirectory(),
      message: runner?.lastMessage || '',
    }
  }

  function stageText(row) {
    if (row.stage === 'proposal') return row.hasProposal ? '只有提案，还没拆任务' : '还没有提案'
    if (row.stage === 'todo') return `还没开工 0/${row.total}`
    if (row.stage === 'implemented') return `任务全勾了 ${row.total}/${row.total}，等归档`
    return `实现中 ${row.done}/${row.total}`
  }

  function summarize(view) {
    const lines = [`流水线：${view.state.name}`, `仓库：${view.root}`]
    lines.push(`并行上限：${view.state.maxParallel}`)
    const defaults = defaultProfileOf(view.state)
    lines.push(`默认运行设置：${defaults ? `${defaults.name}（${[defaults.preset || '跟随当前', defaults.model || '默认模型', defaults.effort || '默认强度'].join(' / ')}）` : '没设（节点自己选）'}`)
    const all = view.available || []
    const outside = all.filter((row) => !row.inGraph)
    const addable = outside.filter((row) => row.addable)
    const implemented = outside.filter((row) => row.stage === 'implemented')
    const external = outside.filter((row) => row.external && row.stage !== 'implemented')
    lines.push(`仓库里没归档的 change：${all.length} 个；已归档 ${view.archived || 0} 个`)
    lines.push(
      `其中图外：可加入 ${addable.length} 个；已做完只差归档 ${implemented.length} 个；已在他处进行 ${external.length} 个`,
    )
    if (external.length) {
      lines.push(`已在他处进行（别重复做，先别加）：${external.map((row) => row.name).join('、')}`)
    }
    if (addable.length) {
      lines.push(`可以加进图：${addable.map((row) => `${row.name}（${stageText(row)}）`).join('、')}`)
    }
    if (!view.nodes.length) {
      lines.push('图里还没有节点。把上面这些 change 加进来就能排顺序。')
      return lines.join('\n')
    }
    const parked = view.nodes.filter((node) => node.kind !== 'start' && !node.wired)
    for (const node of view.nodes) {
      if (node.kind === 'start') {
        lines.push('- start（开工）')
        continue
      }
      const blocking = node.blocking.length ? `（等 ${node.blocking.join('、')}）` : ''
      // 四样全空的节点实际会用默认组合，这里按真正会用的那套显示，别写「跟随当前」骗人。
      const runSettings = resolveRunSettings(view.state, node)
      const settings = [runSettings.preset || '跟随当前', runSettings.model || '默认模型', runSettings.effort || '默认强度'].join(' / ')
      const wired = node.wired ? '' : '｜没接入开工，不会执行'
      const gone = node.archived
        ? `｜已归档（archive/${node.archivedAs || node.change}）`
        : node.missing
          ? '｜仓库里已找不到这个 change'
          : ''
      const elsewhere = node.external ? `｜已在他处进行（${node.activeMinutes ?? '?'} 分钟前还有改动）` : ''
      const progress = node.exists && node.hasTasks ? `｜任务 ${node.taskDone}/${node.taskTotal}` : ''
      lines.push(
        `- ${node.id} → ${node.change}｜${node.status}${blocking}${wired}${gone}${elsewhere}${progress}｜${settings}${node.prompt ? '｜有附加提示词' : ''}${node.commit ? '｜归档后提交' : ''}`,
      )
      if (node.note) lines.push(`    ${node.note.split('\n').join('\n    ')}`)
    }
    if (parked.length) {
      lines.push(`有 ${parked.length} 个节点没接到「开工」后面，这一轮不会跑：${parked.map((n) => n.id).join('、')}`)
    }
    const vanished = view.nodes.filter((node) => node.kind !== 'start' && (node.archived || node.missing))
    if (vanished.length) {
      lines.push(
        `注意：${vanished.map((n) => `${n.id}(${n.change})`).join('、')} 在 openspec/changes/ 里已经找不到了（多半是归档了）。不需要就删掉这几格。`,
      )
    }
    const elsewhere = view.nodes.filter((node) => node.kind !== 'start' && node.external)
    if (elsewhere.length) {
      lines.push(
        `注意：${elsewhere.map((n) => `${n.id}(${n.change})`).join('、')} 看起来正在别处做。流水线不会碰它们；确认那边收工后再手动处理。`,
      )
    }
    if (view.waiting?.ready?.length) {
      lines.push(`在等这 ${view.waiting.ready.length} 格写好：${view.waiting.ready.join('、')}（写好后自动接着跑，不用再点「开始」）`)
    }
    lines.push(view.running ? '正在跑。' : '没在跑。')
    if (view.message) lines.push(view.message)
    return lines.join('\n')
  }

  // ---------- 动作 ----------

  // ---------- 手动归档：先 validate，再 archive ----------
  //
  // 两步都是 openspec 自己的命令，插件不做任何判断：
  //   1) openspec validate <change> --strict --json   只读，把毛病列出来
  //   2) openspec archive  <change> -y                真的合并进主规格
  //
  // 为什么必须在这里验：归档之后 change 就不在 changes/ 里了，
  // `openspec validate` 用老名字、用带日期的新名字都只会回 "Unknown item"（0.9 实测），
  // 所以归档前这一刻是唯一能验的时机。
  //
  // 为什么用 --strict：默认档会把「scenario 只有 WHEN 没有 THEN」这种残缺当成合法，
  // 归档照样合并进主规格，而且再也洗不掉。--strict 就是把 WARNING 也当问题。
  //
  // 为什么先报告、不直接归：验证不过是「这份单子写得不够清楚」，不是「不能归档」。
  // 决定权在人手里，插件只负责把话说清楚；人点「仍然归档」才强制过。
  async function archiveNode(root, payload) {
    const runner = runnerFor(root)
    // 有 runner 时它手里的状态才是真的（磁盘可能是上一次落盘的）；没有才读盘。
    let state = runner ? runner.state : await loadState(root)
    // 面板点「归档」时会把画布一起送过来。先并进图里，再归档：
    // 0.11 的「假断开」就是这么来的 —— 人在 N2 跑着的时候把 N3 从线上摘掉，
    // 但那条改动只在画布上，归档之后 runner 用旧图把 N3 拉了起来。
    if (payload?.state) {
      const incoming = normalize(payload.state, { recover: false })
      state = mergeRunningGraph(state, incoming)
      if (runner) runner.state = state
      await saveState(root, state)
    }
    const id = String(payload?.nodeId || '')
    const node = state.nodes.find((n) => n.id === id) || null
    const change = String(node?.change || payload?.change || '').trim()
    if (!change) return { ok: false, error: '没给 change 名' }
    if (!CHANGE_NAME_OK.test(change)) {
      return { ok: false, error: `这个 change 名里有插件不认识的字符，不敢丢给 openspec：${change}` }
    }
    if (node && ACTIVE.has(node.status)) {
      return { ok: false, error: `${id} 还在跑，先点「停止」再归档` }
    }

    const where = archivedState(root, change)
    if (where.archived) {
      if (node && node.status !== 'done') {
        // 勾了提交的格子，这一步也是「记完成」，照样提交一次；没成就不写成完成。
        const committed = node.commit ? await commitForNode(root, node, where.as) : null
        node.updatedAt = new Date().toISOString()
        if (committed && !committed.ok) {
          node.status = 'needs_human'
          node.note = `这一格早就归档了（archive/${where.as}），但提交没成：${committed.text}`
        } else {
          node.status = 'done'
          node.note = `这一格早就归档了（archive/${where.as}）${committed ? `\n${committed.text}` : ''}`
        }
        await saveState(root, state)
        pushEvent(root, { type: 'nodes' })
        if (committed && !committed.ok) return { ok: false, error: node.note }
      }
      return { ok: true, text: `${change} 早就归档了（archive/${where.as}），这一格记成完成。` }
    }
    if (!where.active) {
      return { ok: false, error: `changes/${change}/ 和 archive/ 里都找不到这个 change（改名或删掉了？）` }
    }

    const checked = await runOpenspec(root, ['validate', change, '--strict', '--json', '--no-interactive'], 60000)
    const issues = validateIssues(checked.stdout)
    const passed = Boolean(checked.ok)
    const rawReport = `${checked.stdout}\n${checked.stderr}`.trim()
    const report = issues.length ? issues.join('\n') : rawReport

    if (!passed && !payload?.force) {
      return {
        ok: false,
        needsConfirm: true,
        stage: 'validate',
        text: `openspec validate --strict 没过：${change}`,
        report: report || `openspec validate 退出码 ${checked.code}`,
      }
    }

    const archived = await runOpenspec(root, ['archive', change, '-y'], 180000)
    const archiveOut = `${archived.stdout}\n${archived.stderr}`.trim()
    if (!archived.ok) {
      return {
        ok: false,
        stage: 'archive',
        error: `openspec archive 失败（退出码 ${archived.code}）`,
        report: [passed ? '' : report, archiveOut].filter(Boolean).join('\n\n'),
      }
    }

    const after = archivedState(root, change)
    let commitLine = ''
    let commitFailed = ''
    if (node) {
      // 归档已经由人点完了，提交这一步是顺手，但跟 runner 一个口径：没成就不算完成。
      const committed = node.commit ? await commitForNode(root, node, after.as || change) : null
      commitLine = committed ? committed.text : ''
      node.updatedAt = new Date().toISOString()
      if (committed && !committed.ok) {
        commitFailed = committed.text
        node.status = 'needs_human'
        node.note = `已归档（archive/${after.as || change}），但提交没成：${committed.text}`
      } else {
        node.status = 'done'
        node.note =
          `手动归档（archive/${after.as || change}）${passed ? '' : '｜validate 没过，人选择了仍然归档'}` +
          (committed ? `\n${committed.text}` : '')
      }
      // runner 正挂着「等你」这一格时，把它从等待名单里摘掉：
      // 归档已经由人点完了，不用它再补一次完成（否则说明会被改写成「自动接着往下跑」）。
      if (runner) runner.awaitingArchive.delete(id)
      await saveState(root, state)
    }
    pushEvent(root, { type: 'archived', id, change, as: after.as || '' })
    // 流水线还在跑的时候（「等你」的格子它一直在看目录），归完一秒内自己开下一格。
    // 已经停了（点过停止 / 整条链跑完了）就别偷偷重启 —— 那是「停止」该有的意思；
    // 但后面还有没有东西可跑，得当场说清楚：认得出归档、却看不出下一格在哪，一样会把人晾住。
    const idle = (() => {
      if (runnerFor(root)) return ''
      const ready = readyIds(state)
      return ready.length
        ? `\n（现在没有在跑的流水线；后面 ${ready.join('、')} 已经够格了，点「开始」接着跑）`
        : '\n（现在没有在跑的流水线，后面也没有够格的格子）'
    })()
    if (commitFailed) {
      return {
        ok: false,
        as: after.as || '',
        error:
          `已归档 ${change}，但提交没成：${commitFailed}` +
          '\n修好之后这一格停在「等你」——点「开始」会重试提交（change 已经在 archive/ 里，不会再开对话）。',
      }
    }
    return {
      ok: true,
      as: after.as || '',
      text:
        `已归档 ${change}${after.as ? `（archive/${after.as}）` : ''}` +
        (passed ? '，validate --strict 通过。' : '（validate 没过，你选择了仍然归档）。') +
        (commitLine ? `\n${commitLine}` : '') +
        (archiveOut ? `\n${archiveOut}` : '') +
        idle,
    }
  }

  // ---------- 监工（值班对话）与项目手册 ----------
  //
  // 手册跟着「这台机器 + 这个项目」走，存在插件自己的目录里：一个项目一份，面板里编辑。
  // 监工是一个普通顶层对话，插件把它的 sessionId 记在 pipeline.json 的 supervisor 里，
  // 出事时往里投一张「值班单」。它只干两件事：把停住的那一轮接着跑、把停下来问事的对话按
  // 手册回过去。它不改代码 —— 要改代码就让那个对话自己去改。

  const MANUALS_FILE = path.join(STATE_DIR, 'openspec-pipeline-manuals.json')

  async function readManuals() {
    try {
      const value = JSON.parse(await readFile(MANUALS_FILE, 'utf8'))
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  async function readManual(root) {
    const all = await readManuals()
    return String(all[runnerKey(root)] || '')
  }

  async function writeManual(root, text) {
    const all = await readManuals()
    all[runnerKey(root)] = String(text ?? '')
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(MANUALS_FILE, JSON.stringify(all, null, 2), 'utf8')
    return all[runnerKey(root)]
  }

  function normalizeSupervisor(raw) {
    return {
      enabled: Boolean(raw?.enabled),
      sessionId: String(raw?.sessionId || ''),
      preset: raw?.preset || '',
      provider: raw?.provider || '',
      model: raw?.model || '',
      effort: raw?.effort || '',
      lastAt: raw?.lastAt || '',
      lastNote: raw?.lastNote || '',
      // 上一次值班单没送出去的原因（成功投递一次就清空）。面板靠它显示卡在哪。
      lastError: raw?.lastError || '',
    }
  }

  function liveSession(sessionId) {
    if (!sessionId) return undefined
    const agent = ctx.get?.('agents')?.get?.(sessionId)
    return agent?.session || ctx.get?.('sessions')?.get?.(sessionId)
  }

  // 值班单：同一格同一类事 2 分钟内只打扰一次；不同格各发各的。
  const supervisorSeen = new Map() // root -> Map(key -> 时间)

  function supervisorPrompt(root, state, event) {
    const lines = []
    lines.push(`[流水线值班] ${event.title}`)
    lines.push(`仓库：${root}`)
    for (const item of event.lines || []) lines.push(`- ${item}`)
    lines.push('')
    lines.push(`手册（这个项目一份，按它办）：`)
    lines.push(event.manual?.trim() || '（还没有写手册。只做最小的事：能接着跑就 run；对话停住了就按它最后说的话回一句。）')
    lines.push('')
    lines.push('你能用的动作（openspec_pipeline，root 用上面这个）：')
    lines.push('- status：看图和进度')
    lines.push('- run：把停住的这一轮接着跑（上一格已归档、下一格没启动时用它）')
    lines.push('- tell { nodeId, text, wait }：给那一格的对话说一句话；wait=true 会把它回的话带回来')
    lines.push('- archive { nodeId }：那一格其实已经做完、只差归档时用它')
    lines.push('')
    lines.push('规矩：不改代码（要改就让那个对话去改）；不碰正在跑的格子；不重启用户点过「停止」的流水线。')
    lines.push('处理完用一句话说明你做了什么；没事就回「这次不用动手」。')
    return lines.join('\n')
  }

  async function notifySupervisor(root, state, event) {
    const supervisor = normalizeSupervisor(state?.supervisor)
    if (!supervisor.enabled || !supervisor.sessionId) return
    const key = `${event.kind}:${event.nodeId || ''}`
    let seen = supervisorSeen.get(runnerKey(root))
    if (!seen) {
      seen = new Map()
      supervisorSeen.set(runnerKey(root), seen)
    }
    const now = Date.now()
    if (now - (seen.get(key) || 0) < 120_000) return
    seen.set(key, now)
    const session = liveSession(supervisor.sessionId)
    if (!session) return
    const controller = ctx.get?.('sessionController')
    if (!controller?.prompt) return
    try {
      const manual = await readManual(root)
      await controller.prompt(
        {
          sessionId: supervisor.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: supervisorPrompt(root, state, { ...event, manual }) }],
          requestId: randomUUID(),
        },
        // 宿主第一行就查取消信号，所以必须传；30 秒只约束这一次投递的返回，不影响已经在跑的对话。
        AbortSignal.timeout(30_000),
      )
      state.supervisor.lastAt = new Date().toISOString()
      state.supervisor.lastNote = event.title
      state.supervisor.lastError = ''
      await saveState(root, state)
      pushEvent(root, { type: 'nodes' })
    } catch (error) {
      // 送不出去不能只留一行诊断日志：写进状态、推一次刷新，面板上看得见。
      // 只在成功投递一次之后清掉 —— 在没人下一次值班之前，这条失败仍然是事实。
      state.supervisor.lastError = errorText(error)
      await saveState(root, state)
      pushEvent(root, { type: 'nodes' })
      diag(`给监工投值班单失败：${errorText(error)}`)
    }
  }

  // 从会话事件里读最后一段助手说的话（监工要知道那一格在问什么）。
  function lastAssistantText(session, fromSeq = 0) {
    let texts = []
    try {
      for (const event of session?.snapshotEvents?.(Math.max(0, Number(fromSeq) || 0)) || []) {
        if (event?.type !== 'assistant/message') continue
        const content = event?.data?.message?.content
        if (!Array.isArray(content)) continue
        const line = content
          .filter((block) => block?.type === 'text')
          .map((block) => String(block.text || ''))
          .join('\n')
          .trim()
        if (line) texts.push(line)
      }
    } catch {}
    return texts.length ? texts[texts.length - 1].slice(0, 4000) : ''
  }

  // 给值班单补一句「图现在什么样」：监工不用自己再跑一遍 status 也能判断。
  function describeGraph(state) {
    const rows = state.nodes.filter((n) => n.kind !== 'start')
    const counts = new Map()
    for (const row of rows) counts.set(row.status, (counts.get(row.status) || 0) + 1)
    const ready = readyIds(state)
    return [
      `图：${rows.length} 格（${[...counts.entries()].map(([key, value]) => `${key} ${value}`).join('，')}）`,
      ready.length ? `现在够格、还没开跑：${ready.join('、')}` : '现在没有够格待跑的格子',
    ]
  }

  // ---------- 按顺序接线：Agent 画图的入口 ----------
  //
  // 和人拖线走同一条落盘路径（mergeRunningGraph）：图以画布为准（节点、线、位置、
  // 四样设置、提示词），事实以宿主为准（状态、开工时间、sessionId、归档后提交的结果）。
  // 所以跑着的时候也能调，只影响还没开工的格子，效果和手拖一条线一样。
  //
  // 三条硬规矩（和 plan 的区别全在这里）：
  //   1. 只碰它点名的格子；图里别的格子一根手指都不动（plan 是整张重写，状态会归零）。
  //   2. 已有格子的线默认不动，除非 rewire=true —— 人手断开的地方不能被下一次画图偷偷接回去。
  //   3. 不删格子。删是人的动作（右键），agent 只加和接。
  //
  // 三种写法三选一：order 串行 / stages 串并（每组同时起跑）/ steps 任意依赖。
  // 上游一律写 change 名，不写节点 id —— 写错了整单拒绝，不会画出一张「看起来对、
  // 其实跑不动」的图。

  // 逐格设置只认这六项。状态、开工时间、sessionId、说明不在名单里：它们不是画布上的东西。
  const WIRE_SETTING_KEYS = ['prompt', 'preset', 'provider', 'model', 'effort', 'commit']

  function wireName(value) {
    const name = String(value || '').trim()
    if (!name) throw new Error('有个格子没写 change 名')
    if (!CHANGE_NAME_OK.test(name)) throw new Error(`这个 change 名里有插件不认识的字符，不敢写进图里：${name}`)
    return name
  }

  // 三种写法归一成同一份「change → 等谁（change 名）」。
  function wireIntents(payload) {
    const forms = ['order', 'stages', 'steps'].filter((key) => payload?.[key] !== undefined)
    if (forms.length !== 1) {
      throw new Error(
        forms.length
          ? `order / stages / steps 只能给一个，这次给了 ${forms.length} 个（${forms.join('、')}）`
          : '没给顺序：order（串行）、stages（串并）、steps（任意依赖）里要选一个',
      )
    }
    const intents = []
    const add = (change, after) => intents.push({ change: wireName(change), after: (after || []).map(wireName) })

    if (forms[0] === 'order') {
      const list = Array.isArray(payload.order) ? payload.order : []
      if (!list.length) throw new Error('order 是空的')
      list.forEach((change, index) => add(change, index ? [list[index - 1]] : ['start']))
    } else if (forms[0] === 'stages') {
      const stages = Array.isArray(payload.stages) ? payload.stages : []
      if (!stages.length) throw new Error('stages 是空的')
      stages.forEach((stage, index) => {
        if (!Array.isArray(stage) || !stage.length) throw new Error(`第 ${index + 1} 组是空的`)
        // 下一组等上一组全部跑完（栅栏），这样「并联」只发生在组内。
        const upstream = index ? stages[index - 1] : ['start']
        for (const change of stage) add(change, upstream)
      })
    } else {
      const steps = Array.isArray(payload.steps) ? payload.steps : []
      if (!steps.length) throw new Error('steps 是空的')
      for (const step of steps) {
        const change = typeof step === 'string' ? step : step?.change
        const after = typeof step === 'string' ? null : step?.after
        // after 不写 = 接在「开工」后面。要并列就几个格子都写同一条上游。
        add(change, Array.isArray(after) && after.length ? after : ['start'])
      }
    }

    const seen = new Set()
    for (const intent of intents) {
      if (seen.has(intent.change)) throw new Error(`${intent.change} 在这张单子里出现了两次`)
      seen.add(intent.change)
    }
    return intents
  }

  // 成环就整单拒绝。plan 不查这个：一条线接反了，前半段跑完就收工、后半段永远待跑，
  // 你会以为整批都做完了。
  function findCycle(nodes) {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const mark = new Map()
    const stack = []
    const walk = (id) => {
      const state = mark.get(id)
      if (state === 2) return null
      if (state === 1) return [...stack.slice(stack.indexOf(id)), id]
      const node = byId.get(id)
      if (!node) return null
      mark.set(id, 1)
      stack.push(id)
      for (const dep of node.deps || []) {
        if (dep === 'start') continue
        const hit = walk(dep)
        if (hit) return hit
      }
      stack.pop()
      mark.set(id, 2)
      return null
    }
    for (const node of nodes) {
      if (node.kind === 'start') continue
      const hit = walk(node.id)
      if (hit) return hit
    }
    return null
  }

  const depKey = (deps) => [...new Set(deps || [])].filter((dep) => dep !== 'start').sort().join('|')

  function wireGraph(root, state, payload) {
    const intents = wireIntents(payload)
    const byChange = new Map()
    for (const node of state.nodes) {
      if (node.kind === 'start' || !node.change) continue
      if (!byChange.has(node.change)) byChange.set(node.change, node)
    }
    const byId = new Map(state.nodes.map((node) => [node.id, node]))

    // 1) 名字必须真的在仓库里。写错一个字就整单拒绝 —— 否则会画出一格永远不跑的格子，
    //    跑完了你还以为这一批做完了。
    //    只在 archive/ 里不是错，是「已经跑完了」：跳过这一格、照常接其余的，
    //    但回话里必须列出来，否则人会以为整批都接好了。上游写它时当成「已经满足」吃掉 ——
    //    那条等待确实已经完成了，不该因为一个跑完的成员整单失败。
    const whereOf = (change) => archivedState(root, change)
    const isArchived = (change) => {
      if (change === 'start') return false
      const where = whereOf(change)
      return !where.active && where.archived
    }
    const missing = intents
      .map((intent) => intent.change)
      .filter((change) => {
        const where = whereOf(change)
        return !where.active && !where.archived
      })
    if (missing.length) {
      throw new Error(
        `仓库里找不到这些 change（changes/ 和 archive/ 都没有）：${missing.join('、')}。改对名字再来，或者先把 proposal 写好。`,
      )
    }
    const skipped = intents.map((intent) => intent.change).filter(isArchived)
    const kept = intents.filter((intent) => !skipped.includes(intent.change))

    // 2) 每一格用哪个 id：图里已有的沿用它的 id，没有的拿 change 名当 id。
    const idOf = new Map()
    const taken = new Set(state.nodes.map((node) => node.id))
    for (const intent of kept) {
      const live = byChange.get(intent.change)
      if (live) {
        idOf.set(intent.change, live.id)
        continue
      }
      let id = intent.change
      let suffix = 2
      while (taken.has(id)) id = `${intent.change}-${suffix++}`
      taken.add(id)
      idOf.set(intent.change, id)
    }

    // 3) 上游写成 change 名，这里换成 id。也允许指向这次没点名的、图里已经有的格子。
    //    已经归档、图里又没有这一格的：这条等待已经满足了，当成只等「开工」——
    //    既不整单拒绝（一批里只有一个已归档的上游，不该让整张图都画不出来），
    //    也不把下游扔在画布外（那样它永远不会跑）。
    //    图里有这一格就照常接（归档了还没收尾的格子仍然在图上，接回它才是对的）。
    const idFor = (name) => {
      if (name === 'start') return 'start'
      if (idOf.has(name)) return idOf.get(name)
      if (byChange.has(name)) return byChange.get(name).id
      if (byId.has(name)) return byId.get(name).id
      const where = archivedState(root, name)
      if (!where.active && where.archived) return 'start'
      throw new Error(`「等 ${name}」这条对不上：图里没有这一格，这次也没点名它`)
    }

    // 4) 逐格落位：只加和接线，不删。
    const nodes = state.nodes.map((node) => ({ ...node }))
    const slot = new Map(nodes.map((node, index) => [node.id, index]))
    const seeded = recipeOfProfile(defaultProfileOf(state))
    const added = []
    const relinked = []
    const frozen = []
    const heldBack = []
    for (const intent of kept) {
      const id = idOf.get(intent.change)
      const deps = [...new Set(intent.after.map(idFor))].filter((dep) => dep && dep !== id)
      const live = byId.get(id)
      if (live) {
        // 已经跑完 / 正在跑的格子：线不动。它们的事实已经发生了，
        // 改线不会让它重跑，只会让画布和事实对不上。
        // 只有当这次「本来想改」的时候才提一句，免得同样的单子重画一遍刷出无用的提醒。
        if (ACTIVE.has(live.status) || live.status === 'done') {
          if (depKey(live.deps) !== depKey(deps)) frozen.push(id)
          continue
        }
        const same = depKey(live.deps) === depKey(deps)
        if (payload.rewire) {
          nodes[slot.get(id)] = { ...nodes[slot.get(id)], deps }
          if (!same) relinked.push(id)
        } else if (!same) {
          // 人手改过的线要赢。没让重排就只记一笔，等它自己说 rewire。
          heldBack.push(id)
        }
        continue
      }
      const node = normalizeNode({ id, change: intent.change, deps, ...seeded }, nodes.length)
      node.status = 'pending'
      nodes.push(node)
      slot.set(id, nodes.length - 1)
      added.push(id)
    }

    // 5) 逐格设置：只认六项，不写就不动。状态、开工时间、sessionId 一概碰不到。
    const tuned = []
    const frozenSettings = []
    for (const row of Array.isArray(payload.settings) ? payload.settings : []) {
      const change = wireName(row?.change ?? row?.id)
      const id = idOf.get(change) || byChange.get(change)?.id || (byId.has(change) ? change : '')
      // 这一格这次被跳过了（已经归档），设置自然无处可落 —— 跳过，不算错。
      if (!id && isArchived(change)) continue
      if (!id || !slot.has(id)) throw new Error(`设置指向的格子不在图里：${change}`)
      const node = nodes[slot.get(id)]
      // 跑完了 / 正在跑的格子，提示词和模型也不动：改了它也不会再跑，
      // 只会把「这一格当时被告知了什么」这条记录改掉。
      if (ACTIVE.has(node.status) || node.status === 'done') {
        frozenSettings.push(id)
        continue
      }
      for (const key of WIRE_SETTING_KEYS) {
        if (row[key] === undefined) continue
        node[key] = key === 'commit' ? Boolean(row[key]) : String(row[key])
      }
      if (!tuned.includes(id)) tuned.push(id)
    }

    const cycle = findCycle(nodes)
    if (cycle) throw new Error(`这样接会成环：${cycle.join(' → ')}。断开其中一条线再来。`)

    // 6) 画完的图长什么样：批次（按从「开工」算的层）、每格等谁、有没有野格子。
    const depth = depthsFromStart(nodes)
    const batches = new Map()
    for (const intent of kept) {
      const id = idOf.get(intent.change)
      const level = depth.get(id) ?? -1
      if (!batches.has(level)) batches.set(level, [])
      batches.get(level).push(id)
    }
    const reachable = reachableFromStart(nodes)
    const parked = kept.map((intent) => idOf.get(intent.change)).filter((id) => !reachable.has(id))

    const lines = []
    // 回话里一律写 change 名（调用方就是用名字说话的），节点 id 只在画布上看。
    const changeOf = new Map(nodes.map((node) => [node.id, node.change]))
    const labelOf = (id) => changeOf.get(id) || id
    const parts = [
      added.length ? `新增 ${added.length} 格（${added.map(labelOf).join('、')}）` : '',
      relinked.length ? `重排 ${relinked.length} 条线（${relinked.map(labelOf).join('、')}）` : '',
    ].filter(Boolean)
    lines.push(parts.length ? `${parts.join('，')}。` : '这次没有新增格子。')
    // 跳过的必须列出来：不然人会以为整批都接好了。
    if (skipped.length) {
      lines.push(`跳过 ${skipped.length} 格（已经归档，没加回图里）：${skipped.join('、')}。`)
    }
    lines.push('执行顺序（只算这次点到的格子）：')
    for (const level of [...batches.keys()].sort((a, b) => a - b)) {
      const ids = batches.get(level)
      if (level < 0) {
        lines.push(`  没接入开工（不会跑）：${ids.map(labelOf).join('、')}`)
        continue
      }
      lines.push(`  第 ${level} 批：${ids.map(labelOf).join('、')}${ids.length > 1 ? '  ← 并列' : ''}`)
    }
    // 写「图里实际的线」，不是「这次想接的线」：人手断开后又被 hold 住的那几格，
    // 这里必须如实写「没接线」，否则回话会和画布说的不是一回事。
    const actualDeps = new Map(nodes.map((node) => [node.id, node.deps || []]))
    lines.push('每格等谁：')
    for (const intent of kept) {
      const deps = actualDeps.get(idOf.get(intent.change)) || []
      const after = deps.length ? deps.map((dep) => (dep === 'start' ? '开工' : labelOf(dep))).join('、') : '没接线'
      lines.push(`  ${intent.change} → ${after}`)
    }
    if (heldBack.length) {
      lines.push(`已有线没动（${heldBack.map(labelOf).join('、')}）：没人说重排，就不动它。要按新顺序重排加 rewire: true。`)
    }
    if (frozen.length) lines.push(`跑完了或正在跑，线没动：${frozen.map(labelOf).join('、')}。`)
    if (frozenSettings.length) lines.push(`跑完了或正在跑，设置没动：${frozenSettings.map(labelOf).join('、')}。`)
    if (tuned.length) lines.push(`改了设置（提示词/模型这些）：${tuned.map(labelOf).join('、')}。`)
    const widest = Math.max(0, ...[...batches.entries()].filter(([level]) => level > 0).map(([, ids]) => ids.length))
    if (widest > 1) {
      // 这次带了 maxParallel 就按新的算，否则按图里现在的。
      const parallel = payload.maxParallel ? Math.max(1, Number(payload.maxParallel) || 1) : state.maxParallel
      lines.push(`有 ${widest} 格并列。真要同时跑，maxParallel 得 ≥ ${widest}；现在是 ${parallel}，会一个接一个跑。`)
    }
    if (parked.length) lines.push(`注意：${parked.join('、')} 没接到「开工」，这一轮不会跑。`)
    return { nodes, text: lines.join('\n') }
  }

  async function applyAction(root, action) {
    // 这个进程里还有 runner 在跑时，磁盘上的 running 是「正在进行」，不是「上次中断」。
    // 读错一次就会把还活着的格子写成 failed，所以照 snapshot 的口径来。
    const state = await loadState(root, { recover: !runnerFor(root) })

    if (action.action === 'status') {
      return summarize(await snapshot(root))
    }

    if (action.action === 'plan') {
      if (runnerFor(root)) throw new Error('正在跑，先把这一批停掉再改图')
      // 名字必须真的还在 changes/ 里。声明「整张图就是这些」的时候写错一个名字，
      // 你会以为这一批包含它；已归档的、哪儿都找不到的，一律整单拒绝、一个字节都不写。
      const bad = []
      for (const raw of Array.isArray(action.nodes) ? action.nodes : []) {
        if (raw?.kind === 'start' || String(raw?.id ?? '').trim() === 'start') continue
        const change = String(raw?.change ?? raw?.id ?? '').trim()
        if (!change) continue
        const where = archivedState(root, change)
        if (where.active) continue
        bad.push(`${change}（${where.archived ? `已经归档：archive/${where.as}` : 'changes/ 和 archive/ 里都找不到'}）`)
      }
      if (bad.length) throw new Error(`这几格不能画进图里：${bad.join('、')}。一个字节都没写。`)
      state.nodes = withStart((action.nodes || []).map(normalizeNode))
      if (action.name) state.name = String(action.name)
      if (action.maxParallel) state.maxParallel = Math.max(1, Number(action.maxParallel) || 1)
      if (action.defaultProfileId !== undefined) state.defaultProfileId = String(action.defaultProfileId || '')
      await saveState(root, state)
      return summarize(await snapshot(root))
    }

    if (action.action === 'wire') {
      const runner = runnerFor(root)
      // 跑着的时候 runner 手里那份才是真的（磁盘可能落后一拍）。
      const current = (runner && runner.state) || state
      const plan = wireGraph(root, current, action)
      if (action.dryRun) return `${plan.text}\n（dryRun：只算了一遍，什么都没写。）`
      const merged = mergeRunningGraph(current, {
        ...current,
        maxParallel: action.maxParallel ? Math.max(1, Number(action.maxParallel) || 1) : current.maxParallel,
        nodes: plan.nodes,
      })
      // 跑着的时候也要立刻生效：换掉 runner 手里那份；单格「启动」的可跑范围跟着重算，
      // 这样在跑着的时候补一格下游，它也能接着跑，不用重开一轮。
      if (runner) {
        runner.state = merged
        if (runner.pool && runner.from) {
          runner.pool = reachableFrom(merged.nodes, runner.from)
          runner.pool.add(runner.from)
        }
      }
      await saveState(root, merged)
      pushEvent(root, { type: 'nodes' })
      return `${plan.text}\n${summarize(await snapshot(root))}`
    }

    if (action.action === 'update') {
      if (runnerFor(root)) throw new Error('正在跑，先停再改')
      const id = String(action.nodeId || action.node?.id || '')
      const index = state.nodes.findIndex((n) => n.id === id)
      if (index < 0) throw new Error(`图里没有 ${id}`)
      const patch = { ...action.node }
      delete patch.id
      state.nodes[index] = normalizeNode({ ...state.nodes[index], ...patch }, index)
      // 改依赖时顺手去掉指向不存在的节点
      const ids = new Set(state.nodes.map((n) => n.id))
      for (const node of state.nodes) node.deps = node.deps.filter((d) => ids.has(d))
      await saveState(root, state)
      return summarize(await snapshot(root))
    }

    if (action.action === 'add-all') {
      if (runnerFor(root)) throw new Error('正在跑，先停再加')
      const scanned = await scanChanges(root, true)
      const known = new Set(state.nodes.map((n) => n.change).filter(Boolean))
      // 只加「没做完、也没人在别处做」的。做完的只差归档，别人正在做的别重复做。
      const missing = scanned.changes.filter((row) => !known.has(row.name) && row.addable)
      const skipped = scanned.changes.filter((row) => !known.has(row.name) && !row.addable)
      if (!missing.length) {
        const why = skipped.length
          ? `图外的 change 都不是「没做完且没人在做」：${skipped.map((row) => `${row.name}（${row.stage === 'implemented' ? '已完成待归档' : '他处进行中'}）`).join('、')}`
          : '图外没有可加的 change。'
        return `${why}\n${summarize(await snapshot(root))}`
      }

      const added = []
      const seeded = recipeOfProfile(defaultProfileOf(state))
      for (const row of missing) {
        const ids = new Set(state.nodes.map((n) => n.id))
        let id = row.name.length <= 3 ? row.name : `N${state.nodes.length}`
        while (ids.has(id)) id = `${id}2`
        // 新加进来的一律先摆在画布上（不接线），由人拖到「开工」后面才进工作链。
        // 默认组合在这里就抄进节点，面板上能直接看见它以后会用哪套设置。
        state.nodes.push(normalizeNode({ id, change: row.name, deps: [], ...seeded }, state.nodes.length))
        added.push(id)
      }
      state.nodes = withStart(state.nodes)
      await saveState(root, state)
      const skipNote = skipped.length
        ? `\n没加 ${skipped.length} 个：${skipped.map((row) => `${row.name}（${row.stage === 'implemented' ? '已完成待归档' : '他处进行中'}）`).join('、')}。`
        : ''
      return `加了 ${added.length} 个：${added.join('、')}，先摆在画布上，没接进工作链。${skipNote}\n${summarize(await snapshot(root))}`
    }

    if (action.action === 'remove') {
      if (runnerFor(root)) throw new Error('正在跑，先停再删')
      const id = String(action.nodeId || '')
      if (id === 'start') throw new Error('「开工」节点删不掉；把连到它的线去掉，那一格就不跑了')
      state.nodes = state.nodes.filter((n) => n.id !== id)
      for (const node of state.nodes) node.deps = node.deps.filter((d) => d !== id)
      await saveState(root, state)
      return summarize(await snapshot(root))
    }

    // 一键清理：只删「永远不可能再执行」的两类格子 —— change 已经进了 archive/，
    // 或者 changes/ 和 archive/ 里都找不到。正在跑、挂在「等你」、还没写好、只差归档的
    // 格子不在这里面（它们的 change 还在 changes/），所以范围由仓库事实决定，不由人挑。
    // 运行中也允许：删的都是终态格子；仍然显式挡一次 ACTIVE，免得以后有人放宽范围。
    if (action.action === 'prune') {
      const runner = runnerFor(root)
      let current = runner ? runner.state : state
      // 面板点「清理」时会把画布一起送过来（和归档同一条兜底）：写盘刚好失败，
      // 也不能让 Host 拿旧图去判哪几格能删。
      if (action.state) {
        current = mergeRunningGraph(current, normalize(action.state, { recover: false }))
        if (runner) runner.state = current
        await saveState(root, current)
      }
      const facts = await nodeRepoState(root, current.nodes)
      const doomed = []
      for (const node of current.nodes) {
        if (node.kind === 'start' || ACTIVE.has(node.status)) continue
        const repo = facts.get(node.id)
        if (repo?.archived) doomed.push({ node, why: `已经归档（archive/${repo.archivedAs}）` })
        else if (repo?.missing) doomed.push({ node, why: 'changes/ 和 archive/ 里都找不到' })
      }
      if (!doomed.length) return '没有可清理的格子：图里没有已归档、也没有仓库里找不到的格子。'
      const listed = doomed.map(({ node, why }) => `${node.id}（${node.change}）：${why}`)
      if (action.dryRun) {
        return `可以清理 ${doomed.length} 格：\n${listed.map((line) => `  ${line}`).join('\n')}\n（dryRun：只算了一遍，什么都没写。）`
      }
      const ids = new Set(doomed.map(({ node }) => node.id))
      const next = {
        ...current,
        nodes: current.nodes
          .filter((node) => !ids.has(node.id))
          .map((node) => ({ ...node, deps: (node.deps || []).filter((dep) => !ids.has(dep)) })),
      }
      if (runner) runner.state = next
      await saveState(root, next)
      pushEvent(root, { type: 'nodes' })
      return `清理了 ${doomed.length} 格：\n${listed.map((line) => `  ${line}`).join('\n')}\n下游指向它们的线也一起摘掉了。\n${summarize(await snapshot(root))}`
    }

    if (action.action === 'run') {
      if (runnerFor(root)) throw new Error('已经在跑了')
      const reachable = reachableFromStart(state.nodes)
      const runnable = state.nodes.filter((node) => node.id !== 'start' && reachable.has(node.id))
      if (!runnable.length) throw new Error('图里没有接到「开工」后面的节点，没法开跑')
      // 不在这里盖批准时间：点「开始」只是放行，哪一格真正开工由 runner 记哪一格的时间。
      const runner = new PipelineRunner(root, { maxParallel: action.maxParallel })
      runners.set(runnerKey(root), runner)
      await runner.start()
      const parked = state.nodes.filter((node) => node.id !== 'start' && !reachable.has(node.id))
      const note = parked.length ? `另有 ${parked.length} 个没接入开工，这一轮不动。` : ''
      return `开跑了。${note}\n${summarize(await snapshot(root))}`
    }

    // 手动「启动」一格里：只跑这一格，它归档之后下游自动接着跑。
    // 前置按「跑完或已归档」算 —— 上游归档了就先放行，不必等它那一轮收尾。
    if (action.action === 'start-node') {
      if (runnerFor(root)) throw new Error('这个仓库已经有一条流水线在跑；等它收尾，或者先点「停止」')
      const id = String(action.nodeId || '')
      const node = state.nodes.find((n) => n.id === id)
      if (!node) throw new Error(`图里没有这一格：${id || '（没给 id）'}`)
      if (node.id === 'start') throw new Error('「开工」是整批的起点，不能单独启动')
      if (node.status === 'running') throw new Error(`${id} 已经在跑了`)
      const where = archivedState(root, node.change)
      if (!where.active) {
        if (where.archived && node.status === 'done') {
          throw new Error(`${id} 已经归档了（archive/${where.as}），没得可跑`)
        }
        if (!where.archived) {
          throw new Error(`openspec/changes/${node.change}/ 不在，archive/ 里也找不到；补好再启动`)
        }
      }
      // 执行标准：和整批开跑同一把尺子。人指着这一格说「就它」，等下去没有别的活，
      // 所以直接拒绝并把差什么写清楚，不拉起一条只会空等的流水线。
      const gate = executionGate((await nodeRepoState(root, [node])).get(node.id))
      if (!gate.ok) {
        throw new Error(`${id}（${node.change}）还没达到执行标准：${gate.why}。先把它写完再启动`)
      }
      const byId = new Map(state.nodes.map((n) => [n.id, n]))
      const blockers = (node.deps || []).filter((dep) => !depSettled(root, byId, dep))
      if (blockers.length) {
        throw new Error(`前置还没跑完也没归档：${blockers.join('、')}；等它们归档，或者先启动它们`)
      }
      const runner = new PipelineRunner(root, { from: id })
      runners.set(runnerKey(root), runner)
      await runner.start()
      return `从 ${id}（${node.change}）这一格单独开跑；它归档之后，下游自动接着跑。\n${summarize(await snapshot(root))}`
    }

    if (action.action === 'stop') {
      const runner = runnerFor(root)
      if (!runner) return '没在跑。'
      runner.stop()
      runners.delete(runnerKey(root))
      return '已停：这一格已经拉起的对话不会强杀，但后面的不会开工。'
    }

    // ---------- 监工 ----------
    if (action.action === 'supervisor') {
      state.supervisor = normalizeSupervisor(state.supervisor)
      const enabled = action.enabled === undefined ? true : Boolean(action.enabled)
      if (!enabled) {
        state.supervisor.enabled = false
        releaseArchiveWatch(root, 'supervisor')
        await saveState(root, state)
        return '监工停用了：那个对话还在，只是不再自动收值班单。'
      }
      const controller = ctx.get?.('sessionController')
      if (!controller?.create || !controller?.prompt) {
        throw new Error('这台宿主没有 sessionController，拉不起监工对话')
      }
      for (const key of ['preset', 'provider', 'model', 'effort']) {
        if (action[key] !== undefined) state.supervisor[key] = String(action[key] || '')
      }
      const alive = liveSession(state.supervisor.sessionId)
      if (!alive) {
        const workspace = await ensureWorkspace(root)
        const created = await controller.create({
          workspaceId: workspace.id,
          ...(state.supervisor.preset ? { agentPreset: state.supervisor.preset } : {}),
        })
        const sessionId = String(created?.sessionId || '')
        if (!sessionId) throw new Error('宿主没有返回会话 id')
        state.supervisor.sessionId = sessionId
        // 会话一建好就落盘：口径发不出去时这个对话还在，下次启用接着用它，不再建第二个孤儿。
        await saveState(root, state)
      }
      // 每次启用都补发口径：既覆盖「第一次启用」，也覆盖「上次口径没送出去，现在重试」。
      await controller.prompt(
        {
          sessionId: state.supervisor.sessionId,
          mode: 'queue',
          content: [
            {
              type: 'text',
              text:
                '你是这条流水线的值班监工。\n' +
                `仓库：${root}\n` +
                '你的任务：人不在的时候，让整张图跑完。你只处理两种事 ——\n' +
                '1）上一格已经归档、下一格还没启动：调 openspec_pipeline 的 run 把它接着跑起来。\n' +
                '2）某一格停住了（对话收尾了但没归档，或者在等人回话）：读它最后说的话，按手册回它（tell），' +
                '或者它其实做完了、只差归档（archive）。\n' +
                '规矩：不改代码（要改就让那个对话去改）；不碰正在跑的格子；不重启用户点过「停止」的流水线。\n' +
                '每个项目的手册会随值班单一起发给你；在那之前先读一遍手册再动手。',
            },
          ],
          requestId: randomUUID(),
        },
        // 宿主第一行就查取消信号；30 秒只约束这一次投递，不影响对话本身。
        AbortSignal.timeout(30_000),
      )
      state.supervisor.enabled = true
      watchArchives(root, 'supervisor')
      await saveState(root, state)
      return `监工已开：对话 ${state.supervisor.sessionId}。有事会发到那个对话里，它的回复就是处理记录。`
    }

    if (action.action === 'manual') {
      if (action.text === undefined) {
        const text = await readManual(root)
        return text
          ? `这个项目的手册（${text.length} 字）：\n\n${text}`
          : '这个项目还没有手册。用 action=manual text=... 写一份；监工每次收到值班单都会带上它。'
      }
      const saved = await writeManual(root, action.text)
      return `手册已保存（${saved.length} 字），跟着这个项目走（存在插件目录里）。`
    }

    if (action.action === 'tell') {
      const id = String(action.nodeId || '')
      const node = state.nodes.find((item) => item.id === id && item.kind !== 'start')
      if (!node) throw new Error(`图里没有这一格：${id || '（没给 id）'}`)
      if (!node.sessionId) throw new Error(`${id} 还没开过对话，没得可说`)
      const text = String(action.text || '').trim()
      if (!text) throw new Error('要说的话是空的')
      const controller = ctx.get?.('sessionController')
      if (!controller?.prompt) throw new Error('这台宿主没有 sessionController')
      const agent = ctx.get?.('agents')?.get?.(node.sessionId)
      const session = agent?.session || ctx.get?.('sessions')?.get?.(node.sessionId)
      if (!session) throw new Error(`${id} 的对话已经不在了（宿主重启过？）；要接着做就点「开始」重开这一格`)
      const from = Number(session.seq || 0)
      await controller.prompt(
        {
          sessionId: node.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          requestId: randomUUID(),
        },
        AbortSignal.timeout(30_000),
      )
      if (!action.wait) return `话已经送进 ${id} 的对话。`
      try {
        await waitForTurnEnd(session, from, AbortSignal.timeout(Number(action.timeoutMs) || 180_000))
      } catch (error) {
        return `话送进去了，但 ${id} 这一轮没收尾（${error?.message || error}）；它可能在等更久的事。`
      }
      const reply = lastAssistantText(session, from)
      return reply ? `${id} 回了：\n\n${reply}` : `${id} 这一轮结束了，但没读到它回的文字。`
    }

    if (action.action === 'archive') {
      const result = await archiveNode(root, {
        nodeId: action.nodeId,
        change: action.change,
        force: action.force,
      })
      if (result.ok) return `${result.text}\n${summarize(await snapshot(root))}`
      if (result.needsConfirm) {
        return `${result.text}\n\n${result.report}\n\n（validate 没过，所以没归档。要强行归档就把 force 设成 true 再调一次。）`
      }
      return `没归成：${result.error || '归档失败'}${result.report ? `\n\n${result.report}` : ''}`
    }

    throw new Error(`不认识的动作：${action.action}`)
  }

  // ---------- 工具 ----------

  // 工具注册放在 try 里：重名、schema 不合法这类问题只该让工具消失，不该拦住 Host 启动。
  try {
    const dispose = ctx.tools.register({
    name: 'openspec_pipeline',
    description:
      '管理这个仓库的 OpenSpec 变更流水线。图存在 openspec/pipeline.json，图的开头是 start（开工）节点：只有从它连出来的节点才会执行，没连的只是摆着。每个节点是一个 change，带依赖、对话模式、运营商、模型、思考强度、附加提示词，以及要不要归档后提交；也可以设一个默认组合（defaultProfileId），新加的节点和四样全空的节点会用它。工作区按面板来：每个面板各选各的仓库、各有各的 runner，两个工作区可以同时跑 —— 面板打开时优先跟当前对话所在的工作区，那里没有 openspec 才用上一次打开的那个。工具省略 root 时用「上一次打开 / 选中的工作区」，action=root 换的就是这个默认值（不会打断别的工作区里正在跑的那一条）。status 看图和进度，并把仓库里没归档的 change 归成三类：可以加入（没做完、也没人在别处做）、已完成只差归档、已在他处进行（做了一半、且最近十几分钟还在改，别重复做）；plan 重写整张图（nodes 里出现已归档、或者 changes/ 和 archive/ 都找不到的 change 就整单拒绝，一个字节都不写）；update 改一个节点；add-all 只把第一类（没做完且没人在做）一次加进来，加完先摆在画布上、不接线，由人拖到「开工」后面才进工作链；wire 按顺序接线（Agent 画图用）：order 串行 / stages 串并（每组同时起跑）/ steps 任意依赖，上游一律写 change 名；只碰它点名的格子，图里别的格子不动，已有格子的线默认不动（rewire=true 才重排，跑完和正在跑的格子仍然不动），不删格子，跑着的时候也能调（和手拖一条线一样，只影响还没开工的格子）；点名只在 archive/ 里的 change 会跳过并在回话里写清（上游写它当成已经满足），不因为一个跑完的成员整单失败；settings 逐格写提示词、模型这些，没写的项不动；dryRun 只算不写；写完回一段执行顺序（第几批、每格等谁、有没有野格子）；remove 删一个节点；prune 一键清掉已归档 / 哪里都找不到的格子（连带摘掉下游的线，运行中也允许，dryRun 只算不写）；run 开跑（点 run 就是批准；开跑前先看这一格能不能跑：change 目录还在、有任务清单、规划写完了（openspec status 读不到时不看这条），不够格的不开对话、记「等你」并写明差什么，这一轮不收工 —— 它写完就自动接着跑；手动 start-node 用同一把尺子，不够格直接拒绝；每个节点在工作区里新建一个顶层普通对话，左栏排序用「最近更新」时能在侧栏看见它干活；发的话就是「执行 <change> Change」，节点上写了附加提示词就接在后面；这一轮结束后 change 必须已经在 openspec/changes/archive/ 里才算完成、才放下一个，没归档就挂「等你」，归档一出现会自动接着跑 —— 只查目录，不要求 tasks 全勾（等的过程中把那格断开再接回来也照样接上；这一轮已经收工、之后才把下游接回来，保存时会自己接上，都不用再点 run）；节点上勾了 commit 的，归档之后 Host 再提交一次（git add -A + git commit，信息「openspec: <change>」），提交没成也挂「等你」、不算完成；至于「这个 change 走到哪一步」，读两条原生命令而不是靠猜：openspec list --json 给 complete / in-progress / no-tasks 和勾数，openspec status --all --json 给规划进度（proposal/specs/design/tasks 各是 done 还是缺）和 isPlanningComplete —— 只有 proposal 的 change 和「四件套只差 tasks」的 change 在 list 里都是 no-tasks 0/0，分不出来，必须靠 status）；archive 手动归档一格：先跑 openspec validate <change> --strict，把一句一条的问题原样返回来，validate 没过就默认不归档、等人点头，只有 force=true 才硬归 —— 归档之后 openspec 就再也找不到这个 change（老名字新名字都是 Unknown item），所以归档前那一刻是唯一能验的时机；stop 停。supervisor 开/关值班监工（它只在两种时候出手：上一格归档了下一格没启动、某一格停住等人回话；它不改代码，只调 run / tell / archive）；manual 读写这个项目的手册（值班单每次都带上它）；tell 给某一格的对话说一句话，wait=true 等它回完并带回回复。用户说「用插件把这些 change 依次跑完」「今晚把它们都做完」「看看变更流水线」这类话时，就是指这个工具。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'plan', 'wire', 'update', 'add-all', 'remove', 'prune', 'run', 'stop', 'root', 'archive', 'supervisor', 'manual', 'tell'],
          description:
            'status 看状态；plan 重写整张图（可带 defaultProfileId 指定默认组合）；wire 按顺序接线（Agent 画图的入口：order 串行 / stages 串并 / steps 任意依赖，可逐格写提示词，只碰点名的格子、已有线默认不动、跑着也能调、dryRun 只算不写）；update 改一个节点（prompt 会接在「执行 <change> Change」后面）；add-all 把可加的（没做完且没人在做）一次加进来；remove 删一个节点；prune 一键清掉已归档 / changes/ 和 archive/ 都找不到的格子（连带摘掉下游指向它们的线，运行中也允许，dryRun 只算不写）；run 开跑；stop 停；root 换默认工作区（配合 root 路径；别的工作区里正在跑的那一条不会被停）；archive 归档一格（先 validate --strict，没过默认不动，force=true 才硬归）；supervisor 开/关值班监工（enabled=false 关；开的时候插件建一个会话，把手册给它）；manual 读/写这个项目的值班手册（text 不写＝读）；tell 给某一格的对话说一句话（wait=true 等它回完并把回复带回来）。',
        },
        nodes: {
          type: 'array',
          description: 'plan 用：整张图。每个节点至少要有 id 和 change。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              change: { type: 'string' },
              deps: { type: 'array', items: { type: 'string' } },
              preset: { type: 'string', description: '对话模式（预置 id），留空跟随当前对话' },
              provider: { type: 'string' },
              model: { type: 'string' },
              effort: { type: 'string', description: '思考强度，留空跟随模型默认' },
              prompt: {
                type: 'string',
                description:
                  '附加提示词，接在「执行 <change> Change」后面；不写就只发这一句。验收口径、怎么归档写在这里 —— 这一轮结束时 change 必须已经在 archive/ 里，否则这一格会停下等你（面板上会出现「归档」按钮，点它就 validate --strict + archive）。',
              },
              commit: {
                type: 'boolean',
                description:
                  '归档之后由 Host 在工作区里提交一次：git add -A + git commit，信息 openspec: <change>，正文 archive/<新名字>。提交没成这一格挂「等你」、后面不动；修好后点 run 会重试提交（不重开对话）。不是 git 仓库、提交失败都算没成。',
              },
              approved: { type: 'string', description: '这一格真正开工的时间；由 runner 自动填，一般不用手写' },
            },
          },
        },
        order: {
          type: 'array',
          items: { type: 'string' },
          description:
            'wire 用：串行顺序，写 change 名。第一个接「开工」，后面每个等前一个。order / stages / steps 三选一。',
        },
        stages: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description:
            'wire 用：串并在同一张单子里。每组里的 change 同时起跑（都等上一组全部跑完），第一组接「开工」。',
        },
        steps: {
          type: 'array',
          description: 'wire 用：任意依赖，一个格子一条。after 不写等于接「开工」。',
          items: {
            type: 'object',
            properties: {
              change: { type: 'string' },
              after: {
                type: 'array',
                items: { type: 'string' },
                description: '上游的 change 名（不是节点 id）',
              },
            },
          },
        },
        settings: {
          type: 'array',
          description:
            'wire 用：逐格改设置。只认 prompt / preset / provider / model / effort / commit 六项，没写的项不动；状态、开工时间、sessionId 碰不到。一般就是给每一格写它自己的验收口径。',
          items: {
            type: 'object',
            properties: {
              change: { type: 'string' },
              prompt: { type: 'string', description: '附加提示词，接在「执行 <change> Change」后面' },
              preset: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              effort: { type: 'string' },
              commit: { type: 'boolean' },
            },
          },
        },
        rewire: {
          type: 'boolean',
          description:
            'wire 用：默认 false —— 已有格子已有的线一根都不动（人手断开的地方不能被下一次画图接回去）。true 才按这次的顺序重排；跑完了和正在跑的格子仍然不动。',
        },
        dryRun: {
          type: 'boolean',
          description: 'wire 用：只算不写。返回会加几格、改几条线、按什么批次跑 —— 自检一遍再落笔。',
        },
        nodeId: { type: 'string', description: 'remove / archive 用：目标节点 id' },
        force: {
          type: 'boolean',
          description:
            'archive 用：validate --strict 没过时，默认不归档、只把问题返回。设 true 才强行归档（跳过验证这一步，但合并仍然要解析成功）。',
        },
        node: { type: 'object', description: 'update 用：要改的字段' },
        name: { type: 'string' },
        enabled: {
          type: 'boolean',
          description: 'supervisor 用：true 开、false 关。开的时候插件会建一个值班对话并把手册交给它。',
        },
        text: {
          type: 'string',
          description: 'manual 用：这个项目的值班手册正文（不写就是读）；tell 用：要送进那一格对话的话。',
        },
        wait: {
          type: 'boolean',
          description: 'tell 用：等那一轮跑完，把它的回复带回来（默认只送到就走）。',
        },
        timeoutMs: { type: 'number', description: 'tell 用：wait 最多等多久，默认 180000。' },
        root: {
          type: 'string',
          description:
            '仓库绝对路径。action=root 时用它换默认工作区（之后新打开的面板、以及省略 root 的工具调用都用它）；其它动作带上就只操作这一个仓库，跟面板各看各的是一回事，不会打断别的工作区里正在跑的那一条。',
        },
        maxParallel: { type: 'number' },
        defaultProfileId: {
          type: 'string',
          description: 'plan 用：默认组合 id（必须已在 profiles 里）。新加的节点自动带上这套设置；节点四样全空时开跑也用它。留空清掉。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } } },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.text ?? '') }]
      },
    },
    async execute(args, exec) {
      const action = args && typeof args === 'object' ? args : {}
      if (action.action === 'root') {
        try {
          const target = String(action.root || '').trim()
          if (!target) throw new Error('没给工作区路径')
          if (!looksLikeProject(target)) throw new Error(`这个目录里没有 openspec：${target}`)
          const project = await setDefaultRoot(target)
          return { text: `工作区切到 ${project}\n${summarize(await snapshot(project, { from: 'panel' }))}` }
        } catch (error) {
          return { text: `没做成：${error?.message || error}` }
        }
      }
      // 工具没指定 root 时用「上一次打开 / 选中的工作区」。面板那边各带各的，不受这条影响。
      const root = action.root || (await resolveRoot())
      try {
        const text = await applyAction(root, action)
        return { text }
      } catch (error) {
        return { text: `没做成：${error?.message || error}` }
      }
    },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
    diag('tool 注册成功：openspec_pipeline')
  } catch (error) {
    diag(`tool 注册失败（不影响启动）：${errorText(error)}`)
  }

  // ---------- 面板用的接口 ----------

  function send(res, code, value) {
    const body = JSON.stringify(value)
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 2 << 20) throw new Error('请求太大')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  try {
    const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        async handler(req, res) {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          try {
            const body = req.method === 'POST' ? await readBody(req) : undefined
            // 客户端半身报错都送到这里。只记日志，永远回 200：这条路径自己不能成为故障源。
            if (url.pathname === `${ROUTE}/client-log` && req.method === 'POST') {
              diag(`[web] ${String(body?.text || '').slice(0, 4000)}`)
              return send(res, 200, { ok: true })
            }
            // 某个具体模型支持哪些思考强度：面板选中模型后问一次。
            if (url.pathname === `${ROUTE}/model-info` && req.method === 'GET') {
              const provider = String(url.searchParams.get('provider') || '')
              const model = String(url.searchParams.get('model') || '')
              const info = await resolveModelEfforts(provider, model)
              return send(res, 200, { ok: true, ...(info || { efforts: [], defaultEffort: '', contextWindow: null }) })
            }
            // 切工作区（这个面板自己的选择）。同时记成「上一次打开的工作区」，
            // 给下一个没有对话依据的面板当默认值 —— 但别的面板不会被带着一起换。
            if (url.pathname === `${ROUTE}/action` && req.method === 'POST' && body?.action === 'root') {
              const next = String(body.root || '').trim()
              if (!next) return send(res, 400, { ok: false, error: '没给工作区路径' })
              if (!looksLikeProject(next)) return send(res, 400, { ok: false, error: `这个目录里没有 openspec：${next}` })
              const project = await setDefaultRoot(next)
              return send(res, 200, {
                ok: true,
                text: `工作区切到 ${project}`,
                ...(await snapshot(project, { fresh: true, from: 'panel', seat: seatOf(body) })),
              })
            }
            // 每个面板各带各的 root / seat：面板自己选过就按它，没选过就看当前对话，
            // 都没有才落到「上一次打开的那个工作区」。两个面板可以各看一个仓库。
            const seat = seatOf(body) || seatOf({
              sessionId: url.searchParams.get('seat') || '',
              cwd: url.searchParams.get('cwd') || '',
            })
            const requested = String(body?.root || url.searchParams.get('root') || '').trim()
            const { root, from } = await panelRoot(requested, seat)
            // 面板第一次打开（请求里还没带 root）算到的那个仓库，就是下一次「没有对话依据」
            // 时的默认值。之后带着 root 来的请求（刷新、保存、开跑）不再改写它，
            // 否则两个面板各刷各的，会把默认值刷成最后说话的那一个。
            if (!requested && root && looksLikeProject(root)) await setDefaultRoot(root)
            // 面板已经自己带着 root 来了，就不必再解释这个仓库是怎么来的：
            // 沿用面板上一次记下的来源（跟着对话 / 上一次打开），别刷成「自己选的」。
            const fromOut = requested ? '' : from

            // 面板的推送通道：一条 SSE 长连接，Host 有变化就写一行。这里不结束响应。
            // 连接按工作区分开：归档监听跟着连接走，这个工作区最后一个面板断开就停。
            if (url.pathname === `${ROUTE}/events` && req.method === 'GET') {
              watchArchives(root)
              openEventStream(req, res, root)
              return
            }

            if (url.pathname === `${ROUTE}/state` && req.method === 'GET') {
              return send(res, 200, { ok: true, ...(await snapshot(root, { fresh: true, from: fromOut, seat })) })
            }
            // 这个项目的值班手册：存在插件目录里，一个项目一份。
            if (url.pathname === `${ROUTE}/manual` && req.method === 'GET') {
              return send(res, 200, { ok: true, root, text: await readManual(root) })
            }
            if (url.pathname === `${ROUTE}/manual` && req.method === 'POST') {
              const text = await writeManual(root, body?.text)
              return send(res, 200, { ok: true, root, text })
            }
            if (url.pathname === `${ROUTE}/action` && req.method === 'POST') {
              // 归档不是普通动作：验证不过时要把整份报告交回面板，让人决定要不要硬归。
              // 所以它单独走一条分支，拿回的是结构化结果，不是一句话。
              if (body.action === 'archive') {
                const result = await archiveNode(root, body)
                return send(res, 200, { ...result, ...(await snapshot(root, { fresh: true, from: fromOut, seat })) })
              }
              if (body.action === 'save') {
                const incoming = normalize(body.state || {}, { recover: false })
                const runner = runnerFor(root)
                // 平时也按「画布出图、服务器出状态」来并：自动落盘很频繁，
                // 客户端那份状态随时可能旧一截（比如它记着 running，宿主早就收尾了）。
                // 没有 runner 时读盘会把残留的 running 判成 failed，正好覆盖这种情况。
                const current = runner ? runner.state : await loadState(root)
                const merged = mergeRunningGraph(current, incoming)
                if (runner) runner.state = merged
                await saveState(root, merged)
                // 这一轮已经收工、但图又被改了：如果刚好接出一个够格的格子，就接着跑。
                // 只认「新增的、接在跑完的格子后面的」格子，别的一次保存都不会开对话。
                resumeIdleRun(root, current, merged)
                // 保存是高频动作（拖一下、连一下线就存一次），不吃 fresh：
                // 仓库扫描走 3 秒缓存，返回得快，面板上的图立刻就能更新。
                return send(res, 200, { ok: true, ...(await snapshot(root, { from: fromOut, seat })) })
              }
              const text = await applyAction(root, body)
              return send(res, 200, { ok: true, text, ...(await snapshot(root, { fresh: true, from: fromOut, seat })) })
            }
            return send(res, 404, { ok: false, error: '没有这个接口' })
          } catch (error) {
            return send(res, 400, { ok: false, error: String(error?.message || error) })
          }
        },
      })
    if (typeof dispose === 'function') disposers.push(dispose)
    diag(`route 注册成功：${ROUTE}`)
  } catch (error) {
    diag(`route 注册失败（不影响启动）：${errorText(error)}`)
  }

  diag('apply 完成')

  return () => {
    diag('apply 清理')
    stopAllArchiveWatches()
    for (const res of streams.keys()) {
      try {
        res.end()
      } catch {}
    }
    streams.clear()
    for (const runner of runners.values()) runner.stop()
    runners.clear()
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {}
    }
  }
}