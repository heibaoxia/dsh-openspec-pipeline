// dsh-openspec-pipeline — Web 面板。
// 注册两个座位：左侧「全局面板图标」一个，中央主面板一整页。
// 数据全部走 Host 的 /openspec-pipeline/ 接口，面板自己不发明状态。
//
// 启动纪律（2026-10-27 的教训）：
// 客户端半身只要有一个异常逃出 apply，DSH 的 web boot 就判整页失败
// （`web boot: N entry did not activate`），桌面端会直接起不来，只能重置插件。
// 所以这里每一条注册都单独兜住，失败只记日志 + 上报 Host，绝不向外抛。

const BASE = '/openspec-pipeline/api'
const BUILD = '0.11.0'

// 面板挂载后拿到的客户端上下文。只用来让左侧会话列表刷新一次；
// 取不到就什么也不做，不能让这条辅助逻辑影响面板。
let clientContext = null

function reportClientError(stage, error) {
  let text
  try {
    text = `[client] ${stage}: ${String((error && (error.stack || error.message)) || error)}`.slice(0, 4000)
  } catch {
    text = `[client] ${stage}: 无法读取错误内容`
  }
  try {
    if (typeof console !== 'undefined' && console.warn) console.warn('[openspec-pipeline]', text)
  } catch {}
  try {
    if (typeof fetch === 'function') {
      fetch(`${BASE}/client-log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        keepalive: true,
      }).catch(() => {})
    }
  } catch {}
}

// 一行诊断信息（不带堆栈），写进 Host 的 openspec-pipeline.log。
;(function registerClientHalf() {
  const loader = typeof window === 'object' && window ? window.__ModuleLoader__ : undefined
  if (!loader || typeof loader.load !== 'function') return
  try {
    loader.load({
      id: 'dsh-openspec-pipeline',
      factory(require) {
        try {
          return createPlugin(require)
        } catch (error) {
          // 连插件构造都失败：交一个空壳出去，保住整页启动。
          reportClientError('factory', error)
          return { apply() {} }
        }
      },
    })
  } catch (error) {
    reportClientError('register', error)
  }

  function createPlugin(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

    function Icon({ size = 18, active }) {
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: color,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 2.5, y: 3.5, width: 6, height: 5, rx: 1.5 }),
        h('rect', { x: 2.5, y: 15.5, width: 6, height: 5, rx: 1.5 }),
        h('rect', { x: 15.5, y: 9.5, width: 6, height: 5, rx: 1.5 }),
        h('path', { d: 'M8.5 6h3.5a1.5 1.5 0 0 1 1.5 1.5V12' }),
        h('path', { d: 'M8.5 18h3.5a1.5 1.5 0 0 0 1.5-1.5V14' }),
      )
    }

    const STATUS_TEXT = {
      pending: '待跑',
      running: '跑着',
      done: '完成',
      needs_human: '等你',
      failed: '失败',
      skipped: '跳过',
    }

    // 只留排序用的阶段序；「这一格现在怎么说」统一由 changeState() 一处给，
    // 免得同一个状态在几个地方各写一套文案（以前 STAGE_TEXT / stageLabel 就是这种）。
    const STAGE_ORDER = { proposal: 0, todo: 1, doing: 2, implemented: 3 }

    // 这一格现在到底走到哪。全是读出来的事实，不猜：
    //   已归档 / 仓库里找不到 / propose 还没写完 / 没有任务清单 / 还没开工 / 做到 x/y / 只差归档
    //
    // 两个来源：列表行用 done/total（openspec list），图上节点用 taskDone/taskTotal，
    // 规划进度用 planning（openspec status），所以取值两种写法都兼容。
    function changeState(row) {
      if (row?.archived) return { key: 'archived', short: '已归档', text: '已归档' }
      if (row?.missing) return { key: 'missing', short: '找不到', text: 'changes/ 和 archive/ 里都找不到' }
      const planning = row?.planning
      if (planning && planning.complete === false) {
        const missing = (planning.missing || []).join('、')
        return {
          key: 'planning',
          short: `规划 ${planning.done}/${planning.total}`,
          text: `propose 还没写完：规划 ${planning.done}/${planning.total}${missing ? `，还差 ${missing}` : ''}`,
        }
      }
      const total = Number(row?.taskTotal ?? row?.total ?? 0) || 0
      const done = Math.max(0, Number(row?.taskDone ?? row?.done ?? 0) || 0)
      if (!total) return { key: 'no-tasks', short: '没任务清单', text: '还没有 tasks.md，开跑也跑不了' }
      if (done >= total) return { key: 'ready', short: '只差归档', text: `任务全勾 ${done}/${total}，只差归档` }
      if (done <= 0) return { key: 'not-started', short: `0/${total}`, text: `还没开工 0/${total}` }
      return { key: 'doing', short: `${done}/${total}`, text: `做到 ${done}/${total}` }
    }

    function statusColor(status) {
      if (status === 'done') return 'var(--dsw-alias-state-success-primary)'
      if (status === 'failed') return 'var(--dsw-alias-state-error-primary)'
      if (status === 'needs_human') return 'var(--dsw-alias-state-warn-primary)'
      if (status === 'running') {
        return 'var(--dsw-alias-brand-primary)'
      }
      return 'var(--dsw-alias-state-idle-primary)'
    }

    const styles = {
      root: {
        height: '100%',
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '16px 20px 32px',
        fontSize: 13,
        lineHeight: 1.5,
      },
      bar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      title: { fontSize: 14, fontWeight: 600, margin: 0 },
      dim: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '5px 12px',
        fontSize: 13,
        cursor: 'pointer',
      },
      primary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        borderRadius: 8,
        padding: '5px 12px',
        fontSize: 13,
        cursor: 'pointer',
      },
      ghost: {
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 8,
        padding: '2px 8px',
        fontSize: 16,
        lineHeight: 1,
        cursor: 'pointer',
      },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 7,
        padding: '4px 8px',
        fontSize: 13,
        minWidth: 0,
        width: '100%',
      },
      textarea: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 7,
        padding: '6px 8px',
        fontSize: 13,
        width: '100%',
        resize: 'vertical',
        minHeight: 60,
        fontFamily: 'inherit',
      },
      badge: {
        fontSize: 11,
        padding: '1px 8px',
        borderRadius: 999,
        border: '1px solid currentColor',
        whiteSpace: 'nowrap',
      },
      board: {
        position: 'relative',
        width: '100%',
        maxWidth: 660,
        aspectRatio: '1 / 1',
        marginTop: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 12,
        overflow: 'hidden',
        touchAction: 'none',
      },
      hint: {
        position: 'absolute',
        left: 10,
        top: 8,
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        pointerEvents: 'none',
      },
      zoomChip: {
        position: 'absolute',
        right: 10,
        bottom: 10,
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      list: { marginTop: 14, width: '100%', maxWidth: 660, display: 'grid', gap: 4 },
      item: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
        cursor: 'pointer',
        userSelect: 'none',
      },
      itemIn: { borderStyle: 'dashed', cursor: 'default', background: 'transparent' },
      name: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 },
      overlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      },
      dialog: {
        width: 460,
        maxWidth: '92vw',
        maxHeight: '86vh',
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        padding: 16,
        display: 'grid',
        gap: 12,
        boxShadow: '0 20px 60px rgba(0,0,0,.3)',
      },
      menu: {
        position: 'absolute',
        zIndex: 20,
        minWidth: 200,
        display: 'grid',
        gap: 4,
        padding: 6,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        boxShadow: '0 6px 24px rgba(0,0,0,.18)',
      },
    }

    function short(text, n = 46) {
      const value = String(text || '')
      return value.length > n ? `${value.slice(0, n)}…` : value
    }

    // 只看「图长什么样」：节点、change、连线。状态/说明不算，它们在画布上是服务器事实。
    function graphSignature(state) {
      return JSON.stringify(
        (state?.nodes || [])
          .map((node) => [node.id, node.change || '', node.kind || '', [...(node.deps || [])].sort()])
          .sort(),
      )
    }

    async function api(path, init) {
      const response = await fetch(path, init)
      const json = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (!response.ok || json.ok === false) throw new Error(json.error || `HTTP ${response.status}`)
      return json
    }

    // 归档要用这一版：验证没过时服务器回的是 ok:false + needsConfirm + report，
    // 那不是错误，是要拿给人看的东西。走 api() 会把它当异常吞掉。
    async function apiRaw(path, init) {
      const response = await fetch(path, init)
      const json = await response.json().catch(() => null)
      if (!json) return { ok: false, error: `HTTP ${response.status}` }
      return json
    }

    // 左栏排序模式是 DSH 浏览器本地状态，只读一眼给提示用。
    // DSH 换了存储 key 就返回空：面板少一行提示，不影响别的功能。
    function readSidebarOrder() {
      try {
        const raw = window.localStorage.getItem('dsh.workspace.view.v5')
        const parsed = raw ? JSON.parse(raw) : null
        return String(parsed?.orderBy || '')
      } catch {
        return ''
      }
    }

    const NODE_W = 168
    const NODE_H = 46

    function dependsOn(nodes, from, target) {
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const seen = new Set()
      const stack = [from]
      while (stack.length) {
        const id = stack.pop()
        if (id === target) return true
        if (seen.has(id)) continue
        seen.add(id)
        for (const dep of byId.get(id)?.deps || []) stack.push(dep)
      }
      return false
    }

    // 从「开工」出发分层；连不到的格子放在最下面那排（画布上的草稿区）。
    function layoutOf(nodes) {
      const depth = new Map()
      if (nodes.some((n) => n.id === 'start')) depth.set('start', 0)
      let frontier = depth.has('start') ? ['start'] : []
      while (frontier.length) {
        const next = []
        for (const id of frontier) {
          const base = depth.get(id) || 0
          for (const node of nodes) {
            if (!(node.deps || []).includes(id)) continue
            if ((depth.get(node.id) ?? -1) >= base + 1) continue
            depth.set(node.id, base + 1)
            next.push(node.id)
          }
        }
        frontier = next
      }

      const columns = new Map()
      for (const node of nodes) {
        if (!depth.has(node.id)) continue
        const column = depth.get(node.id) || 0
        if (!columns.has(column)) columns.set(column, [])
        columns.get(column).push(node)
      }

      const position = new Map()
      let lowest = 16
      for (const column of [...columns.keys()].sort((a, b) => a - b)) {
        columns.get(column).forEach((node, index) => {
          const x = 16 + column * (NODE_W + 56)
          const y = 16 + index * (NODE_H + 22)
          position.set(node.id, { x, y })
          lowest = Math.max(lowest, y + NODE_H)
        })
      }

      const parked = nodes.filter((node) => !depth.has(node.id))
      parked.forEach((node, index) => {
        position.set(node.id, { x: 16 + index * (NODE_W + 24), y: lowest + 48 })
      })

      const points = [...position.values()]
      const width = Math.max(320, ...points.map((p) => p.x + NODE_W + 16))
      const height = Math.max(150, ...points.map((p) => p.y + NODE_H + 24))
      return { position, width, height, wired: new Set(depth.keys()) }
    }

    function Graph({ nodes, onChange, onOpen, onContextMenu }) {
      const svgRef = useRef(null)
      const [drag, setDrag] = useState(null)
      const [link, setLink] = useState(null)
      const [pan, setPan] = useState(null)
      const [hoverId, setHoverId] = useState(null)
      const [cam, setCam] = useState({ x: 24, y: 24, k: 1 })
      const layout = useMemo(() => layoutOf(nodes), [nodes])

      // 滚轮缩放，以指针为锚点。必须用原生监听：React 的 onWheel 是 passive 的，preventDefault 无效。
      useEffect(() => {
        const element = svgRef.current
        if (!element) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const rect = element.getBoundingClientRect()
          const px = event.clientX - rect.left
          const py = event.clientY - rect.top
          const factor = Math.exp(-event.deltaY * 0.0015)
          setCam((current) => {
            const k = Math.min(2.4, Math.max(0.35, current.k * factor))
            const ratio = k / current.k
            return { k, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
          })
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [])

      const positions = new Map(
        nodes.map((node) => {
          const fallback = layout.position.get(node.id) || { x: 16, y: 16 }
          return [
            node.id,
            {
              x: Number.isFinite(node.x) ? node.x : fallback.x,
              y: Number.isFinite(node.y) ? node.y : fallback.y,
            },
          ]
        }),
      )

      // 屏幕坐标 → 画布坐标（受缩放 / 平移影响）
      const toWorld = (event) => {
        const element = svgRef.current
        if (!element) return { x: 0, y: 0 }
        const rect = element.getBoundingClientRect()
        return {
          x: (event.clientX - rect.left - cam.x) / cam.k,
          y: (event.clientY - rect.top - cam.y) / cam.k,
        }
      }

      const nodeAt = (point) =>
        nodes.find((node) => {
          const p = positions.get(node.id)
          if (!p) return false
          return point.x >= p.x && point.x <= p.x + NODE_W && point.y >= p.y && point.y <= p.y + NODE_H
        })

      useEffect(() => {
        if (!drag && !link && !pan) return undefined
        const move = (event) => {
          if (pan) {
            setCam((current) => ({
              ...current,
              x: pan.cx + (event.clientX - pan.sx),
              y: pan.cy + (event.clientY - pan.sy),
            }))
            return
          }
          const point = toWorld(event)
          if (drag) {
            onChange({
              type: 'move',
              id: drag.id,
              x: Math.max(0, Math.round(point.x - drag.dx)),
              y: Math.max(0, Math.round(point.y - drag.dy)),
            })
            return
          }
          if (link) {
            const target = nodeAt(point)
            setHoverId(target && target.id !== link.from ? target.id : null)
            setLink((current) => {
              if (!current) return current
              const moved = current.moved || Math.hypot(point.x - current.x0, point.y - current.y0) > 6 / cam.k
              return { ...current, x: point.x, y: point.y, moved }
            })
          }
        }
        const up = (event) => {
          if (pan) {
            setPan(null)
            return
          }
          if (link && !link.sticky) {
            const target = nodeAt(toWorld(event))
            if (link.moved && target && target.id !== link.from) {
              onChange({ type: 'connect', from: link.from, to: target.id })
              setDrag(null)
              setLink(null)
              setHoverId(null)
              return
            }
            if (!link.moved) {
              // 只点了一下出口、没拖：留在「再点一个方框」模式。
              setLink((current) => (current ? { ...current, sticky: true } : current))
              return
            }
          }
          setDrag(null)
          setLink(null)
          setHoverId(null)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
      })

      const edges = []
      for (const node of nodes) {
        for (const dep of node.deps || []) {
          const from = positions.get(dep)
          const to = positions.get(node.id)
          if (!from || !to) continue
          const x1 = from.x + NODE_W
          const y1 = from.y + NODE_H / 2
          const x2 = to.x
          const y2 = to.y + NODE_H / 2
          const mid = Math.max(24, Math.abs(x2 - x1) / 2)
          edges.push({
            key: `${dep}->${node.id}`,
            from: dep,
            to: node.id,
            x1,
            y1,
            x2,
            y2,
            d: `M${x1},${y1} C${x1 + mid},${y1} ${x2 - mid},${y2} ${x2},${y2}`,
          })
        }
      }

      const content = h(
        'g',
        { transform: `translate(${cam.x},${cam.y}) scale(${cam.k})` },
        edges.map((edge) => {
          const mx = (edge.x1 + edge.x2) / 2
          const my = (edge.y1 + edge.y2) / 2
          return h(
            'g',
            { key: edge.key },
            h('path', {
              d: edge.d,
              fill: 'none',
              stroke: 'var(--dsw-alias-border-l2)',
              strokeWidth: 1.5 / cam.k,
              pointerEvents: 'none',
            }),
            h(
              'g',
              {
                style: { cursor: 'pointer' },
                onClick: () => onChange({ type: 'disconnect', from: edge.from, to: edge.to }),
              },
              h('circle', {
                cx: mx,
                cy: my,
                r: 9,
                fill: 'var(--dsw-alias-bg-base)',
                stroke: 'var(--dsw-alias-border-l2)',
                strokeWidth: 1,
              }),
              h(
                'text',
                {
                  x: mx,
                  y: my + 4,
                  textAnchor: 'middle',
                  fontSize: 12,
                  fill: 'var(--dsw-alias-label-secondary)',
                  pointerEvents: 'none',
                },
                '×',
              ),
            ),
          )
        }),
        link
          ? h('path', {
              d: `M${link.x0},${link.y0} L${link.x},${link.y}`,
              fill: 'none',
              stroke: 'var(--dsw-alias-brand-primary)',
              strokeWidth: 1.5 / cam.k,
              strokeDasharray: `${4 / cam.k} ${4 / cam.k}`,
              pointerEvents: 'none',
            })
          : null,
        nodes.map((node) => {
          const p = positions.get(node.id) || { x: 16, y: 16 }
          const isStart = node.kind === 'start'
          const wired = isStart || layout.wired.has(node.id)
          const broken = !isStart && (node.deps || []).some((dep) => !nodes.some((n) => n.id === dep))
          // 仓库侧的事实：归档了 / 找不到 / 正在别处做。都标红，文字写在节点上。
          const stateText = isStart
            ? ''
            : node.archived
              ? '已归档'
              : node.missing
                ? '已找不到'
                : node.external
                  ? '已在他处进行'
                  : ''
          const bad = Boolean(stateText) || broken
          // 节点上第二行写「仓库里走到哪」，不只是任务百分比：
          // 规划 3/4 / 没任务清单 / 还没开工 / 做到 3/9 / 只差归档 / 已归档，一眼能分开。
          const task = isStart ? null : changeState(node)
          // 规划没写完用黄色提醒，不用红色：它不是「坏了」，是「还没准备好」。
          const planningWarn = !bad && !isStart && task?.key === 'planning'
          return h(
            'g',
            {
              key: node.id,
              transform: `translate(${p.x},${p.y})`,
              style: { cursor: drag?.id === node.id ? 'grabbing' : 'grab' },
              onContextMenu: (event) => {
                event.preventDefault()
                event.stopPropagation()
                const box = svgRef.current?.parentElement?.getBoundingClientRect()
                onContextMenu?.(node.id, {
                  x: event.clientX - (box ? box.left : 0),
                  y: event.clientY - (box ? box.top : 0),
                  maxY: box ? box.height : 0,
                })
              },
              onDoubleClick: (event) => {
                event.stopPropagation()
                onOpen(node.id)
              },
              onPointerDown: (event) => {
                if (event.button === 2) return
                event.preventDefault()
                event.stopPropagation()
                if (link?.sticky) {
                  if (node.id !== link.from) onChange({ type: 'connect', from: link.from, to: node.id })
                  setLink(null)
                  setHoverId(null)
                  return
                }
                const point = toWorld(event)
                setDrag({ id: node.id, dx: point.x - p.x, dy: point.y - p.y })
              },
            },
            h('title', null, isStart
              ? '开工'
              : `${node.change || node.id}${task ? ` · ${task.text}` : ''}`),
            h('rect', {
              width: NODE_W,
              height: NODE_H,
              rx: 8,
              fill: isStart ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-base)',
              stroke:
                hoverId === node.id
                  ? 'var(--dsw-alias-brand-primary)'
                  : isStart
                    ? 'var(--dsw-alias-brand-primary)'
                    : bad
                      ? 'var(--dsw-alias-state-error-primary)'
                      : planningWarn
                        ? 'var(--dsw-alias-state-warn-primary)'
                        : wired
                          ? statusColor(node.status)
                          : 'var(--dsw-alias-state-warn-primary)',
              strokeWidth: hoverId === node.id ? 2.6 / cam.k : 1.6 / cam.k,
              strokeDasharray: stateText ? '3 3' : wired || isStart ? undefined : '5 4',
            }),
            h(
              'text',
              { x: 12, y: 19, fontSize: 11.5, fill: 'var(--dsw-alias-label-primary)', pointerEvents: 'none' },
              isStart ? '开工' : short(node.change, 20),
            ),
            h(
              'text',
              {
                x: 12,
                y: 34,
                fontSize: 10.5,
                fill: isStart
                  ? 'var(--dsw-alias-brand-primary)'
                  : bad
                    ? 'var(--dsw-alias-state-error-primary)'
                    : planningWarn
                      ? 'var(--dsw-alias-state-warn-primary)'
                      : wired
                        ? statusColor(node.status)
                        : 'var(--dsw-alias-state-warn-primary)',
                pointerEvents: 'none',
              },
              isStart
                ? 'start'
                : `${node.id} · ${stateText || (wired ? STATUS_TEXT[node.status] || node.status : '没接入')}${task ? ` · ${task.short}` : ''}`,
            ),
            isStart
              ? null
              : h(
                  'g',
                  { pointerEvents: 'none' },
                  h('circle', {
                    cx: 0,
                    cy: NODE_H / 2,
                    r: 6,
                    fill: 'var(--dsw-alias-bg-base)',
                    stroke: 'var(--dsw-alias-border-l2)',
                    strokeWidth: 1.5,
                  }),
                  h('circle', { cx: 0, cy: NODE_H / 2, r: 2, fill: 'var(--dsw-alias-border-l2)' }),
                ),
            h(
              'g',
              {
                style: { cursor: 'crosshair' },
                onPointerDown: (event) => {
                  event.stopPropagation()
                  event.preventDefault()
                  const start = { x: p.x + NODE_W, y: p.y + NODE_H / 2 }
                  setLink({
                    from: node.id,
                    x0: start.x,
                    y0: start.y,
                    x: start.x,
                    y: start.y,
                    moved: false,
                    sticky: false,
                  })
                },
              },
              h('circle', {
                cx: NODE_W,
                cy: NODE_H / 2,
                r: 7,
                fill: 'var(--dsw-alias-brand-primary)',
                stroke: 'var(--dsw-alias-bg-base)',
                strokeWidth: 2,
              }),
              h('circle', { cx: NODE_W, cy: NODE_H / 2, r: 16, fill: 'transparent' }),
            ),
          )
        }),
      )

      return h(
        React.Fragment,
        null,
        h(
          'svg',
          {
            ref: svgRef,
            width: '100%',
            height: '100%',
            role: 'img',
            'aria-label': '变更流水线图',
            style: { display: 'block', userSelect: 'none', touchAction: 'none', cursor: pan ? 'grabbing' : 'default' },
            onPointerDown: (event) => {
              if (event.button !== 0) return
              if (event.target !== event.currentTarget) return
              event.preventDefault()
              setPan({ sx: event.clientX, sy: event.clientY, cx: cam.x, cy: cam.y })
            },
          },
          content,
        ),
        link?.sticky
          ? h(
              'span',
              {
                style: {
                  position: 'absolute',
                  left: 10,
                  bottom: 10,
                  fontSize: 11,
                  color: 'var(--dsw-alias-brand-primary)',
                  pointerEvents: 'none',
                },
              },
              `再点一个方框，把它接到 ${link.from} 后面；点空白处取消`,
            )
          : null,
        h(
          'span',
          {
            style: styles.zoomChip,
            title: '点击回到 100%',
            onClick: () => setCam({ x: 24, y: 24, k: 1 }),
          },
          `${Math.round(cam.k * 100)}%`,
        ),
      )
    }

    function Field({ label, children }) {
      return h(
        'label',
        { style: { display: 'grid', gap: 3 } },
        h('span', { style: styles.label }, label),
        children,
      )
    }

    // 面板不认「当前对话」：请求里不再带 session。仓库由 Host 按插件自己的设置决定，
    // 所以同一个面板在任何对话里打开，读写的都是同一张图。
    // 但「座位」（scope.sessionId）只用来当**刷新信号**：切换对话时重读一次，
    // 不改读哪个仓库。
    function Panel({ scope, sessionId: seatProp } = {}) {
      const seat = String(scope?.sessionId || seatProp || '')
      const [view, setView] = useState(null)
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [serverDiff, setServerDiff] = useState(false)
      const [dirtyShown, setDirtyShown] = useState(false)
      const [menu, setMenu] = useState(null)
      const [showSettings, setShowSettings] = useState(false)
      const [editing, setEditing] = useState(null)
      const [modelInfo, setModelInfo] = useState(null)
      const [activeCombo, setActiveCombo] = useState('')
      const [savingCombo, setSavingCombo] = useState(false)
      const [comboName, setComboName] = useState('')
      const [rootInput, setRootInput] = useState('')
      const [sidebarOrder, setSidebarOrder] = useState(readSidebarOrder)
      // 手动归档：正在归哪一格、以及「validate 没过」等人生确认的那份报告。
      const [archiveBusy, setArchiveBusy] = useState('')
      const [archiveAsk, setArchiveAsk] = useState(null)
      const dirty = useRef(false)
      // 画布画的是 draft；刷新时要在函数里看它当前的样子，闭包里的那份是旧的。
      const draftRef = useRef(null)
      draftRef.current = draft

      // 切对话时重读一次左栏排序：座位变了，左栏可能也被切过。
      useEffect(() => {
        setSidebarOrder(readSidebarOrder())
      }, [seat])

      // 选中某个具体模型后，问宿主它支持哪些思考强度。没选 provider+model 就用通用列表。
      const editingProvider = editing ? (draft?.nodes || []).find((n) => n.id === editing)?.provider || '' : ''
      const editingModel = editing ? (draft?.nodes || []).find((n) => n.id === editing)?.model || '' : ''
      useEffect(() => {
        if (!editingProvider || !editingModel) {
          setModelInfo(null)
          return undefined
        }
        let cancelled = false
        api(
          `${BASE}/model-info?provider=${encodeURIComponent(editingProvider)}&model=${encodeURIComponent(editingModel)}`,
        )
          .then((info) => {
            if (!cancelled) setModelInfo(info)
          })
          .catch(() => {
            if (!cancelled) setModelInfo(null)
          })
        return () => {
          cancelled = true
        }
      }, [editingProvider, editingModel])

      const markDirty = useCallback(() => {
        dirty.current = true
        setDirtyShown(true)
      }, [])

      const clearDirty = useCallback(() => {
        dirty.current = false
        setDirtyShown(false)
      }, [])

      // 宿主直接建的会话，客户端列表要重拉一次才拿到摘要。这里只是催一次
      // session.list；它不改左栏的排序和可见条数，也不负责「让新对话出现」。
      // 拿不到客户端服务就静默跳过，不能影响面板。
      const refreshSidebar = useCallback(() => {
        try {
          const sessions = clientContext?.get?.('sessions') || clientContext?.sessions
          if (!sessions || typeof sessions.refresh !== 'function') return
          Promise.resolve(sessions.refresh()).catch(() => {})
        } catch {}
      }, [])

      const take = useCallback((payload) => {
        setView(payload)
        setMenu(null)
        // 只更新「服务器事实」和草案；有未保存改动时绝不拿服务器状态盖掉草案，
        // 否则刷新会把刚删的线、刚拖的位置还原回去。
        setDraft((current) => (dirty.current && current ? current : payload.state))
      }, [])

      const load = useCallback(
        async (silent) => {
          try {
            const payload = await api(`${BASE}/state`)
            // 有没保存的草稿时画布不会被服务器状态覆盖（否则刚删的线、刚拖的位置会弹回来）。
            // 但服务器那边真的变了就必须说出来，不然「点刷新没反应」会让人以为面板坏了。
            const drawing = draftRef.current
            setServerDiff(
              Boolean(dirty.current && drawing && graphSignature(drawing) !== graphSignature(payload.state)),
            )
            take(payload)
            setError('')
            setSidebarOrder(readSidebarOrder())
            refreshSidebar()
            if (!silent) {
              const rows = payload.available || []
              const free = rows.filter((row) => !row.inGraph)
              const addable = free.filter((row) => row.addable).length
              const done = free.filter((row) => row.stage === 'implemented').length
              const elsewhere = free.filter((row) => row.external && row.stage !== 'implemented').length
              const cells = (payload.nodes || []).filter((n) => n.kind !== 'start').length
              const at = new Date().toLocaleTimeString('zh-CN', { hour12: false })
              setNotice(
                `已刷新 ${at}：可加入 ${addable} 个；已完成待归档 ${done} 个；已在他处进行 ${elsewhere} 个；图里 ${cells} 格`,
              )
            }
          } catch (e) {
            setError(`读不到流水线：${String(e.message || e)}`)
          }
        },
        [take, refreshSidebar],
      )

      // 打开时读一次；切到另一个对话（座位变了）再读一次。
      // 不做轮询 —— 仓库大时那是白烧 I/O。
      useEffect(() => {
        load(true)
      }, [seat, load])

      // Host 推过来的事件：节点状态变了 / 某个 change 刚归档。
      // 收到就静默重读一次服务器事实（有没保存的草稿时不会覆盖草稿），平时不轮询。
      useEffect(() => {
        if (typeof EventSource !== 'function') return undefined
        let source = null
        try {
          source = new EventSource(`${BASE}/events`)
        } catch (error) {
          reportClientError('events', error)
          return undefined
        }
        source.onmessage = (event) => {
          let data = null
          try {
            data = JSON.parse(event.data)
          } catch {
            return
          }
          if (!data || !data.type || data.type === 'hello') return
          if (data.type === 'archived') {
            const where = data.as ? `（archive/${data.as}）` : ''
            setNotice(`已归档：${data.change || data.id || ''}${where}`)
          }
          load(true)
          refreshSidebar()
        }
        // EventSource 自己按 retry(3s) 重连，这里不重建连接、也不刷屏报错。
        return () => {
          try {
            source.close()
          } catch {}
        }
      }, [load, refreshSidebar])

      // 流水线在跑的时候，新对话随时可能被宿主拉起来。每 15 秒让左侧会话列表重读一次，
      // 后续节点（N3…）的对话也能在开始后十几秒内出现，不用手动刷新页面。
      useEffect(() => {
        if (!view?.running) return undefined
        refreshSidebar()
        const timer = setInterval(refreshSidebar, 15000)
        return () => clearInterval(timer)
      }, [view?.running, refreshSidebar])

      // 切工作区：写进插件自己的设置，不跟当前对话走。切完重新读这个仓库的流水线。
      const switchRoot = useCallback(
        async (target) => {
          if (!target || target === view?.root) return
          setBusy(true)
          setError('')
          try {
            const payload = await api(`${BASE}/action`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'root', root: target }),
            })
            clearDirty()
            setEditing(null)
            setMenu(null)
            take(payload)
            setNotice(`工作区切到 ${target}`)
          } catch (e) {
            setError(`切不了工作区：${String(e.message || e)}`)
          } finally {
            setBusy(false)
          }
        },
        [view, take, clearDirty],
      )

      // 宿主刚启动时 llm 适配器可能还没注册完，第一次拿到的运营商列表会是空的。
      // 打开节点设置发现是空的，就补读（最多两次，避免空转）。
      const providerRetry = useRef(0)
      useEffect(() => {
        if (!editing) {
          providerRetry.current = 0
          return
        }
        if ((view?.providers || []).length) return
        if (providerRetry.current >= 2) return
        providerRetry.current += 1
        load(true)
      }, [editing, view, load])

      // 右键菜单开着时，点别处就关掉。
      useEffect(() => {
        if (!menu) return undefined
        const close = () => setMenu(null)
        window.addEventListener('pointerdown', close)
        return () => window.removeEventListener('pointerdown', close)
      }, [menu])

      const editNode = (index, next) => {
              markDirty()
        setDraft((current) => {
          const nodes = current.nodes.slice()
          nodes[index] = next
          return { ...current, nodes }
        })
      }

      // 删一格 = 立刻落盘。右键菜单和卡片上的按钮都走这里。
      const removeNodeNow = async (id) => {
        if (!draft || busy) return
        const next = {
          ...draft,
          nodes: draft.nodes
            .filter((n) => n.id !== id)
            .map((n) => ({ ...n, deps: (n.deps || []).filter((d) => d !== id) })),
        }
        setDraft(next)
        setMenu(null)
        setEditing(null)
        setBusy(true)
        try {
          const payload = await api(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'save', state: next }),
          })
          clearDirty()
          take(payload)
          setNotice(`已经删掉 ${id}`)
          setError('')
        } catch (e) {
          // 流水线在跑时后端会拒绝保存：先留在面板里，停掉之后再保存。
          markDirty()
          setError(`删掉了，但没落盘：${String(e.message || e)}。停掉流水线后点「保存」再写一次。`)
        } finally {
          setBusy(false)
        }
      }

      // 列表里右键「从图里删掉」：按 change 名找节点。
      const removeByChange = (name) => {
        const target = (draft?.nodes || []).find((n) => n.kind !== 'start' && n.change === name)
        if (target) removeNodeNow(target.id)
      }

      // 单击列表 → 加一个孤立节点，并且立刻落盘（跟右键删除保持一致）。
      // 孤立 = deps 为空、不连线；连线由人自己拖。
      const addChange = async (rawName) => {
        const name = String(rawName || '').trim()
        if (!name || !draft || busy) return
        if (draft.nodes.some((n) => n.kind !== 'start' && n.change === name)) return
        const ids = new Set(draft.nodes.map((n) => n.id))
        let id = name.length <= 3 ? name : `N${draft.nodes.length + 1}`
        while (ids.has(id)) id = `${id}2`
        // 新节点直接带上默认组合，面板里能看见它以后会用哪套设置。
        const seed = settingsOf(defaultCombo(draft))
        const next = {
          ...draft,
          nodes: [
            ...draft.nodes,
            {
              id,
              change: name,
              deps: [],
              preset: seed.preset,
              provider: seed.provider,
              model: seed.model,
              effort: seed.effort,
              prompt: seed.prompt,
              approved: '',
              status: 'pending',
              note: '',
              sessionId: '',
            },
          ],
        }
        setDraft(next)
        setBusy(true)
        try {
          const payload = await api(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'save', state: next }),
          })
          clearDirty()
          take(payload)
          setNotice(`加进图了：${name}（孤立节点，自己连线）`)
          setError('')
        } catch (e) {
          markDirty()
          setError(`加进图了，但没落盘：${String(e.message || e)}。停掉流水线后点「保存」再写一次。`)
        } finally {
          setBusy(false)
        }
      }

      // ---------- 设置组合：一套配方 = 对话模式 / 运营商 / 模型 / 强度 / 提示词 ----------

      // 完整配方：套用组合、存组合、批量套用都走这里，提示词一起搬。
      const settingsOf = (source) => ({
        preset: source?.preset || '',
        provider: source?.provider || '',
        model: source?.model || '',
        effort: source?.effort || '',
        prompt: source?.prompt || '',
      })

      // 只搬四样运行设置：「沿用上一个节点」用它，别把上一个 change 专属的口径搬过来。
      const runSettingsOf = (source) => ({
        preset: source?.preset || '',
        provider: source?.provider || '',
        model: source?.model || '',
        effort: source?.effort || '',
      })

      // 当前默认组合。id 失效（组合被删）就当没设。
      const defaultCombo = (source = draft) => {
        const id = String(source?.defaultProfileId || '')
        return id ? (source?.profiles || []).find((combo) => combo.id === id) || null : null
      }

      // 把整套配方刷到若干节点上；连线、位置不动。
      const patchNodes = (ids, source) => {
        const target = new Set(ids)
        if (!target.size || !source) return
        markDirty()
        setDraft((current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.kind !== 'start' && target.has(node.id) ? { ...node, ...settingsOf(source) } : node,
          ),
        }))
      }

      const downstreamOf = (id) => {
        const list = draft?.nodes || []
        const out = new Set()
        const stack = [id]
        while (stack.length) {
          const current = stack.pop()
          for (const node of list) {
            if (out.has(node.id) || !(node.deps || []).includes(current)) continue
            out.add(node.id)
            stack.push(node.id)
          }
        }
        return [...out]
      }

      const saveCombo = async (source, name) => {
        const clean = String(name || '').trim()
        if (!clean || !draft) return
        const combo = { id: `p${Date.now()}`, name: clean, ...settingsOf(source) }
        // 第一次存组合时顺手设为默认，省得再点一次；之后由人自己选。
        const first = !defaultCombo(draft)
        const next = {
          ...draft,
          profiles: [...(draft.profiles || []), combo],
          ...(first ? { defaultProfileId: combo.id } : {}),
        }
        if (await persist(next)) {
          setActiveCombo(combo.id)
          setComboName('')
          setSavingCombo(false)
          setNotice(first ? `存了一个组合：${clean}（已设为默认）` : `存了一个组合：${clean}`)
        }
      }

      // 设为默认 / 取消默认。默认组合会影响「以后新加的节点」和「四样全空的旧节点」。
      const setDefaultCombo = async (id) => {
        if (!draft || !id) return
        const next = {
          ...draft,
          defaultProfileId: draft.defaultProfileId === id ? '' : id,
        }
        if (await persist(next)) {
          setNotice(next.defaultProfileId ? '已设为默认组合：新加的节点会自动带上它' : '取消默认组合了')
        }
      }

      const deleteCombo = async (id) => {
        if (!draft) return
        const next = {
          ...draft,
          profiles: (draft.profiles || []).filter((combo) => combo.id !== id),
          ...(draft.defaultProfileId === id ? { defaultProfileId: '' } : {}),
        }
        if (await persist(next)) {
          setActiveCombo('')
          setNotice(draft.defaultProfileId === id ? '组合删掉了，顺便取消了默认' : '组合删掉了')
        }
      }

      const graphChange = (event) => {
        if (!event) return
        if (event.type === 'move') {
                markDirty()
          setDraft((current) => ({
            ...current,
            nodes: current.nodes.map((n) => (n.id === event.id ? { ...n, x: event.x, y: event.y } : n)),
          }))
          return
        }
        if (event.type === 'connect') {
          const nodes = draft?.nodes || []
          const source = nodes.find((n) => n.id === event.from)
          const target = nodes.find((n) => n.id === event.to)
          if (!source || !target) return
          if (dependsOn(nodes, event.from, event.to)) {
            setNotice(`连不上：${event.to} 已经在（间接）等 ${event.from}，反过来连就成环了`)
            return
          }
          if ((target.deps || []).includes(event.from)) return
                markDirty()
          setDraft((current) => ({
            ...current,
            nodes: current.nodes.map((n) =>
              n.id === event.to ? { ...n, deps: [...(n.deps || []), event.from] } : n,
            ),
          }))
          setNotice(`${event.to} 现在等 ${event.from}`)
          return
        }
        if (event.type === 'disconnect') {
                markDirty()
          setDraft((current) => ({
            ...current,
            nodes: current.nodes.map((n) =>
              n.id === event.to ? { ...n, deps: (n.deps || []).filter((d) => d !== event.from) } : n,
            ),
          }))
        }
      }

      // 存一段明确的 state（不改闭包里的 draft），给「存组合」这类一次性动作复用。
      const persist = async (next) => {
        if (!next) return false
        setDraft(next)
        setBusy(true)
        try {
          const payload = await api(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'save', state: next }),
          })
          clearDirty()
          take(payload)
          setError('')
          return true
        } catch (e) {
          markDirty()
          setError(String(e.message || e))
          return false
        } finally {
          setBusy(false)
        }
      }

      const save = async () => {
        if (!draft) return false
        const ok = await persist(draft)
        if (ok) {
          setNotice(
            running
              ? '存好了：正在跑的格子不受影响，改动只作用在还没开始的格子'
              : '存好了',
          )
        }
        return ok
      }

      const run = async () => {
        if (!draft) return
        setBusy(true)
        try {
          // 开跑前总是存一次：把没保存的位置/连线一并写掉。
          // 不在这里盖批准时间：点「开始」只是放行，哪一格真正开工才由 Host 记哪一格的时间。
          await api(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'save', state: draft }),
          })
          clearDirty()
          const payload = await api(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'run' }),
          })
          take(payload)
          setNotice(
            '开跑了。新对话开在插件自己的工作区分组里，面板下面有「打开这个对话」。' +
              '左栏看不到就把排序切成「最近更新」——手动排序会把新对话排到分组末尾。',
          )
          setError('')
          refreshSidebar()
          // 只补几次，不轮询：等宿主把新对话的 sessionId 写进状态，
          // 好把「打开这个对话」和「跑着」露出来；顺带让左侧列表再读一次。
          for (const delay of [800, 2500, 6000]) {
            window.setTimeout(() => {
              load(true)
              refreshSidebar()
            }, delay)
          }
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const stop = async () => {
        setBusy(true)
        try {
          const payload = await api(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          })
          take(payload)
          setNotice('已停。已经拉起的对话不会强杀，后面的不再开工。')
          setError('')
          window.setTimeout(() => {
            load(true)
          }, 500)
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      // 手动归档：先 validate --strict，再 archive。两步都是 openspec 自己的命令，
      // 在 Host 里跑；面板只负责把结果摆出来。
      // 验证没过不直接归 —— 把每条问题摊开（可复制给那个对话去改），
      // 人要往下走才点「仍然归档」。插件不替人做这个决定。
      const doArchive = async (nodeId, force) => {
        setArchiveBusy(nodeId)
        setError('')
        try {
          const payload = await apiRaw(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'archive', nodeId, force }),
          })
          if (payload.needsConfirm) {
            setArchiveAsk({
              nodeId,
              kind: 'validate',
              report: String(payload.report || ''),
              text: String(payload.text || ''),
            })
            setNotice('openspec validate --strict 没过。问题在下面，可以复制给那个对话去改；改不动又必须往下走，就点「仍然归档」。')
            return
          }
          if (payload.ok === false) {
            setArchiveAsk({
              nodeId,
              kind: 'error',
              report: String(payload.report || ''),
              text: String(payload.error || '归档失败'),
            })
            setError(String(payload.error || '归档失败'))
            return
          }
          setArchiveAsk(null)
          take(payload)
          setNotice(String(payload.text || '归档完成'))
          window.setTimeout(() => load(true), 600)
        } catch (e) {
          setError(`归档失败：${String(e.message || e)}`)
        } finally {
          setArchiveBusy('')
        }
      }

      const copyReport = async (text) => {
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            setNotice('问题已复制，可以直接粘给那个对话。')
            return
          }
        } catch {}
        setNotice('浏览器不让复制，手动选中下面那段文字吧。')
      }

      // 打开这一格自己的对话。会话是宿主建的普通会话，一直都在；
      // 面板按 sessionId 直接打开，不经过左栏的排序。左栏看不到时先让列表重读一次。
      const openNodeSession = (id) => {
        if (!id) return
        try {
          refreshSidebar()
          const workspace = clientContext?.get?.('uiWorkspace') || clientContext?.uiWorkspace
          if (workspace && typeof workspace.openSession === 'function') {
            workspace.openSession(id)
            return
          }
        } catch (error) {
          reportClientError('openSession', error)
        }
        setNotice(`这一格的会话是 ${id}，但当前客户端打不开；在左侧搜索会话标题，或把左栏排序切成「最近更新」。`)
      }

      if (!draft) {
        return h('div', { style: styles.root }, h('div', { style: styles.dim }, error || '正在读流水线…'))
      }

      const nodes = draft.nodes || []
      const viewNodes = new Map((view?.nodes || []).map((n) => [n.id, n]))
      const REPO_FIELDS = [
        'exists',
        'archived',
        'missing',
        'external',
        'activeMinutes',
        'archivedAs',
        'taskDone',
        'taskTotal',
        'hasTasks',
        // openspec list --json 给的官方状态：complete / in-progress / no-tasks
        'cliStatus',
        // openspec status --all --json 给的规划进度（done/total/missing/next）
        'planning',
        // 状态和说明是「服务器事实」：草稿里那份只是上次保存时的副本，
        // 拿它画图会出现「文件里是等你、画布上写失败」这种鬼话。
        'status',
        'note',
        'sessionId',
        'updatedAt',
      ]
      const repoOf = (id) => {
        const found = viewNodes.get(id)
        const out = {}
        if (found) for (const key of REPO_FIELDS) out[key] = found[key]
        return out
      }
      const graphNodes = nodes.map((n) => ({ ...n, ...repoOf(n.id) }))
      const available = [...(view?.available || [])].sort(
        (a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9),
      )
      const running = Boolean(view?.running)
      const changeNodes = (view?.nodes || []).filter((n) => n.kind !== 'start')
      const doneCount = changeNodes.filter((n) => n.status === 'done').length
      // 需要人看一眼的格子：失败 / 等你。把原因带出来，不然画布上只有两个字。
      const attention = graphNodes.filter(
        (node) => node.kind !== 'start' && (node.status === 'failed' || node.status === 'needs_human'),
      )
      // 已经拉起过对话的格子。新对话是宿主直接建的，左侧列表不一定马上列出来，
      // 所以这里给一条明确的入口：点一下就把那个对话切到主视图。
      const withSession = graphNodes
        .filter((node) => node.kind !== 'start' && node.sessionId)
        .sort((left, right) => {
          const rank = (node) => (node.status === 'running' ? 0 : node.status === 'done' ? 2 : 1)
          return rank(left) - rank(right)
        })
        .slice(0, 4)

      const agoText = (minutes) => {
        if (minutes === null || minutes === undefined) return '刚刚还有改动'
        if (minutes <= 0) return '刚刚还在改'
        if (minutes < 60) return `${minutes} 分钟前改过`
        return `${Math.round(minutes / 60)} 小时前改过`
      }
      const rowHint = (row) => {
        if (row.external && row.stage !== 'implemented') return `${agoText(row.activeMinutes)}，已在他处进行`
        return changeState(row).text
      }
      const editingIndex = editing ? nodes.findIndex((n) => n.id === editing) : -1
      const editingNode = editingIndex >= 0 ? nodes[editingIndex] : null
      const editingRepo = editingNode ? repoOf(editingNode.id) : {}
      const profiles = draft.profiles || []
      const previousNode =
        editingNode && (editingNode.deps || []).length === 1 && editingNode.deps[0] !== 'start'
          ? nodes.find((node) => node.id === editingNode.deps[0]) || null
          : null
      const providerRow = editingNode
        ? (view?.providers || []).find((provider) => provider.id === (editingNode.provider || ''))
        : undefined
      const menuPosition = (value) => ({
        left: Math.min(value.x, 440),
        top: value.maxY ? Math.max(6, Math.min(value.y, value.maxY - 160)) : value.y,
      })

      // 工作区下拉：只列真的含 openspec 的工作区。当前仓库没登记过时，把它自己补成一项。
      const workspaceOptions = (view?.workspaces || []).filter((workspace) => workspace.hasOpenspec)
      const currentRoot = view?.root || ''
      const currentWorkspace = workspaceOptions.find((workspace) => workspace.path === currentRoot)
      const tailName = (value) => String(value || '').split(/[\\/]/).filter(Boolean).pop() || String(value || '')
      const selectableWorkspaces =
        !currentRoot || currentWorkspace
          ? workspaceOptions
          : [
              { id: '__current', title: short(tailName(currentRoot), 24), path: currentRoot, hasOpenspec: true },
              ...workspaceOptions,
            ]
      const workspaceLabel = currentWorkspace?.title || (currentRoot ? short(tailName(currentRoot), 24) : '没选工作区')

      return h(
        'div',
        { style: styles.root, className: 'dsh-osp' },
        h(
          'style',
          null,
          '.dsh-osp button:disabled{opacity:.45;cursor:default}.dsh-osp .dsh-osp-row:hover{background:var(--dsw-alias-bg-layer-2)}',
        ),
        // 顶栏：只留版本号和按钮
        h(
          'div',
          { style: styles.bar },
          h('h1', { style: styles.title }, '变更流水线'),
          h('span', { style: { ...styles.dim, fontSize: 11 } }, `v${BUILD}`),
          h(
            'select',
            {
              value: currentRoot,
              disabled: busy || running || !selectableWorkspaces.length,
              title: '插件自己的工作区。选过之后，不管你从哪个对话打开面板，都以它为准。',
              style: { ...styles.input, maxWidth: 210, height: 28 },
              onChange: (event) => switchRoot(event.target.value),
            },
            selectableWorkspaces.length
              ? selectableWorkspaces.map((workspace) =>
                  h('option', { key: workspace.id, value: workspace.path }, workspace.title || workspace.path),
                )
              : h('option', { value: '' }, '没有可选的工作区'),
          ),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              style: running ? styles.primary : styles.button,
              onClick: () => load(false),
              disabled: busy,
            },
            running ? '刷新进度' : '刷新',
          ),
          h(
            'button',
            {
              type: 'button',
              style: dirtyShown ? styles.primary : styles.button,
              onClick: save,
              disabled: busy,
            },
            dirtyShown ? '保存 •' : '保存',
          ),
          h(
            'button',
            { type: 'button', style: styles.primary, onClick: run, disabled: busy || running },
            running ? '正在跑' : '开始',
          ),
          h('button', { type: 'button', style: styles.button, onClick: stop, disabled: busy || !running }, '停止'),
          h(
            'button',
            {
              type: 'button',
              style: styles.ghost,
              title: '并行上限 / 跑到哪停 / 默认组合 / 工作区',
              onClick: () => {
                setShowSettings((value) => !value)
                setRootInput(view?.root || '')
              },
            },
            '⋯',
          ),
        ),
        view && view.capabilities && view.capabilities.topLevel === false
          ? h(
              'div',
              { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 6, fontSize: 12 } },
              '这台宿主没有顶层对话接口（sessionController）：点「开始」会直接报错，先别跑。',
            )
          : null,
        sidebarOrder === 'manual'
          ? h(
              'div',
              { style: { ...styles.dim, marginTop: 6, fontSize: 12 } },
              '左栏现在是「手动排序」：新对话会排到分组末尾，可能看不到。把左栏排序切成「最近更新」就能看见。',
            )
          : null,
        showSettings
          ? h(
              'div',
              { style: { ...styles.row, gap: 14, marginTop: 8 } },
              h(
                Field,
                { label: '并行上限' },
                h('input', {
                  type: 'number',
                  min: 1,
                  max: 4,
                  style: { ...styles.input, width: 72 },
                  value: draft.maxParallel || 1,
                  onChange: (e) => {
                    markDirty()
                    setDraft({ ...draft, maxParallel: Number(e.target.value) || 1 })
                  },
                }),
              ),
              h(
                Field,
                { label: '跑到哪停' },
                h(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(draft.pauseAfterNode),
                    onChange: (e) => {
                      markDirty()
                      setDraft({ ...draft, pauseAfterNode: e.target.checked })
                    },
                  }),
                  '跑完当前这一格就停，后面的不动',
                ),
              ),
              h(
                Field,
                { label: '默认组合' },
                h(
                  'select',
                  {
                    style: { ...styles.input, width: 180 },
                    value: draft.defaultProfileId || '',
                    title: '新加的节点连提示词一起带上；节点四样全空时开跑用它（提示词仍取节点的）。保存后生效。',
                    onChange: (e) => {
                      markDirty()
                      setDraft({ ...draft, defaultProfileId: e.target.value })
                    },
                  },
                  h('option', { value: '' }, '没设（节点各自选）'),
                  (draft.profiles || []).map((combo) =>
                    h('option', { key: combo.id, value: combo.id }, combo.name),
                  ),
                ),
              ),
              h(
                Field,
                { label: '工作区路径' },
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('input', {
                    style: { ...styles.input, width: 280 },
                    value: rootInput,
                    placeholder: 'F:\\project\\agent-forge',
                    onChange: (e) => setRootInput(e.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: styles.button,
                      disabled: busy || running || !String(rootInput || '').trim(),
                      onClick: () => switchRoot(String(rootInput || '').trim()),
                    },
                    '切到',
                  ),
                ),
              ),
              h('span', { style: { ...styles.dim, wordBreak: 'break-all' } }, `工作区：${workspaceLabel}（${view?.root || '读不到'}）`),
            )
          : null,
        error
          ? h(
              'div',
              { style: { color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', marginTop: 6 } },
              error,
            )
          : null,
        notice ? h('div', { style: { ...styles.dim, marginTop: 6 } }, notice) : null,
        // 任务进度现在是从 openspec list --json 读的。读不到就说清楚，别让人以为
        // 面板上的数字是新鲜的 —— 这时候它退回自己数 tasks.md。
        view?.cli && view.cli.ok === false
          ? h(
              'div',
              { style: { ...styles.dim, marginTop: 4, color: 'var(--dsw-alias-state-warn-primary)' } },
              `读不到 openspec 命令，任务进度退回自己数 tasks.md：${view.cli.error || ''}`,
            )
          : null,
        view?.cli?.planning && view.cli.planning.ok === false
          ? h(
              'div',
              { style: { ...styles.dim, marginTop: 2, color: 'var(--dsw-alias-state-warn-primary)' } },
              `规划进度读不到（openspec status）：${view.cli.planning.error || ''}`,
            )
          : null,
        // 画布是草稿、服务器那边已经变了：说清楚，并给一个「以服务器为准」的出口。
        serverDiff
          ? h(
              'div',
              {
                style: {
                  marginTop: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  fontSize: 12,
                  color: 'var(--dsw-alias-state-warn-primary)',
                },
              },
              '服务器上这张图变了（多了/少了格子或连线），你这边有没保存的改动，所以画布还是你的草稿。',
              h(
                'button',
                {
                  type: 'button',
                  style: { ...styles.button, height: 24, padding: '0 10px' },
                  onClick: () => {
                    clearDirty()
                    setDraft(view?.state || null)
                    setServerDiff(false)
                    setNotice('已按服务器上的图重画，未保存的草稿丢了')
                  },
                },
                '以服务器为准',
              ),
            )
          : null,
        // 已经开了对话的格子：给一条「打开」入口。对话开在插件自己的工作区里，
        // 左侧列表如果还没把它列出来（或者它排在别的工作区分组下面），从这里一定能进去。
        withSession.length
          ? h(
              'div',
              { style: { marginTop: 8, display: 'grid', gap: 3, fontSize: 12 } },
              h(
                'div',
                { style: styles.dim },
                `这些格子的对话都在工作区「${workspaceLabel}」里：`,
              ),
              withSession.map((node) =>
                h(
                  'div',
                  { key: node.id, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h(
                    'span',
                    { style: { color: statusColor(node.status), fontWeight: 600 } },
                    `${node.id} · ${STATUS_TEXT[node.status] || node.status || '未知'}`,
                  ),
                  h('span', { style: { ...styles.dim, fontSize: 11 } }, node.change || ''),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: { ...styles.button, height: 24, padding: '0 10px' },
                      onClick: () => openNodeSession(node.sessionId),
                    },
                    '打开这个对话',
                  ),
                ),
              ),
            )
          : null,
        // 需要人处理的格子：写清「仓库里走到哪」+ 原因，并给一个手动归档的入口。
        // 归档只在这些格子出现：这一轮已经停了（失败 / 等你），对话不会自己再去归档。
        attention.length
          ? h(
              'div',
              { style: { marginTop: 8, display: 'grid', gap: 4 } },
              attention.map((node) => {
                const task = changeState(node)
                const canArchive = node.exists !== false && !node.archived
                return h(
                  'div',
                  {
                    key: node.id,
                    style: {
                      fontSize: 12,
                      lineHeight: 1.4,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        color:
                          node.status === 'failed'
                            ? 'var(--dsw-alias-state-error-primary)'
                            : 'var(--dsw-alias-state-warn-primary)',
                        fontWeight: 600,
                      },
                    },
                    `${node.id} ${STATUS_TEXT[node.status] || node.status}`,
                  ),
                  h('span', { style: styles.dim }, `${node.change || ''} · ${task.text}`),
                  h('span', { style: styles.dim }, `· ${(node.note || '没有说明').split('\n')[0]}`),
                  canArchive
                    ? h(
                        'button',
                        {
                          type: 'button',
                          title: '先跑 openspec validate <change> --strict；过了再跑 openspec archive <change> -y',
                          style: { ...styles.button, height: 24, padding: '0 10px' },
                          disabled: archiveBusy === node.id,
                          onClick: () => doArchive(node.id, false),
                        },
                        archiveBusy === node.id ? '归档中…' : '归档',
                      )
                    : null,
                )
              }),
            )
          : null,
        // validate 没过 / 归档失败：把原话摊开，能复制，能决定要不要硬归。
        archiveAsk
          ? h(
              'div',
              {
                style: {
                  marginTop: 8,
                  padding: '8px 10px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 10,
                  background: 'var(--dsw-alias-bg-layer-1)',
                  maxWidth: 660,
                },
              },
              h(
                'div',
                {
                  style: {
                    fontSize: 12,
                    fontWeight: 600,
                    color:
                      archiveAsk.kind === 'validate'
                        ? 'var(--dsw-alias-state-warn-primary)'
                        : 'var(--dsw-alias-state-error-primary)',
                  },
                },
                archiveAsk.text || '归档没成',
              ),
              archiveAsk.report
                ? h(
                    'pre',
                    {
                      style: {
                        margin: '6px 0 0',
                        padding: 8,
                        maxHeight: 190,
                        overflow: 'auto',
                        background: 'var(--dsw-alias-bg-base)',
                        borderRadius: 8,
                        fontSize: 11.5,
                        lineHeight: 1.45,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      },
                    },
                    archiveAsk.report,
                  )
                : null,
              h(
                'div',
                { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                archiveAsk.report
                  ? h(
                      'button',
                      { type: 'button', style: { ...styles.button, height: 26 }, onClick: () => copyReport(archiveAsk.report) },
                      '复制问题',
                    )
                  : null,
                archiveAsk.kind === 'validate'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: {
                          ...styles.button,
                          height: 26,
                          borderColor: 'var(--dsw-alias-state-warn-primary)',
                        },
                        disabled: archiveBusy === archiveAsk.nodeId,
                        onClick: () => doArchive(archiveAsk.nodeId, true),
                      },
                      archiveBusy === archiveAsk.nodeId ? '归档中…' : '仍然归档',
                    )
                  : null,
                h(
                  'button',
                  { type: 'button', style: { ...styles.button, height: 26 }, onClick: () => setArchiveAsk(null) },
                  '关闭',
                ),
              ),
            )
          : null,
        // 画布：正方形，滚轮缩放，拖空白平移，双击节点打开设置
        h(
          'div',
          { style: styles.board, onContextMenu: (event) => event.preventDefault() },
          h(Graph, {
            nodes: graphNodes,
            onChange: graphChange,
            onOpen: (id) => setEditing(id),
            onContextMenu: (id, point) => setMenu({ id, x: point.x, y: point.y, maxY: point.maxY }),
          }),
          h('div', { style: styles.hint }, '滚轮缩放 · 拖空白平移 · 双击节点设置 · 右键删除'),
          menu
            ? h(
                'div',
                {
                  style: { ...styles.menu, ...menuPosition(menu) },
                  onPointerDown: (event) => event.stopPropagation(),
                },
                h('div', { style: { ...styles.dim, padding: '2px 6px' } }, `节点 ${menu.id}`),
                (() => {
                  const found = graphNodes.find((n) => n.id === menu.id)
                  const why = found?.archived
                    ? '已归档'
                    : found?.missing
                      ? '仓库里已找不到'
                      : found?.external
                        ? `已在他处进行（${agoText(found.activeMinutes)}）`
                        : ''
                  return why
                    ? h(
                        'div',
                        {
                          style: {
                            ...styles.dim,
                            padding: '2px 6px',
                            color: 'var(--dsw-alias-state-error-primary)',
                          },
                        },
                        why,
                      )
                    : null
                })(),
                h(
                  'button',
                  { type: 'button', style: styles.button, onClick: () => removeNodeNow(menu.id) },
                  '从图里删掉这一格',
                ),
                h('button', { type: 'button', style: styles.button, onClick: () => setMenu(null) }, '取消'),
              )
            : null,
        ),
        // 未归档的 change：单击进图（孤立节点），右键从图里删掉
        h(
          'div',
          { style: styles.list },
          h(
            'div',
            { style: styles.dim },
            available.length
              ? `未归档的 change：${available.length} 个 · 单击加进图（孤立节点，自己连线）· 已在图里的右键删掉`
              : '仓库里没有未归档的 change',
          ),
          available.map((row) => {
            const warn = row.external && row.stage !== 'implemented'
            return h(
              'div',
              {
                key: row.name,
                className: 'dsh-osp-row',
                style: { ...styles.item, ...(row.inGraph ? styles.itemIn : null) },
                title: row.inGraph ? '已经在图里。右键从图里删掉' : '单击加进图；加进来是孤立的，自己连线',
                onClick: () => {
                  if (!row.inGraph) addChange(row.name)
                },
                onContextMenu: (event) => {
                  event.preventDefault()
                  if (row.inGraph) removeByChange(row.name)
                },
              },
              h('span', { style: styles.name }, row.name),
              h('span', { style: { flex: 1 } }),
              warn
                ? h(
                    'span',
                    { style: { ...styles.badge, color: 'var(--dsw-alias-state-error-primary)' } },
                    `他处进行 · ${agoText(row.activeMinutes)}`,
                  )
                : null,
              // 规划没写完：黄色徽章 + 鼠标停上去看下一步该写哪件、该跑哪条命令。
              row.planning && row.planning.complete === false
                ? h(
                    'span',
                    {
                      style: { ...styles.badge, color: 'var(--dsw-alias-state-warn-primary)' },
                      title: [
                        `还差：${(row.planning.missing || []).join('、') || '—'}`,
                        row.planning.next ? `下一步：${row.planning.next}` : '',
                      ]
                        .filter(Boolean)
                        .join('\n'),
                    },
                    `规划 ${row.planning.done}/${row.planning.total}`,
                  )
                : null,
              h('span', { style: { ...styles.dim, fontSize: 11.5 } }, rowHint(row)),
              row.inGraph
                ? h('span', { style: { ...styles.badge, color: 'var(--dsw-alias-brand-primary)' } }, '已在图里')
                : null,
            )
          }),
        ),
        // 双击节点弹出来的设置
        editingNode
          ? h(
              'div',
              { style: styles.overlay, onPointerDown: () => setEditing(null) },
              h(
                'div',
                { style: styles.dialog, onPointerDown: (event) => event.stopPropagation() },
                h(
                  'div',
                  { style: { ...styles.row, gap: 8 } },
                  h('strong', null, `节点 ${editingNode.id}`),
                  h('span', { style: { ...styles.dim, wordBreak: 'break-all' } }, editingNode.change),
                  h('span', { style: { flex: 1 } }),
                  editingRepo.archived
                    ? h('span', { style: { ...styles.badge, color: 'var(--dsw-alias-state-error-primary)' } }, '已归档')
                    : editingRepo.missing
                      ? h(
                          'span',
                          { style: { ...styles.badge, color: 'var(--dsw-alias-state-error-primary)' } },
                          '已找不到',
                        )
                      : editingRepo.external
                        ? h(
                            'span',
                            { style: { ...styles.badge, color: 'var(--dsw-alias-state-error-primary)' } },
                            '已在他处进行',
                          )
                        : null,
                ),
                // 一套设置反复用：选组合 / 存组合 / 套给它下游或全部
                h(
                  'div',
                  {
                    style: {
                      display: 'grid',
                      gap: 8,
                      padding: '8px 10px',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: 8,
                      background: 'var(--dsw-alias-bg-layer-1)',
                    },
                  },
                  h(
                    'div',
                    { style: { ...styles.row, gap: 6 } },
                    h('span', { style: styles.label }, '设置组合'),
                    h(
                      'select',
                      {
                        style: { ...styles.input, flex: 1, minWidth: 140 },
                        value: activeCombo,
                        onChange: (event) => {
                          const id = event.target.value
                          setActiveCombo(id)
                          const combo = profiles.find((item) => item.id === id)
                          if (combo) editNode(editingIndex, { ...editingNode, ...settingsOf(combo) })
                        },
                      },
                      h('option', { value: '' }, '选一个存好的组合…'),
                      profiles.map((combo) =>
                        h(
                          'option',
                          { key: combo.id, value: combo.id },
                          `${combo.id === draft.defaultProfileId ? '★ ' : ''}${combo.name}`,
                        ),
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.button,
                        onClick: () => setSavingCombo((value) => !value),
                      },
                      '存为组合',
                    ),
                    activeCombo
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: styles.button,
                            disabled: busy,
                            title: '默认组合：以后新加的节点自动带上它（含提示词）；四样全空的旧节点开跑也用它',
                            onClick: () => setDefaultCombo(activeCombo),
                          },
                          activeCombo === draft.defaultProfileId ? '取消默认' : '设为默认',
                        )
                      : null,
                    activeCombo
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: { ...styles.ghost, fontSize: 12 },
                            onClick: () => deleteCombo(activeCombo),
                          },
                          '删掉组合',
                        )
                      : null,
                  ),
                  savingCombo
                    ? h(
                        'div',
                        { style: { ...styles.row, gap: 6 } },
                        h('input', {
                          style: { ...styles.input, flex: 1 },
                          value: comboName,
                          placeholder: '给这套设置起个名字，比如「flash 快速档」',
                          onChange: (event) => setComboName(event.target.value),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') saveCombo(editingNode, comboName)
                          },
                        }),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: styles.primary,
                            disabled: !comboName.trim() || busy,
                            onClick: () => saveCombo(editingNode, comboName),
                          },
                          '存下来',
                        ),
                        h(
                          'button',
                          { type: 'button', style: styles.button, onClick: () => setSavingCombo(false) },
                          '取消',
                        ),
                      )
                    : null,
                  h(
                    'div',
                    { style: { ...styles.row, gap: 6 } },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.button,
                        disabled: !defaultCombo(draft),
                        title: defaultCombo(draft) ? `把「${defaultCombo(draft).name}」套到这一格` : '还没有默认组合',
                        onClick: () => {
                          const combo = defaultCombo(draft)
                          if (combo) editNode(editingIndex, { ...editingNode, ...settingsOf(combo) })
                        },
                      },
                      '用默认',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.button,
                        disabled: !previousNode,
                        title: previousNode ? `从 ${previousNode.id} 复制四样运行设置（不带提示词）` : '这一格不是只等一个节点',
                        onClick: () => {
                          if (previousNode) editNode(editingIndex, { ...editingNode, ...runSettingsOf(previousNode) })
                        },
                      },
                      '沿用上一个节点',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.button,
                        onClick: () => patchNodes(downstreamOf(editingNode.id), editingNode),
                      },
                      '套用到下游全部',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.button,
                        onClick: () =>
                          patchNodes(
                            nodes.filter((node) => node.kind !== 'start').map((node) => node.id),
                            editingNode,
                          ),
                      },
                      '套用到所有节点',
                    ),
                  ),
                  h(
                    'div',
                    { style: styles.dim },
                    '组合记五项：对话模式、运营商、模型、思考强度、附加提示词。选组合 / 套用会连提示词一起换（组合里没写就清空）；连线、位置不动。',
                  ),
                  h(
                    'div',
                    { style: styles.dim },
                    defaultCombo(draft)
                      ? `默认组合：${defaultCombo(draft).name}。新加的节点连提示词一起带上它；节点四样全留空时，开跑用它（提示词仍取节点自己的）。`
                      : '还没有默认组合。选中一个组合点「设为默认」，以后新加的节点就会自动带上（含提示词）。',
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
                  h(
                    Field,
                    { label: '对话模式（预置）' },
                    h(
                      'select',
                      {
                        style: styles.input,
                        value: editingNode.preset || '',
                        onChange: (e) => editNode(editingIndex, { ...editingNode, preset: e.target.value }),
                      },
                      h('option', { value: '' }, '跟随当前对话'),
                      (view?.presets || []).map((preset) =>
                        h('option', { key: preset.id, value: preset.id }, preset.name || preset.id),
                      ),
                    ),
                  ),
                  h(
                    Field,
                    { label: '运营商' },
                    h(
                      'select',
                      {
                        style: styles.input,
                        value: editingNode.provider || '',
                        onChange: (e) =>
                          editNode(editingIndex, {
                            ...editingNode,
                            provider: e.target.value,
                            model: '',
                            effort: '',
                          }),
                      },
                      h('option', { value: '' }, '跟随当前对话'),
                      (view?.providers || []).map((provider) =>
                        h('option', { key: provider.id, value: provider.id }, `${provider.name}（${provider.id}）`),
                      ),
                    ),
                  ),
                  h(
                    Field,
                    { label: '模型' },
                    h(
                      'select',
                      {
                        style: styles.input,
                        value: editingNode.model || '',
                        disabled: !editingNode.provider,
                        onChange: (e) =>
                          editNode(editingIndex, { ...editingNode, model: e.target.value, effort: '' }),
                      },
                      h(
                        'option',
                        { value: '' },
                        editingNode.provider ? '跟随该运营商的默认模型' : '先选运营商',
                      ),
                      (providerRow?.models || []).map((model) =>
                        h('option', { key: model.id, value: model.id }, `${model.name}（${model.id}）`),
                      ),
                    ),
                  ),
                  h(
                    Field,
                    { label: '思考强度' },
                    h(
                      'div',
                      { style: { display: 'grid', gap: 2 } },
                      h(
                        'select',
                        {
                          style: styles.input,
                          value: editingNode.effort || '',
                          onChange: (e) => editNode(editingIndex, { ...editingNode, effort: e.target.value }),
                        },
                        h('option', { value: '' }, '跟随模型默认'),
                        modelInfo
                          ? (modelInfo.efforts || []).map((effort) =>
                              h('option', { key: effort.id, value: effort.id }, effort.name || effort.id),
                            )
                          : EFFORTS.filter(Boolean).map((value) => h('option', { key: value, value }, value)),
                      ),
                      modelInfo && !(modelInfo.efforts || []).length
                        ? h('span', { style: styles.dim }, '这个模型不支持思考强度')
                        : null,
                    ),
                  ),
                  h(
                    Field,
                    { label: '仓库里的任务' },
                    h(
                      'span',
                      { style: { ...styles.dim, paddingTop: 4 } },
                      editingRepo.hasTasks ? `${editingRepo.taskDone}/${editingRepo.taskTotal} 已勾` : '没有 tasks.md',
                    ),
                  ),
                ),
                h(
                  Field,
                  { label: `附加提示词（接在「执行 ${editingNode.change || 'xxx'} Change」后面）` },
                  h('textarea', {
                    style: styles.textarea,
                    value: editingNode.prompt || '',
                    placeholder: '不写就只发「执行 xxx Change」这一句，它不会归档，流水线会停在这一格。归档和验收口径都写在这里。',
                    onChange: (e) => editNode(editingIndex, { ...editingNode, prompt: e.target.value }),
                  }),
                  h(
                    'span',
                    { style: { ...styles.dim, fontSize: 11 } },
                    '这一轮结束后 change 必须已经在 archive/ 里才算完成；没归档会停在「等你」，后面的不动。',
                  ),
                ),
                h(
                  'div',
                  { style: { ...styles.row, gap: 8 } },
                  editingNode.sessionId
                    ? h(
                        'button',
                        {
                          type: 'button',
                          style: styles.button,
                          title: '打开这一格自己的对话，接着聊 / 看它的报告',
                          onClick: () => openNodeSession(editingNode.sessionId),
                        },
                        '打开这一格的对话',
                      )
                    : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      style: { ...styles.button, color: 'var(--dsw-alias-state-error-primary)' },
                      onClick: () => removeNodeNow(editingNode.id),
                    },
                    '删掉这个节点',
                  ),
                  h('span', { style: { flex: 1 } }),
                  h('button', { type: 'button', style: styles.button, onClick: () => setEditing(null) }, '关闭'),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: styles.primary,
                      disabled: busy || running,
                      onClick: async () => {
                        const saved = await save()
                        if (saved) setEditing(null)
                      },
                    },
                    '保存',
                  ),
                ),
              ),
            )
          : null,
      )
    }

    // 座位（当前对话）只作为刷新信号传下去；读哪个仓库由 Host 决定，与座位无关。
    function PipelineTab({ scope } = {}) {
      return h(Panel, { scope })
    }

    // ---------- 挂载：每条注册单独兜住，异常只上报，绝不逃出 apply ----------

    function mount(ctx) {
      try {
        clientContext = ctx
      } catch {
        clientContext = null
      }
      const stops = []
      const keep = (value) => {
        if (typeof value === 'function') stops.push(value)
      }

      // 座位 1/2：左侧面板图标 + 中央主面板。
      // slots.inject 的声明回调也要兜住：某些时序下它会在别的插件声明 slot 时被同步调用，
      // 那里抛出去同样算在我们这个 entry 头上。
      const slot = (name, options, component) => {
        if (!ctx?.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
          reportClientError(`slot:${name}`, new Error('客户端没有可用的 slots 服务'))
          return
        }
        try {
          keep(
            ctx.slots.inject(name, () => {
              try {
                keep(ctx.slots.register(options, component))
              } catch (error) {
                reportClientError(`register:${name}`, error)
              }
            }),
          )
        } catch (error) {
          reportClientError(`inject:${name}`, error)
        }
      }

      slot(
        'sidebar.panellist',
        { name: 'sidebar.panellist', id: 'openspec-pipeline', order: 30, label: () => '变更流水线' },
        Icon,
      )
      slot('main', { name: 'main', key: 'openspec-pipeline' }, Panel)

      // 座位 3（可选）：右侧栏页签。只有装了 dsh-better-sidebar、且它的 client 半身
      // 真的挂上了才有这个服务。不用 ctx.inject 去等 —— 那会建一个等不到服务的子 fiber，
      // 失败会牵连本 entry。改成有限次轮询，拿不到就算了。
      let stopped = false
      let tries = 0
      const findSidebar = () => {
        try {
          return ctx?.get?.('betterSidebar') || ctx?.betterSidebar
        } catch {
          return undefined
        }
      }
      const tryTab = () => {
        if (stopped) return
        const sidebar = findSidebar()
        if (sidebar && typeof sidebar.registerTab === 'function') {
          stopped = true
          try {
            keep(
              sidebar.registerTab({
                id: 'openspec-pipeline',
                title: () => '变更流水线',
                description: () => '把多个 change 排成图，按顺序或并行开新对话执行；没有提示词就只发「执行 xxx Change」。',
                icon: (size) => h(Icon, { size }),
                order: 40,
                single: true,
                component: PipelineTab,
              }),
            )
          } catch (error) {
            reportClientError('betterSidebar.registerTab', error)
          }
          return
        }
        tries += 1
        if (tries >= 20) return
        window.setTimeout(tryTab, 750)
      }
      window.setTimeout(tryTab, 700)

      return () => {
        stopped = true
        for (const stop of stops.splice(0)) {
          try {
            stop()
          } catch {}
        }
      }
    }

    return { inject: ['slots'], apply: mount }
  }
})()
