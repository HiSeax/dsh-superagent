/** The iframe body: renders the board server's roster rows and tickets, and runs ticket actions. */

const GROUPS = [
  { key: 'active', label: '进行中', states: ['new', 'evaluating', 'executing'] },
  { key: 'manual', label: '待人工', states: ['review', 'blocked'] },
  { key: 'ended', label: '已结束', states: ['done', 'failed', 'stopped'] },
]
const bucketOf = state => GROUPS.find(group => group.states.includes(state))?.key ?? 'ended'
const AVATAR_TONES = ['blue', 'violet', 'teal', 'orange', 'rose', 'sky']
const toneOf = id => AVATAR_TONES[Array.from(String(id)).reduce((sum, ch) => sum + ch.codePointAt(0), 0) % AVATAR_TONES.length]
const initialOf = name => Array.from(String(name ?? '?').trim())[0] ?? '?'
const STATE_WORD = {
  new: '新建', evaluating: '评估中', executing: '执行中', review: '待审', done: '完成',
  blocked: '阻塞', failed: '失败', stopped: '已停止', working: '运行中', idle: '空闲',
  unknown: '未知', provisioning: '准备中', stored: '未启动',
}
const ACTIVE_STATES = new Set(['new', 'evaluating', 'executing'])
const ENDED_STATES = new Set(['done', 'failed', 'stopped'])
const ACTION_LABEL = { stop: '停止', retry: '重试' }
const ACTION_TITLE = {
  stop: '停止这个工单：当前派工结束',
  retry: '重试这个已结束的工单',
}

let board = null
let aliases = {}
let sourceDown = false
let degradedStreak = 0
let boardRequest = 0
let teamRequest = 0
let teamPolling = false
let roster = []
let temporaryWorkers = []
// Temporary animation previews: ?temp-preview=a|b|c. No parameter leaves cards static.
const TEMP_PREVIEW = new URLSearchParams(location.search).get('temp-preview')
if (TEMP_PREVIEW) document.documentElement.dataset.tempPreview = TEMP_PREVIEW
let main = null
let teamDown = false
let selectedId = null
let resultOpen = false
let refreshing = false
let booted = false
let lastUpdated = null
let renameTarget = null
let deleteTarget = null
let toastTimer = null
const actionState = new Map()
const actionTimers = new Map()

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))
const formatTime = value => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value ?? '—')
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const relativeTime = value => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value ?? '—')
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.floor(hours / 24)
  if (days < 30) return days + ' 天前'
  return formatTime(value)
}
const pad2 = value => String(value).padStart(2, '0')
const clockOf = date => pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
const clockOfValue = value => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : clockOf(date)
}
const statusWord = state => STATE_WORD[state] ?? state ?? '未知'
const memberRows = () => roster.map(member => ({ ...member, displayName: aliases[member.id] ?? aliases[member.name] ?? member.displayName ?? member.name }))
const displayNameOf = (id, name) => aliases[id] ?? aliases[name] ?? name
/** The main Session card: superagent's `board.json` names it, and it has no roster row of its own. */
const leadRow = () => main === null ? undefined : {
  id: main.id ?? 'lead',
  name: main.name ?? 'lead',
  role: main.role ?? 'lead',
  state: main.state ?? 'working',
  displayName: aliases[main.id] ?? aliases[main.name] ?? main.name ?? 'lead',
  ticketId: null,
  ticketTitle: null,
  ...(main.sessionId === undefined ? {} : { sessionId: main.sessionId }),
}
const ownerLabel = owner => {
  if (owner === 'main') return '主会话自建'
  const row = memberRows().find(member => member.name === owner || member.id === owner)
  return row === undefined ? '未分配' : displayNameOf(row.id, row.name)
}
const actionKey = (kind, ticketId) => `${kind}:${ticketId}`
const emptyState = (title, hint) => '<div class="empty-state"><span class="empty-mark" aria-hidden="true">◌</span><p class="empty-title">' + title + '</p>' + (hint === '' ? '' : '<p class="empty-hint">' + hint + '</p>') + '</div>'

/**
 * Running direct child agents as at most three little characters on the card's right edge; the rest collapse
 * to +N. Each one is a small round face (eyes, cheeks, smile) so a member's helpers read as creatures rather
 * than status dots — the same silhouette at every size, sized by CSS.
 */
function subagentOrbs(row) {
  const data = row.subagents
  if (!data || data.running <= 0) return ''
  const items = Array.isArray(data.items) ? data.items.slice(0, 3) : []
  const more = Math.max(0, data.running - items.length)
  const dots = items.map((item, index) => '<span class="subagent-orb" style="--sa-delay:' +
    (index * 0.23).toFixed(2) + 's" aria-hidden="true" title="子代理 · ' +
    escapeHtml(item.label || '子代理') + ' · 运行中">' +
    '<span class="subagent-eye subagent-eye-l"></span><span class="subagent-eye subagent-eye-r"></span>' +
    '<span class="subagent-blush subagent-blush-l"></span><span class="subagent-blush subagent-blush-r"></span>' +
    '<span class="subagent-mouth"></span></span>').join('')
  const rest = more > 0
    ? '<span class="subagent-more" title="另有 ' + more + ' 个运行中的子代理">+' + more + '</span>'
    : ''
  return '<span class="member-subagents" aria-label="' + data.running + ' 个子代理运行中">' + dots + rest + '</span>'
}

function clearActionTimer(key) {
  const timer = actionTimers.get(key)
  if (timer !== undefined) clearTimeout(timer)
  actionTimers.delete(key)
}

/** One action control: idle label → 确认执行？ (4 s) → 执行中… → inline 已执行/message. */
function actionButton(kind, ticketId) {
  const key = actionKey(kind, ticketId)
  const state = actionState.get(key)
  const phase = state?.phase ?? 'idle'
  const label = ACTION_LABEL[kind]
  const text = phase === 'running' ? '执行中…' : phase === 'confirm' ? '确认执行？' : label
  const spinner = phase === 'running' ? '<span class="spinner"></span>' : ''
  const result = phase === 'result'
    ? `<span class="action-result" data-ok="${state.ok}">${escapeHtml(state.message)}</span>`
    : ''
  return `<span class="action-slot"><button type="button" class="action-btn${phase === 'confirm' ? ' confirm' : ''}" data-action="${kind}" data-ticket-id="${escapeHtml(ticketId)}" title="${escapeHtml(ACTION_TITLE[kind])}"${phase === 'running' ? ' disabled' : ''}>${spinner}${text}</button>${result}</span>`
}

/** First click arms an inline confirmation; a second click within 4 s runs the action. */
function handleAction(kind, ticketId) {
  const key = actionKey(kind, ticketId)
  const state = actionState.get(key)
  if (state?.phase === 'running') return
  if (state?.phase === 'confirm') {
    clearActionTimer(key)
    void runAction(kind, ticketId)
    return
  }
  actionState.set(key, { phase: 'confirm' })
  clearActionTimer(key)
  actionTimers.set(key, setTimeout(() => {
    actionState.delete(key)
    clearActionTimer(key)
    render()
  }, 4000))
  render()
}

/** Runs the action through the shell's same-origin proxy and keeps the server's own message inline. */
async function runAction(kind, ticketId) {
  const key = actionKey(kind, ticketId)
  actionState.set(key, { phase: 'running' })
  render()
  let result
  try {
    const response = await fetch('action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, ticketId }),
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    const ok = response.ok && payload?.ok !== false
    result = {
      phase: 'result',
      ok,
      message: payload?.message ?? (ok ? '已执行' : `请求失败（HTTP ${response.status}）`),
    }
  } catch (error) {
    result = { phase: 'result', ok: false, message: `网络请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  actionState.set(key, result)
  clearActionTimer(key)
  actionTimers.set(key, setTimeout(() => {
    actionState.delete(key)
    clearActionTimer(key)
    render()
  }, 8000))
  render()
  if (result.ok) setTimeout(() => { void load() }, 600)
}

function memberCard(row, isLead) {
  const state = row.state ?? 'idle'
  const displayName = displayNameOf(row.id, row.name)
  const orbs = subagentOrbs(row)
  const roleText = isLead ? '主代理' : (row.role ?? '')
  const roleLine = roleText === ''
    ? ''
    : `<div class="member-role" title="${escapeHtml(roleText)}">角色 · ${escapeHtml(roleText)}</div>`
  const sessionAttr = row.sessionId === undefined ? '' : ` data-session-id="${escapeHtml(row.sessionId)}"`
  const orderAttr = isLead ? '' : ` data-order-key="${escapeHtml(row.id)}"`
  return `<article tabindex="0" class="card${isLead ? ' card-lead' : ''}${state === 'working' ? ' is-running' : ''}${orbs === '' ? '' : ' has-subagents'}" data-state="${escapeHtml(state)}" data-member-id="${escapeHtml(row.id)}"${sessionAttr}${orderAttr} title="${escapeHtml(row.ticketTitle ?? displayName)}">
      <span class="card-aura" aria-hidden="true"></span>
      ${orbs}
      <div class="member-head">
        <span class="avatar" data-tone="${escapeHtml(toneOf(row.id))}" aria-hidden="true">${escapeHtml(initialOf(displayName))}</span>
        <strong class="member-name">${escapeHtml(displayName)}</strong>
      </div>
      ${roleLine}
      <div class="member-line">
        <span class="sub${row.ticketEnded ? ' is-ended' : ''}" title="${escapeHtml(row.ticketTitle ?? '')}">当前工单 · ${escapeHtml(row.ticketTitle ?? '—')}</span>
        <span class="member-meta"><span class="dot" data-state="${escapeHtml(state)}"></span><span class="state-chip" data-state="${escapeHtml(state)}">${escapeHtml(statusWord(state))}</span></span>
      </div>
    </article>`}

/** A/B…Z, then A1/B1… for temporary workers beyond the alphabet. */
function temporaryLabel(index) {
  const letter = String.fromCharCode(65 + index % 26)
  return `临时工${letter}${index < 26 ? '' : Math.floor(index / 26)}`
}

/**
 * A temporary worker keeps the member-card silhouette but is deliberately smaller and plainer: a dashed shell
 * with a soft blue edge, the generated letter as its title, and exactly one line of ticket context. No avatar,
 * status, controls or timing, so it cannot be confused with a real member card.
 */
function temporaryWorkerCard(worker, index) {
  const label = temporaryLabel(index)
  const title = worker.ticketTitle ?? '—'
  const orb = '<span class="subagent-orb temp-orb" style="--sa-delay:' + (index * 0.23).toFixed(2) + 's" aria-hidden="true">' +
    '<span class="subagent-eye subagent-eye-l"></span><span class="subagent-eye subagent-eye-r"></span>' +
    '<span class="subagent-blush subagent-blush-l"></span><span class="subagent-blush subagent-blush-r"></span>' +
    '<span class="subagent-mouth"></span></span>'
  return `<article class="temp-card" tabindex="0" title="${escapeHtml(label + ' · ' + title)}"${worker.sessionId === undefined ? '' : ` data-session-id="${escapeHtml(worker.sessionId)}"`}>
        ${orb}
        <strong class="temp-card-name">${escapeHtml(label)}</strong>
        <span class="temp-card-ticket">${escapeHtml(title)}</span>
      </article>`
}

function renderTeam() {
  const container = document.querySelector('#team')
  const signature = JSON.stringify({ roster, main, teamDown, aliases, temporaryWorkers,
    tickets: (board?.tickets ?? []).map(ticket => [ticket.id, ticket.title, ticket.state, ticket.ownerMemberId, ticket.updatedAt]) })
  if (container.dataset.signature === signature && container.children.length > 0) return
  container.dataset.signature = signature
  const rows = memberRows()
  if (rows.length === 0) {
    // Temporary workers hang off the lead card, so a roster with only self-created tickets still draws them.
    if (leadRow() === undefined || temporaryWorkers.length === 0) {
      container.className = 'team-empty'
      container.innerHTML = teamDown
        ? emptyState('成员名册暂不可用（superagent /team 不可达）', '工单区仍可查看；名册恢复后自动刷新。')
        : emptyState('团队暂无成员', 'superagent /team 名册为空；新增成员后自动显示。')
      return
    }
  }
  const lead = leadRow() ?? rows[0]
  const members = orderedByLane('members', rows.filter(row => row !== lead), row => row.id)
  const workers = temporaryWorkers.map((worker, index) => temporaryWorkerCard(worker, index)).join('')
  container.className = 'team-tree'
  container.innerHTML = (lead === undefined ? '' : `<div class="team-lead">${memberCard(lead, true)}` +
    (workers === '' ? '' : `<div class="temporary-workers">${workers}</div>`) + '</div>') +
    `<div class="team-members" data-lane="members">${members.map(row => memberCard(row, false)).join('')}</div>` +
    (lead !== undefined && (members.length > 0 || temporaryWorkers.length > 0) ? '<svg class="team-edges" aria-hidden="true"></svg>' : '')
  requestAnimationFrame(drawEdges)
}

/** Solid grey idle edges; running members get a yellow line and random 0/1 signal strings. */
const SVG_NS = 'http://www.w3.org/2000/svg'
const SIGNAL_GLOW = '<filter id="edge-signal-glow" x="-60%" y="-60%" width="220%" height="220%">' +
  '<feGaussianBlur in="SourceGraphic" stdDeviation="1.1" result="blur"/>' +
  '<feComponentTransfer in="blur" result="glow"><feFuncA type="linear" slope="0.315"/></feComponentTransfer>' +
  '<feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
let signalGradientSeq = 0
let signalTimers = []
let signalPackets = []
let signalFrame = 0

function stopEdgeSignals() {
  for (const timer of signalTimers) clearTimeout(timer)
  signalTimers = []
  if (signalFrame !== 0) cancelAnimationFrame(signalFrame)
  signalFrame = 0
  for (const packet of signalPackets) {
    packet.node.remove()
    packet.gradient.remove()
  }
  signalPackets = []
}

function syncSignalGradient(packet, elapsed = 0) {
  const box = packet.node.getBBox()
  if (!(packet.width > 0) && box.width > 0) packet.width = box.width
  const width = packet.width > 0 ? packet.width : box.width
  if (width <= 0) return
  const phase = ((elapsed % 8000) / 8000) * width
  const x1 = box.x - phase
  packet.gradient.setAttribute('x1', x1.toFixed(1))
  packet.gradient.setAttribute('y1', (box.y + box.height / 2).toFixed(1))
  packet.gradient.setAttribute('x2', (x1 + width).toFixed(1))
  packet.gradient.setAttribute('y2', (box.y + box.height / 2).toFixed(1))
}

function animateEdgeSignals(now) {
  signalFrame = 0
  signalPackets = signalPackets.filter(packet => {
    const elapsed = now - packet.started
    if (elapsed >= packet.duration) {
      packet.node.remove()
      packet.gradient.remove()
      return false
    }
    const progress = elapsed / packet.duration
    packet.textPath.setAttribute('startOffset', (progress * packet.length).toFixed(1))
    packet.node.style.opacity = progress > .72 ? String(Math.max(0, 1 - (progress - .72) / .28)) : '1'
    syncSignalGradient(packet, elapsed)
    return true
  })
  if (signalPackets.length > 0) signalFrame = requestAnimationFrame(animateEdgeSignals)
}

function spawnEdgeSignal(svg, path) {
  const length = path.getTotalLength()
  if (!Number.isFinite(length) || length <= 0) return 3000
  const gradient = document.createElementNS(SVG_NS, 'linearGradient')
  gradient.id = 'edge-signal-gradient-' + (signalGradientSeq += 1)
  gradient.setAttribute('gradientUnits', 'userSpaceOnUse')
  gradient.setAttribute('spreadMethod', 'repeat')
  gradient.setAttribute('x1', '0')
  gradient.setAttribute('y1', '0')
  gradient.setAttribute('x2', '1')
  gradient.setAttribute('y2', '0')
  for (const [offset, color] of [[0, '#4285F4'], [.25, '#EA4335'], [.5, '#FBBC05'], [.75, '#34A853'], [1, '#4285F4']]) {
    const stop = document.createElementNS(SVG_NS, 'stop')
    stop.setAttribute('offset', String(offset))
    stop.setAttribute('stop-color', color)
    gradient.appendChild(stop)
  }
  svg.querySelector('#edge-signal-defs')?.appendChild(gradient)
  const text = document.createElementNS(SVG_NS, 'text')
  text.setAttribute('class', 'edge-signal')
  text.setAttribute('dy', '4')
  const textPath = document.createElementNS(SVG_NS, 'textPath')
  textPath.setAttribute('href', '#' + path.id)
  textPath.setAttribute('startOffset', '0')
  textPath.setAttribute('fill', 'url(#' + gradient.id + ')')
  const count = 12 + Math.floor(Math.random() * 9)
  for (let index = 0; index < count; index += 1) {
    const span = document.createElementNS(SVG_NS, 'tspan')
    span.textContent = Math.random() < .5 ? '0' : '1'
    textPath.appendChild(span)
  }
  text.appendChild(textPath)
  svg.appendChild(text)
  const duration = 2500 + Math.random() * 1000
  // Freeze the full glyph width before the path end clips the text: a clipped bbox would rescale the
  // gradient and make the digits visibly change colour as they reach the member card.
  const width = text.getComputedTextLength()
  const packet = { node: text, textPath, gradient, length, width, started: performance.now(), duration }
  syncSignalGradient(packet)
  signalPackets.push(packet)
  if (signalFrame === 0) signalFrame = requestAnimationFrame(animateEdgeSignals)
  return duration
}

function startEdgeSignals(svg, index) {
  const path = svg.querySelector('#edge-signal-' + index)
  if (!(path instanceof SVGPathElement)) return
  const emit = () => {
    if (!path.isConnected || path.dataset.state !== 'working') return
    const duration = spawnEdgeSignal(svg, path)
    const timer = setTimeout(emit, duration + 1500 + Math.random() * 2500)
    signalTimers.push(timer)
  }
  const timer = setTimeout(emit, 600 + Math.random() * 1400)
  signalTimers.push(timer)
}

function drawEdges() {
  stopEdgeSignals()
  const tree = document.querySelector('#team.team-tree')
  if (tree === null) return
  const svg = tree.querySelector('.team-edges')
  const leadCard = tree.querySelector('.team-lead .card')
  const cards = Array.from(tree.querySelectorAll('.team-members .card'))
  // Temporary workers answer to the same lead, so they get their own branch below it.
  const workers = Array.from(tree.querySelectorAll('.team-lead .temp-card'))
  if (svg === null || leadCard === null || (cards.length === 0 && workers.length === 0)) {
    if (svg !== null) svg.innerHTML = ''
    return
  }
  const box = tree.getBoundingClientRect()
  const width = tree.clientWidth
  const height = tree.clientHeight
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  const lead = leadCard.getBoundingClientRect()
  const x1 = lead.right - box.left
  const y1 = lead.top - box.top + lead.height / 2
  svg.innerHTML = '<defs id="edge-signal-defs">' + SIGNAL_GLOW + '</defs>' + cards.map((card, index) => {
    const rect = card.getBoundingClientRect()
    const x2 = rect.left - box.left - 3
    const y2 = rect.top - box.top + rect.height / 2
    const state = card.dataset.state ?? 'idle'
    const live = state === 'working'
    const middle = x1 + (x2 - x1) / 2
    const d = 'M ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' C ' + middle.toFixed(1) + ' ' + y1.toFixed(1) + ', ' + middle.toFixed(1) + ' ' + y2.toFixed(1) + ', ' + x2.toFixed(1) + ' ' + y2.toFixed(1)
    if (!live) return '<path class="edge edge-idle" data-state="' + state + '" d="' + d + '" />'
    // Extend the real curve backwards horizontally inside the lead; the straight lead-in shares the curve's
    // tangent at x1, so the digits stay on the visible line as they emerge.
    const signalStart = x1 - Math.max(0, lead.width - 26)
    const signalD = 'M ' + signalStart.toFixed(1) + ' ' + y1.toFixed(1) + ' L ' + x1.toFixed(1) + ' ' + y1.toFixed(1) +
      ' C ' + middle.toFixed(1) + ' ' + y1.toFixed(1) + ', ' + middle.toFixed(1) + ' ' + y2.toFixed(1) + ', ' + x2.toFixed(1) + ' ' + y2.toFixed(1)
    return '<path class="edge edge-live" id="edge-live-' + index + '" data-state="' + state + '" d="' + d + '" />' +
      '<path class="edge-signal-path" id="edge-signal-' + index + '" data-state="' + state + '" d="' + signalD + '" />' +
      '<circle class="edge-dot" cx="' + x2.toFixed(1) + '" cy="' + y2.toFixed(1) + '" r="2" />' +
      '<circle class="edge-dot" cx="' + x1.toFixed(1) + '" cy="' + y1.toFixed(1) + '" r="2" />'
  }).join('')
  // Worker edges take the shortest route: the lead's bottom centre drops straight down to the row of the
  // nearest worker card, then runs down the shared centre of the cards, peeling off into each card's centre.
  if (workers.length > 0) {
    const leadBox = leadCard.getBoundingClientRect()
    // Start below the running card's glow halo so the line never runs underneath it.
    const halo = leadCard.classList.contains('is-running') ? 10 : 2
    const laneX = leadBox.left - box.left + leadBox.width / 2
    const startY = leadBox.bottom - box.top + halo
    const rows = workers.map(card => {
      const rect = card.getBoundingClientRect()
      return { top: rect.top - box.top + rect.height / 2, centre: rect.left - box.left + rect.width / 2, left: rect.left - box.left }
    })
    const centreX = rows[0].centre
    const firstY = rows[0].top
    // Cards centred under the lead need no jog: one straight run through every row.
    const jog = Math.abs(centreX - laneX) < 0.5 ? '' : ' L ' + centreX.toFixed(1) + ' ' + firstY.toFixed(1)
    svg.insertAdjacentHTML('beforeend', '<path class="edge edge-worker is-live" d="M ' + laneX.toFixed(1) + ' ' + startY.toFixed(1) + ' L ' + laneX.toFixed(1) + ' ' + firstY.toFixed(1) + jog + ' L ' + centreX.toFixed(1) + ' ' + rows[rows.length - 1].top.toFixed(1) + '" />')
    for (const row of rows) {
      svg.insertAdjacentHTML('beforeend', '<circle class="edge-dot edge-dot-worker" cx="' + centreX.toFixed(1) + '" cy="' + row.top.toFixed(1) + '" r="2" />')
    }
    svg.insertAdjacentHTML('beforeend', '<circle class="edge-dot edge-dot-worker" cx="' + laneX.toFixed(1) + '" cy="' + startY.toFixed(1) + '" r="2" />')
  }
  cards.forEach((card, index) => {
    if (card.dataset.state === 'working') startEdgeSignals(svg, index)
  })
}

window.addEventListener('resize', () => requestAnimationFrame(drawEdges))

/* ---------- Card order: every card is one whole block, dragged or keyed to reorder inside its lane ---------- */

/** Saved lane orders; localStorage keeps the browser's own copy, so the feed stays the only data source. */
const ORDER_KEY = 'board.order.v1'
/** A press that travels further than this is a drag; anything shorter stays a click on the card. */
const DRAG_THRESHOLD = 5
let orderCache = null

function readOrder() {
  if (orderCache !== null) return orderCache
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_KEY) ?? 'null')
    orderCache = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    orderCache = {}
  }
  return orderCache
}

function saveOrder(lane, ids) {
  const order = readOrder()
  if (ids.length === 0) delete order[lane]
  else order[lane] = ids
  orderCache = order
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)) } catch { /* a read-only page keeps the in-memory order */ }
}

/** Applies one lane's saved order; rows it does not know yet keep their feed order after the known ones. */
function orderedByLane(lane, rows, idOf) {
  const saved = readOrder()[lane]
  if (!Array.isArray(saved) || saved.length === 0) return rows
  const rank = new Map(saved.map((id, index) => [id, index]))
  return rows
    .map((row, index) => ({ row, index, rank: rank.has(idOf(row)) ? rank.get(idOf(row)) : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank === b.rank ? a.index - b.index : a.rank - b.rank)
    .map(entry => entry.row)
}

const isCard = element => element instanceof HTMLElement && element.dataset.orderKey !== undefined
const laneOf = element => element instanceof Element ? element.closest('[data-lane]') : null
const cardsIn = lane => Array.from(lane.children).filter(child => isCard(child) && !child.classList.contains('is-dragging'))
const laneIds = lane => cardsIn(lane).map(card => card.dataset.orderKey)

const drag = { el: null, lane: null, placeholder: null, pointerId: -1, startX: 0, startY: 0, left: 0, top: 0, width: 0, height: 0, moved: false }
let swallowClick = false

function beginPress(event, card) {
  const lane = laneOf(card)
  if (!(lane instanceof HTMLElement)) return false
  const rect = card.getBoundingClientRect()
  drag.el = card
  drag.lane = lane
  drag.pointerId = event.pointerId
  drag.startX = event.clientX
  drag.startY = event.clientY
  drag.left = rect.left
  drag.top = rect.top
  drag.width = rect.width
  drag.height = rect.height
  drag.moved = false
  drag.placeholder = null
  try { card.setPointerCapture(event.pointerId) } catch { /* a cancelled capture only loses the lift preview */ }
  return true
}

function liftCard() {
  const card = drag.el
  const lane = drag.lane
  if (!(card instanceof HTMLElement) || !(lane instanceof HTMLElement)) return
  const placeholder = document.createElement('div')
  placeholder.className = 'drop-placeholder'
  placeholder.setAttribute('aria-hidden', 'true')
  placeholder.style.height = drag.height + 'px'
  lane.insertBefore(placeholder, card)
  drag.placeholder = placeholder
  card.classList.add('is-dragging')
  card.style.left = drag.left + 'px'
  card.style.top = drag.top + 'px'
  card.style.width = drag.width + 'px'
  card.style.height = drag.height + 'px'
}

/** Moves the placeholder to the slot the pointer is over; the lane bounds keep a drag from leaving its column. */
function movePlaceholder(event) {
  const lane = drag.lane
  const placeholder = drag.placeholder
  if (!(lane instanceof HTMLElement) || !(placeholder instanceof HTMLElement)) return
  const bounds = lane.getBoundingClientRect()
  if (event.clientY < bounds.top - 24 || event.clientY > bounds.bottom + 24) return
  const siblings = cardsIn(lane)
  const next = siblings.find(card => {
    const rect = card.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2
  })
  if (next === undefined) lane.appendChild(placeholder)
  else lane.insertBefore(placeholder, next)
}

function endDrag(commit) {
  const card = drag.el
  const lane = drag.lane
  const placeholder = drag.placeholder
  const moved = drag.moved
  if (card instanceof HTMLElement) {
    card.classList.remove('is-dragging')
    card.style.left = ''
    card.style.top = ''
    card.style.width = ''
    card.style.height = ''
  }
  if (moved && commit && card instanceof HTMLElement && placeholder instanceof HTMLElement && lane instanceof HTMLElement) {
    lane.insertBefore(card, placeholder)
    saveOrder(lane.dataset.lane ?? '', laneIds(lane))
    drawEdges()
    swallowClick = true
    setTimeout(() => { swallowClick = false }, 0)
  }
  placeholder?.remove()
  drag.el = null
  drag.lane = null
  drag.placeholder = null
  drag.pointerId = -1
  drag.moved = false
}

document.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.pointerType === 'mouse') return
  const target = event.target instanceof Element ? event.target : null
  if (target === null) return
  // Controls inside a card keep their own press; only the card body lifts.
  if (target.closest('button, a, input, textarea, select, [data-no-drag]') !== null) return
  const card = target.closest('[data-order-key]')
  if (!isCard(card)) return
  beginPress(event, card)
}, { passive: true })

document.addEventListener('pointermove', event => {
  if (drag.el === null || event.pointerId !== drag.pointerId) return
  const dx = event.clientX - drag.startX
  const dy = event.clientY - drag.startY
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    liftCard()
  }
  const card = drag.el
  if (!(card instanceof HTMLElement)) return
  card.style.left = drag.left + dx + 'px'
  card.style.top = drag.top + dy + 'px'
  movePlaceholder(event)
  event.preventDefault()
}, { passive: false })

document.addEventListener('pointerup', event => {
  if (drag.el === null || event.pointerId !== drag.pointerId) return
  endDrag(true)
})

document.addEventListener('pointercancel', () => { if (drag.el !== null) endDrag(false) })

/** A completed drag must not read as a click on the card underneath. */
document.addEventListener('click', event => {
  if (!swallowClick) return
  swallowClick = false
  event.stopPropagation()
  event.preventDefault()
}, true)

/** Arrow keys walk the lane, Alt+Arrow moves the card and saves the new order. */
document.addEventListener('keydown', event => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  const active = document.activeElement instanceof Element ? document.activeElement : null
  const card = active?.closest('[data-order-key]')
  if (!isCard(card)) return
  const lane = laneOf(card)
  if (!(lane instanceof HTMLElement)) return
  const cards = cardsIn(lane)
  const index = cards.indexOf(card)
  const step = event.key === 'ArrowDown' ? 1 : -1
  const neighbour = cards[index + step]
  if (neighbour === undefined) return
  event.preventDefault()
  if (!event.altKey) { neighbour.focus(); return }
  if (step > 0) lane.insertBefore(neighbour, card)
  else lane.insertBefore(card, neighbour)
  saveOrder(lane.dataset.lane ?? '', laneIds(lane))
  card.focus()
  drawEdges()
})

function ticketRow(ticket, bucket) {
  const selected = ticket.id === selectedId
  return `<div class="ticket-row${selected ? ' is-selected' : ''}" role="button" tabindex="0" data-ticket-id="${escapeHtml(ticket.id)}" data-order-key="${escapeHtml(ticket.id)}" aria-selected="${selected}">
    <div class="title" title="${escapeHtml(ticket.title)}">${escapeHtml(ticket.title)}</div>
    <div class="ticket-status"><span class="state-chip" data-state="${escapeHtml(ticket.state)}" data-bucket="${escapeHtml(bucket)}">${escapeHtml(statusWord(ticket.state))}</span></div>
    <div class="ticket-meta"><span class="ticket-owner">负责人 · ${escapeHtml(ownerLabel(ticket.ownerMemberId))}</span><span class="ticket-time" title="${escapeHtml(formatTime(ticket.updatedAt))}">${escapeHtml(relativeTime(ticket.updatedAt))}</span></div>
  </div>`
}

function renderTickets() {
  const container = document.querySelector('#tickets')
  if (board === null) {
    const signature = JSON.stringify({ sourceDown })
    if (container.dataset.signature === signature && container.children.length > 0) return
    container.dataset.signature = signature
    container.innerHTML = sourceDown
      ? emptyState('数据源中断', '工单暂时不可用；团队区仍保留当前页面状态。')
      : emptyState('正在载入工单', '稍候会自动刷新。')
    return
  }
  const tickets = board.tickets ?? []
  // The board feed is polled; only a real ticket change replaces the DOM, so scroll and focus survive.
  const signature = JSON.stringify({ sourceDown, tickets: tickets.map(ticket => [ticket.id, ticket.title, ticket.state,
    ticket.ownerMemberId, ticket.ownerKind, ticket.ownerLabel, ticket.origin, ticket.updatedAt, ticket.summary]) })
  if (container.dataset.signature === signature && container.children.length > 0) return
  container.dataset.signature = signature
  if (tickets.length === 0) {
    container.innerHTML = emptyState('暂无工单', '当前没有待展示的工单。')
    return
  }
  container.innerHTML = GROUPS.map(group => {
    const rows = orderedByLane('bucket:' + group.key, tickets.filter(ticket => group.states.includes(ticket.state)), ticket => ticket.id)
    return `<section class="group" data-bucket="${group.key}" data-lane="bucket:${group.key}"><h3>${group.label} <span>${rows.length}</span></h3>${rows.map(ticket => ticketRow(ticket, group.key)).join('') || '<div class="empty">—</div>'}</section>`
  }).join('')
}

function renderDetail() {
  const container = document.querySelector('#detail')
  const ticket = selectedId === null ? undefined : (board?.tickets ?? []).find(item => item.id === selectedId)
  const actionChanges = ticket === undefined ? [] : [...actionState.entries()].filter(([key]) => key.endsWith(`:${ticket.id}`))
  const signature = JSON.stringify({ ticket: ticket ?? null, actions: actionChanges })
  if (container.dataset.signature === signature) return
  container.dataset.signature = signature
  if (ticket === undefined) {
    container.hidden = true
    container.innerHTML = ''
    return
  }
  const active = ACTIVE_STATES.has(ticket.state)
  const ended = ENDED_STATES.has(ticket.state)
  const actions = (active ? actionButton('stop', ticket.id) : '') +
    (ended ? actionButton('retry', ticket.id) : '') +
    (ended ? '<button type="button" class="action-btn view-result" data-view-result>查看结果</button>' : '')
  const summaryClass = resultOpen ? 'summary is-result' : 'summary'
  container.hidden = false
  container.innerHTML = `<button type="button" class="close" data-close-detail>关闭</button>
    <h3>${escapeHtml(ticket.title)}</h3>
    <div class="detail-state"><span class="state-chip" data-state="${escapeHtml(ticket.state)}" data-bucket="${escapeHtml(bucketOf(ticket.state))}">${escapeHtml(statusWord(ticket.state))}</span></div>
    <dl>
      <dt>负责人</dt><dd>${escapeHtml(ownerLabel(ticket.ownerMemberId))}</dd>
      <dt>更新时间</dt><dd>${escapeHtml(relativeTime(ticket.updatedAt))} <span class="detail-absolute">${escapeHtml(formatTime(ticket.updatedAt))}</span></dd>
      <dt>工单 ID</dt><dd class="detail-id">${escapeHtml(ticket.id)}</dd>
    </dl>
    <div class="${summaryClass}">${escapeHtml(ticket.summary ?? '暂无报告摘要')}</div>
    <div class="detail-actions">${actions || '<span class="detail-hint">当前状态没有可用动作</span>'}</div>
    <div class="detail-hint">点击左侧工单行可切换选中；动作按钮仅在对应状态可用。</div>`
}

function renderBanner() {
  const banner = document.querySelector('#banner')
  if (sourceDown) {
    banner.hidden = false
    banner.textContent = '数据源中断，重试中…（工单区显示最近一次数据）'
    return
  }
  banner.hidden = true
  banner.textContent = ''
}

function updateSummary() {
  const summary = document.querySelector('#summary')
  const tickets = board?.tickets ?? []
  if (summary !== null) summary.textContent = '团队 ' + roster.length + ' 成员 · ' + tickets.length + ' 工单'
}

function updateUpdated() {
  lastUpdated = new Date()
  const element = document.querySelector('#updated')
  if (element !== null) element.textContent = '更新于 ' + clockOf(lastUpdated)
}

async function loadAliases() {
  try {
    const response = await fetch('aliases.json', { cache: 'no-store' })
    if (response.ok) {
      const value = await response.json()
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) aliases = value
      if (booted) render()
    }
  } catch {
    /* aliases are optional */
  }
}

function closeMenu() {
  const menu = document.querySelector('#context-menu')
  if (menu !== null) menu.hidden = true
}

function openMemberMenu(id, x, y) {
  const menu = document.querySelector('#context-menu')
  if (menu === null) return
  const lead = leadRow()
  const row = memberRows().find(member => member.id === id)
  const raw = row ?? (lead?.id === id ? lead : undefined)
  const current = displayNameOf(id, raw?.name ?? id)
  const sessionId = raw?.sessionId ?? ''
  menu.innerHTML = '<button type="button" role="menuitem" data-menu-action="open"' + (sessionId === '' ? ' disabled title="该成员没有绑定 DSH 会话"' : '') + '>打开会话</button>' +
    (row === undefined
      ? ''
      : '<button type="button" role="menuitem" data-menu-action="rename">重命名</button>' +
        '<button type="button" role="menuitem" data-menu-action="delete">删除</button>')
  menu.hidden = false
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 176)) + 'px'
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 176)) + 'px'
  const first = menu.querySelector('button[data-menu-action="open"]:not([disabled])') ?? menu.querySelector('button[data-menu-action="rename"]')
  if (first !== null) first.focus()
  menu.dataset.memberId = id
  menu.dataset.memberName = current
  menu.dataset.sessionId = sessionId
}

function render() {
  if (!booted) return
  updateSummary()
  renderBanner()
  renderTeam()
  renderTickets()
  renderDetail()
}

async function load() {
  const request = ++boardRequest
  try {
    const response = await fetch('board.json', { cache: 'no-store' })
    if (request !== boardRequest) return
    if (response.ok) {
      const payload = await response.json()
      if (request !== boardRequest) return
      // A degraded answer still carries the roster; keep the last tickets so the page never blanks.
      board = payload.degraded !== null && board !== null
        ? { ...board, main: payload.main, members: payload.members, degraded: payload.degraded }
        : payload
      if (board.main !== undefined && board.main !== null) main = board.main
      degradedStreak = board.degraded !== null ? degradedStreak + 1 : 0
      sourceDown = degradedStreak >= 2
    } else {
      degradedStreak += 1
      sourceDown = degradedStreak >= 2
    }
  } catch {
    if (request !== boardRequest) return
    degradedStreak += 1
    sourceDown = degradedStreak >= 2
  }
  if (request !== boardRequest) return
  booted = true
  updateUpdated()
  render()
}

/** Pulls the team area's own feed: superagent's `/team` roster, with its live state, every few seconds. */
async function loadTeam() {
  if (teamPolling) return
  teamPolling = true
  const request = ++teamRequest
  try {
    const response = await fetch('team.json', { cache: 'no-store' })
    if (request !== teamRequest) return
    if (!response.ok) {
      teamDown = true
      if (booted) render()
      return
    }
    const payload = await response.json()
    if (request !== teamRequest) return
    teamDown = payload.teamDown === true
    if (!teamDown) {
      roster = Array.isArray(payload.members) ? payload.members : []
      temporaryWorkers = Array.isArray(payload.workers) ? payload.workers : []
      if (payload.main !== undefined && payload.main !== null) main = payload.main
    }
  } catch {
    if (request !== teamRequest) return
    teamDown = true
  } finally {
    teamPolling = false
  }
  if (booted) render()
}

/** Finds the roster row a card action targets (the synthetic main card is never editable). */
const memberRowById = id => memberRows().find(member => member.id === id)

/** Posts one roster action through the board host; a 4xx answer's message surfaces in the dialog. */
async function postTeamAction(body) {
  const response = await fetch('team/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let payload = null
  try { payload = await response.json() } catch { payload = null }
  if (!response.ok || payload?.ok === false) throw new Error(payload?.message ?? `请求失败（HTTP ${response.status}）`)
  return payload
}

function showToast(text, tone = 'ok') {
  const toast = document.querySelector('#toast')
  if (toast === null) return
  toast.textContent = text
  toast.dataset.tone = tone
  toast.hidden = false
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.hidden = true; toastTimer = null }, 3200)
}

function openRenameDialog(id) {
  const row = memberRowById(id)
  if (row === undefined) return
  renameTarget = row
  const target = document.querySelector('#rename-target')
  const name = document.querySelector('#rename-name')
  const role = document.querySelector('#rename-role')
  const brief = document.querySelector('#rename-brief')
  const error = document.querySelector('#rename-error')
  if (target !== null) target.textContent = '成员：' + displayNameOf(row.id, row.name)
  if (name instanceof HTMLInputElement) name.value = row.name
  if (role instanceof HTMLInputElement) role.value = row.role ?? ''
  if (brief instanceof HTMLTextAreaElement) brief.value = ''
  if (error !== null) { error.hidden = true; error.textContent = '' }
  const dialog = document.querySelector('#rename-dialog')
  if (dialog !== null) dialog.hidden = false
  if (name instanceof HTMLInputElement) { name.focus(); name.select() }
}

function closeRenameDialog() {
  const dialog = document.querySelector('#rename-dialog')
  if (dialog !== null) dialog.hidden = true
  renameTarget = null
  const save = document.querySelector('#rename-save')
  if (save instanceof HTMLButtonElement) { save.disabled = false; save.textContent = '保存' }
}

async function submitRename(event) {
  event.preventDefault()
  if (renameTarget === null) return
  const nameInput = document.querySelector('#rename-name')
  const roleInput = document.querySelector('#rename-role')
  const briefInput = document.querySelector('#rename-brief')
  const error = document.querySelector('#rename-error')
  const save = document.querySelector('#rename-save')
  const name = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : ''
  if (name === '') {
    if (error !== null) { error.textContent = '显示名不能为空'; error.hidden = false }
    return
  }
  if (save instanceof HTMLButtonElement) { save.disabled = true; save.textContent = '保存中…' }
  if (error !== null) error.hidden = true
  const role = roleInput instanceof HTMLInputElement ? roleInput.value.trim() : ''
  const brief = briefInput instanceof HTMLTextAreaElement ? briefInput.value.trim() : ''
  try {
    await postTeamAction({
      action: 'update',
      id: renameTarget.id,
      name,
      ...(role === '' ? {} : { role }),
      ...(brief === '' ? {} : { brief }),
    })
    closeRenameDialog()
    showToast('已重命名')
    await loadTeam()
  } catch (failure) {
    if (error !== null) {
      error.textContent = failure instanceof Error ? failure.message : String(failure)
      error.hidden = false
    }
  } finally {
    if (save instanceof HTMLButtonElement) { save.disabled = false; save.textContent = '保存' }
  }
}

function openDeleteDialog(id) {
  const row = memberRowById(id)
  if (row === undefined) return
  deleteTarget = row
  const target = document.querySelector('#delete-target')
  const error = document.querySelector('#delete-error')
  if (target !== null) target.textContent = '成员：' + displayNameOf(row.id, row.name)
  if (error !== null) { error.hidden = true; error.textContent = '' }
  const dialog = document.querySelector('#delete-dialog')
  if (dialog !== null) dialog.hidden = false
  const confirm = document.querySelector('#delete-confirm')
  if (confirm instanceof HTMLButtonElement) { confirm.disabled = false; confirm.textContent = '确认删除' }
}

function closeDeleteDialog() {
  const dialog = document.querySelector('#delete-dialog')
  if (dialog !== null) dialog.hidden = true
  deleteTarget = null
}

async function confirmDelete() {
  if (deleteTarget === null) return
  const confirm = document.querySelector('#delete-confirm')
  const error = document.querySelector('#delete-error')
  if (confirm instanceof HTMLButtonElement) { confirm.disabled = true; confirm.textContent = '删除中…' }
  if (error !== null) error.hidden = true
  try {
    await postTeamAction({ action: 'remove', id: deleteTarget.id })
    closeDeleteDialog()
    showToast('已删除并归档')
    await loadTeam()
  } catch (failure) {
    if (error !== null) {
      error.textContent = failure instanceof Error ? failure.message : String(failure)
      error.hidden = false
    }
    if (confirm instanceof HTMLButtonElement) { confirm.disabled = false; confirm.textContent = '确认删除' }
  }
}

/** Refresh is explicit: re-fetch the board, the roster and the aliases. */
async function refresh() {
  if (refreshing) return
  refreshing = true
  const button = document.querySelector('#refresh')
  if (button instanceof HTMLButtonElement) {
    button.disabled = true
    button.classList.add('is-busy')
    button.textContent = '刷新中…'
  }
  try {
    await load()
    await loadTeam()
    await loadAliases()
  } finally {
    refreshing = false
    if (button instanceof HTMLButtonElement) {
      button.disabled = false
      button.classList.remove('is-busy')
      button.textContent = '刷新'
    }
  }
}

function runMenuAction(action) {
  const menu = document.querySelector('#context-menu')
  if (menu === null) return
  const id = menu.dataset.memberId ?? ''
  const sessionId = menu.dataset.sessionId ?? ''
  if (action === 'open' && sessionId !== '') {
    window.parent.postMessage({ type: 'open-session', id: sessionId }, location.origin)
    closeMenu()
    return
  }
  if (action === 'rename' && id !== '') {
    closeMenu()
    openRenameDialog(id)
    return
  }
  if (action === 'delete' && id !== '') {
    closeMenu()
    openDeleteDialog(id)
  }
}

document.querySelector('#context-menu')?.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('[data-menu-action]') : null
  if (!(target instanceof HTMLElement)) return
  event.stopPropagation()
  runMenuAction(target.dataset.menuAction ?? '')
})

document.querySelector('#context-menu')?.addEventListener('keydown', event => {
  const menu = event.currentTarget
  if (!(menu instanceof HTMLElement)) return
  const buttons = Array.from(menu.querySelectorAll('button:not(:disabled)'))
  const current = document.activeElement
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const index = buttons.indexOf(current instanceof HTMLElement ? current : null)
  const step = event.key === 'ArrowDown' ? 1 : -1
  const next = buttons[(index + step + buttons.length) % buttons.length]
  if (next !== undefined) next.focus()
})

document.addEventListener('contextmenu', event => {
  const element = event.target instanceof Element ? event.target : null
  const card = element?.closest('.card[data-member-id]')
  if (!(card instanceof HTMLElement)) return
  event.preventDefault()
  openMemberMenu(card.dataset.memberId ?? '', event.clientX, event.clientY)
})

document.addEventListener('keydown', event => {
  const menu = document.querySelector('#context-menu')
  if (event.key === 'Escape' && menu !== null && !menu.hidden) { closeMenu(); return }
  if ((event.key !== 'F10' || !event.shiftKey) && event.key !== 'ContextMenu') return
  const active = document.activeElement
  const card = active instanceof Element ? active.closest('.card[data-member-id]') : null
  if (!(card instanceof HTMLElement)) return
  event.preventDefault()
  const rect = card.getBoundingClientRect()
  openMemberMenu(card.dataset.memberId ?? '', rect.right - 168, rect.top + 24)
})

document.addEventListener('click', event => {
  const menu = document.querySelector('#context-menu')
  const element = event.target instanceof Element ? event.target : null
  if (menu !== null && !menu.hidden && (element === null || !element.closest('#context-menu'))) closeMenu()
})

document.addEventListener('click', event => {
  const element = event.target instanceof Element ? event.target : null
  const action = element?.closest('[data-action]')
  if (action instanceof HTMLElement) {
    event.stopPropagation()
    handleAction(action.dataset.action, action.dataset.ticketId)
    return
  }
  if (element?.closest('[data-view-result]') !== null) {
    event.stopPropagation()
    resultOpen = true
    renderDetail()
    requestAnimationFrame(() => document.querySelector('#detail')?.scrollIntoView({ block: 'nearest' }))
    return
  }
  const row = element?.closest('[data-ticket-id]')
  if (row instanceof HTMLElement) {
    selectedId = row.dataset.ticketId ?? null
    resultOpen = false
    renderTickets()
    renderDetail()
    requestAnimationFrame(() => document.querySelector('#detail')?.scrollIntoView({ block: 'nearest' }))
    return
  }
  if (element?.closest('[data-close-detail]') !== null) {
    selectedId = null
    resultOpen = false
    renderTickets()
    renderDetail()
  }
})

document.addEventListener('click', event => {
  const element = event.target instanceof Element ? event.target : null
  const closer = element?.closest('[data-dialog-close]')
  if (closer instanceof HTMLElement) {
    if (closer.dataset.dialogClose === 'rename') closeRenameDialog()
    else if (closer.dataset.dialogClose === 'delete') closeDeleteDialog()
  }
})

for (const selector of ['#rename-dialog', '#delete-dialog']) {
  document.querySelector(selector)?.addEventListener('click', event => {
    if (event.target !== event.currentTarget) return
    if (selector === '#rename-dialog') closeRenameDialog()
    else closeDeleteDialog()
  })
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  const rename = document.querySelector('#rename-dialog')
  const remove = document.querySelector('#delete-dialog')
  if (rename !== null && !rename.hidden) { event.preventDefault(); closeRenameDialog(); return }
  if (remove !== null && !remove.hidden) { event.preventDefault(); closeDeleteDialog() }
})

document.querySelector('#rename-form')?.addEventListener('submit', submitRename)
document.querySelector('#delete-confirm')?.addEventListener('click', event => {
  event.stopPropagation()
  void confirmDelete()
})

document.querySelector('#refresh')?.addEventListener('click', event => {
  event.stopPropagation()
  void refresh()
})

void load()
void loadTeam()
void loadAliases()
/* board.json is polled every 3 s while visible; the /team roster keeps its own 3 s poll. */
let boardPollTimer = null
let boardPolling = false
async function pollBoard() {
  if (document.hidden || boardPolling) return
  boardPolling = true
  try { await load() } finally { boardPolling = false }
}
boardPollTimer = setInterval(() => { void pollBoard() }, 3000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollBoard() })
setInterval(() => void loadTeam(), 3000)