// Terminal dashboard for the bot fleet.
//
// Subscribes to a Coordinator's blackboard and renders:
//   - a header band (match phase, score, flag carriers, time)
//   - one card per bot (kit, HP/food, state, pos, target, intent, last decision)
//   - an event log at the bottom
//
// Throttled at ~5 Hz; that's plenty for human-watchable updates, and avoids
// re-render storms when many bots tick at once.
//
// See NEXT.md §v2.b. Layout intentionally mirrors the ASCII mock there.

import blessed from 'blessed'

const RENDER_THROTTLE_MS = 200
const CARD_HEIGHT = 8         // 1 border + 6 lines + 1 border
const HEADER_HEIGHT = 3
const LOG_HEIGHT = 8

export class Tui {
  /**
   * @param {import('./coordinator.js').Coordinator} coordinator
   * @param {{onQuit?: () => void}} opts
   */
  constructor (coordinator, { onQuit } = {}) {
    this.coordinator = coordinator
    this.onQuit = onQuit

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'mcctf-bots dashboard',
      fullUnicode: true,
      autoPadding: false,
    })

    this.header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: HEADER_HEIGHT,
      border: 'line',
      tags: true,
      style: { border: { fg: 'cyan' } },
      label: ' match ',
    })

    this.cardArea = blessed.box({
      parent: this.screen,
      top: HEADER_HEIGHT,
      left: 0,
      width: '100%',
      bottom: LOG_HEIGHT,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      scrollbar: { ch: ' ', style: { bg: 'gray' } },
    })

    this.logBox = blessed.log({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: LOG_HEIGHT,
      border: 'line',
      tags: true,
      style: { border: { fg: 'gray' } },
      label: ' events ',
      scrollable: true,
      scrollbar: { ch: ' ', style: { bg: 'gray' } },
      mouse: true,
      keys: true,
    })

    /** @type {Map<string, blessed.Widgets.BoxElement>} */
    this.cards = new Map()
    this._lastLayoutKey = ''

    this.screen.key(['q', 'C-c'], () => {
      if (this.onQuit) this.onQuit()
      else process.exit(0)
    })

    this._unsub = coordinator.blackboard.subscribe(() => this.scheduleRender())
    this._renderTimer = null

    this.render()
  }

  log (line) {
    this.logBox.log(line)
  }

  scheduleRender () {
    if (this._renderTimer) return
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null
      this.render()
    }, RENDER_THROTTLE_MS)
  }

  render () {
    const bb = this.coordinator.blackboard
    this.header.setContent(this._renderHeaderContent(bb.match))

    const usernames = [...bb.bots.keys()]
    const n = usernames.length
    const cols = n >= 9 ? 3 : n >= 4 ? 2 : 1
    const layoutKey = `${cols}:${usernames.join(',')}`
    const layoutChanged = layoutKey !== this._lastLayoutKey
    this._lastLayoutKey = layoutKey

    // Drop cards for departed bots.
    for (const [user, card] of this.cards) {
      if (!bb.bots.has(user)) {
        card.detach()
        this.cards.delete(user)
      }
    }

    const widthPct = Math.floor(100 / cols)
    usernames.forEach((user, i) => {
      const state = bb.bots.get(user)
      const col = i % cols
      const row = Math.floor(i / cols)
      let card = this.cards.get(user)
      if (!card) {
        card = blessed.box({
          parent: this.cardArea,
          top: row * CARD_HEIGHT,
          left: `${col * widthPct}%`,
          width: `${widthPct}%`,
          height: CARD_HEIGHT,
          border: 'line',
          tags: true,
          style: { border: { fg: 'gray' } },
        })
        this.cards.set(user, card)
      } else if (layoutChanged) {
        card.top = row * CARD_HEIGHT
        card.left = `${col * widthPct}%`
        card.width = `${widthPct}%`
      }
      card.setLabel(this._renderCardLabel(state))
      card.setContent(this._renderCardContent(state))
    })

    this.screen.render()
  }

  destroy () {
    if (this._unsub) this._unsub()
    if (this._renderTimer) clearTimeout(this._renderTimer)
    this.screen.destroy()
  }

  // --- rendering helpers ---

  _renderHeaderContent (m) {
    const ms = m.remainingMs
    const time = ms != null ? `time ${formatTime(ms)}` : 'time -'
    const maxStr = m.maxCaps ? `/${m.maxCaps}` : ''
    const score = `caps R:${m.caps?.Red ?? 0}${maxStr} B:${m.caps?.Blue ?? 0}${maxStr}`
    const fR = m.flags?.Red ?? {}
    const fB = m.flags?.Blue ?? {}
    const flagsStr = `R-flag ${formatFlag(fR)}  B-flag ${formatFlag(fB)}`
    const regime = m.regime ? `regime ${m.regime}` : 'regime -'
    return `${score}   ${flagsStr}   ${time}   ${regime}`
  }

  _renderCardLabel (s) {
    const kit = (s.kit ?? '?').toString().toUpperCase()
    const hp = s.hp != null ? `${fmt(s.hp)}/${s.maxHp ?? 20}` : '?/?'
    const food = s.food ?? '?'
    return ` ${s.username} -- ${kit} -- HP ${hp} -- 🍗 ${food} `
  }

  _renderCardContent (s) {
    const pos = s.pos ? `${fmt(s.pos.x)},${fmt(s.pos.y)},${fmt(s.pos.z)}` : '-'
    const team = s.team ?? '?'
    const t = s.target
    const targetStr = t ? `${t.username} d=${fmt(t.dist)}` : '-'
    const intent = s.intent
    const trace = s.decision_trace
    const chosenScore = trace?.scores?.[intent?.kind] ?? null
    const intentStr = intent
      ? `${intent.kind}${chosenScore != null ? ` (${fmt(chosenScore)})` : ''}`
      : '-'
    const runnerUp = trace?.runner_up
    const runnerScore = runnerUp ? trace?.scores?.[runnerUp] : null
    const heldNote = trace?.hysteresis_held ? ' {yellow-fg}*held*{/}' : ''
    const preempt = trace?.preempt ? ` {red-fg}preempt:${trace.preempt}{/}` : ''
    const runnerUpStr = runnerUp
      ? `${runnerUp} (${fmt(runnerScore)})${heldNote}${preempt}`
      : '-'
    const regimeStr = trace?.time_regime ?? '-'
    return [
      `${s.state ?? '-'} | ${team} | ${pos}`,
      `tgt:    ${targetStr}`,
      `intent: ${intentStr}`,
      `runner: ${runnerUpStr}`,
      `regime: ${regimeStr}`,
      `last:   ${s.lastDecision ?? '-'}`,
    ].join('\n')
  }
}

function fmt (n) {
  if (n == null) return '?'
  return typeof n === 'number' ? n.toFixed(1) : String(n)
}

function formatVec (v) {
  if (v == null) return '?'
  if (typeof v === 'string') return v
  if (typeof v.x === 'number') return `${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)}`
  return String(v)
}

function formatFlag (f) {
  if (!f || !f.state) return '?'
  if (f.state === 'carried' && f.heldBy) return `taken by ${f.heldBy}`
  return f.state
}

function formatMultipliers (mults) {
  if (!mults) return ''
  const entries = Object.entries(mults)
  if (entries.length === 0) return ''
  return '  (' + entries.map(([k, v]) => `${k} ×${v}`).join(', ') + ')'
}

function formatTime (ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}
