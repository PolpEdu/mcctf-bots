// Coordinator + TeamBlackboard skeleton for v2.a.
//
// Bots `report()` state changes into the blackboard; subscribers (TUI for now,
// strategic logic later) are notified after each mutation. The `tick()` runs
// the §1 utility scoring per bot and writes the winning intent + decision_trace
// back into the blackboard. Constraints (§2) and auctions (§3) come next.

import { scoreAll } from './coordinator/scoring.js'
import { applyConstraints } from './coordinator/constraints.js'

const DEFAULT_TICK_MS = 1000

export class TeamBlackboard {
  constructor () {
    /** @type {Map<string, BotState>} */
    this.bots = new Map()
    // Match state is color-keyed (Red/Blue), not perspective-keyed. Each bot
    // derives its own ours/enemy view at scoring time via bb.match.teamColors.
    this.match = {
      phase: 'lobby',          // lobby | warmup | active | ended
      remainingMs: null,
      matchTotalMs: null,      // largest remainingMs ever observed — proxy for full match length
      elapsedMs: null,         // derived: matchTotalMs - remainingMs
      regime: null,
      maxCaps: null,
      teamColors: {},          // { team_1: 'Red', team_2: 'Blue' } — discovered
      caps: { Red: 0, Blue: 0 },
      anchors: {               // populated by observer.js
        Red:  { flag: null, base: null },
        Blue: { flag: null, base: null },
      },
      flags: {
        Red:  { state: 'home', heldBy: null, carrierPos: null },
        Blue: { state: 'home', heldBy: null, carrierPos: null },
      },
    }
    /** @type {Set<(bb: TeamBlackboard) => void>} */
    this._listeners = new Set()
  }

  upsertBot (username, partial) {
    const prev = this.bots.get(username) ?? makeDefaultBotState(username)
    const next = { ...prev, ...partial, username, updatedAt: Date.now() }
    this.bots.set(username, next)
    this._notify()
    return next
  }

  removeBot (username) {
    if (!this.bots.delete(username)) return
    this._notify()
  }

  setMatch (partial) {
    this.match = { ...this.match, ...partial }
    this._notify()
  }

  subscribe (fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  _notify () {
    for (const fn of this._listeners) {
      try { fn(this) } catch (e) { /* swallow — a bad listener shouldn't kill bots */ }
    }
  }
}

export class Coordinator {
  constructor ({ tickMs = DEFAULT_TICK_MS } = {}) {
    this.blackboard = new TeamBlackboard()
    this.tickMs = tickMs
    this._handle = null
  }

  registerBot (username, partial = {}) {
    this.blackboard.upsertBot(username, { state: 'connecting', ...partial })
  }

  report (username, partial) {
    if (!this.blackboard.bots.has(username)) {
      this.blackboard.upsertBot(username, partial)
      return
    }
    this.blackboard.upsertBot(username, partial)
  }

  removeBot (username) {
    this.blackboard.removeBot(username)
  }

  start () {
    if (this._handle) return
    this._handle = setInterval(() => this.tick(), this.tickMs)
    if (this._handle.unref) this._handle.unref()
  }

  stop () {
    if (!this._handle) return
    clearInterval(this._handle)
    this._handle = null
  }

  // Strategic tick — §1 utility scoring. Constraints (§2) and auctions (§3)
  // layer in next; for now: score every intent per bot, pick winner with
  // hysteresis, write trace back so the TUI can render it.
  tick () {
    const bb = this.blackboard
    if (bb.bots.size === 0) return

    const traces = new Map()
    for (const [username, state] of bb.bots) {
      const previous = state.intent?.kind ?? null
      const result = scoreAll(state, bb, previous)
      traces.set(username, result)
    }

    applyConstraints(traces, bb)

    for (const [username, trace] of traces) {
      const prev = bb.bots.get(username)
      bb.upsertBot(username, {
        intent: trace.chosen ? { kind: trace.chosen } : prev?.intent ?? null,
        decision_trace: {
          scores: trace.scores,
          chosen: trace.chosen,
          runner_up: trace.runner_up,
          hysteresis_held: trace.hysteresis_held,
          time_regime: trace.regime,
          time_multipliers: trace.time_multipliers,
          preempt: trace.preempt ?? null,
          constraint_overrides: trace.constraint_overrides ?? [],
          recent_auctions: [],
        },
      })
    }

    bb.setMatch({ regime: traces.values().next().value?.regime ?? null })
  }
}

function makeDefaultBotState (username) {
  return {
    username,
    kit: null,
    team: null,
    role: null,        // attacker | defender | flex | carrier | support
    state: 'idle',     // connecting | spawned | idle | engaging | retreating | dead
    pos: null,         // { x, y, z }
    hp: null,
    maxHp: null,
    food: null,
    target: null,      // { username, dist, team }
    intent: null,      // { kind, target?, anchor? } — see NEXT.md BotIntent
    decision_trace: null, // §4 trace — populated by tick()
    lastDecision: null,
    updatedAt: Date.now(),
  }
}

/**
 * @typedef {Object} BotState
 * @property {string} username
 * @property {string|null} kit
 * @property {string|null} team
 * @property {string|null} role
 * @property {string} state
 * @property {{x:number,y:number,z:number}|null} pos
 * @property {number|null} hp
 * @property {number|null} maxHp
 * @property {number|null} food
 * @property {{username:string,dist:number,team:string|null}|null} target
 * @property {{kind:string,target?:any,anchor?:any}|null} intent
 * @property {string|null} lastDecision
 * @property {number} updatedAt
 */
