// Utility scoring for bot intents — TEAM-DECISIONS §1.
//
// score(bot, intent, blackboard) = base_fit * team_need * time_pressure - cost
//
// Weights live in WEIGHTS as a plain object so playtest tuning doesn't require
// touching logic. Anchors (our flag, enemy flag, our base) are read off the
// blackboard.match.anchors slot — populated later by the chat/scoreboard
// observers; for now an unset anchor just zeros out the distance term, which
// pushes scores toward the intents that don't depend on it.

export const INTENTS = ['push', 'defend', 'return', 'escort', 'capture', 'retreat']

// Pre-empt threshold. A bot below this HP scores `retreat` above everything
// else regardless of how the other terms shake out. Open question §1 resolved
// in favor of pre-empt — see TEAM-DECISIONS line 73.
export const RETREAT_HP_PREEMPT = 6

// Hysteresis margins per intent. Bot keeps its current intent unless a
// challenger beats it by at least this fraction of the current score.
export const HYSTERESIS_MARGIN = {
  retreat: 0.0,   // escape is always urgent
  escort:  0.30,  // handoffs are costly
  push:    0.20,
  defend:  0.20,
  return:  0.20,
  capture: 0.20,
}

// Tunable weights. Mostly multiplicative shaping inside base_fit so each
// intent's distance / HP / inventory contribution can be tweaked independently.
// Numbers are placeholders — to be tuned in TEAM-DECISIONS §5 (step 4).
export const WEIGHTS = {
  push: {
    base:       5.0,
    distance:   0.04,   // per block from enemy flag — subtractive
    hpBonus:    0.05,   // per HP above half
  },
  defend: {
    base:       4.0,
    proximity:  0.06,   // per block CLOSER than 40 to our flag
    hpBonus:    0.02,
  },
  return: {
    base:       6.0,
    proximity:  0.05,   // per block CLOSER than 40 to enemy carrier's last pos
    hpBonus:    0.04,
  },
  escort: {
    base:       4.5,
    proximity:  0.08,   // per block CLOSER than 20 to our carrier
  },
  capture: {
    base:      10.0,    // carrier-only; gated in base_fit
    proximity:  0.04,   // per block CLOSER to our base
  },
  retreat: {
    base:       3.0,
    hpDeficit:  0.4,    // per HP below half
  },
}

// Team-need multipliers driven off blackboard state. Match TEAM-DECISIONS §1.
export const TEAM_NEED = {
  ourFlagTaken_return:           2.0,
  weHoldEnemy_escortNonCarrier:  1.8,
  weHoldEnemy_captureCarrier:    3.0,
  midfieldEmpty_push:            1.3,
}

// Time-pressure regimes. Each regime is a label + multiplier map per intent.
export const TIME_REGIMES = {
  early:       { defend: 0.7 },
  clock_kill:  { defend: 1.6, push: 0.6 },
  must_score:  { push: 1.6,  defend: 0.4 },
  last_swing_offense: { push: 2.0 },
  last_swing_defense: { defend: 2.0 },
  normal:      {},
}

/**
 * Resolve a bot's color and the enemy color from the blackboard.
 * Returns null if the team→color mapping hasn't been discovered yet.
 */
function perspective (bot, match) {
  const team = bot.team ?? null
  const colors = match?.teamColors ?? {}
  const ourColor = team ? colors[team] : null
  if (!ourColor) return null
  const enemyColor = ourColor === 'Red' ? 'Blue' : 'Red'
  return { ourColor, enemyColor }
}

/**
 * Classify match state into a regime label, from this bot's perspective.
 * Returns 'early' / 'clock_kill' / 'must_score' / 'last_swing_*' / 'normal'.
 */
export function regimeOf (bot, match) {
  const elapsedMs = match?.elapsedMs ?? null
  const remainingMs = match?.remainingMs ?? null
  const persp = perspective(bot, match)
  const caps = match?.caps ?? {}
  const ours   = persp ? caps[persp.ourColor]   ?? 0 : 0
  const theirs = persp ? caps[persp.enemyColor] ?? 0 : 0
  const weHoldEnemyFlag = persp
    ? match?.flags?.[persp.enemyColor]?.state === 'carried'
    : false

  if (elapsedMs != null && elapsedMs < 30_000) return 'early'
  if (remainingMs != null && remainingMs < 30_000 && ours === theirs) {
    return weHoldEnemyFlag ? 'last_swing_defense' : 'last_swing_offense'
  }
  if (remainingMs != null && remainingMs < 60_000) {
    if (ours > theirs) return 'clock_kill'
    if (ours < theirs) return 'must_score'
  }
  return 'normal'
}

/**
 * Compute the score for a single (bot, intent) pair given current blackboard
 * state. Returns a finite number; higher = more preferred.
 */
export function scoreIntent (bot, intent, bb, opts = {}) {
  const persp = opts.persp ?? perspective(bot, bb.match)
  const regime = opts.regime ?? regimeOf(bot, bb.match)
  if (!isApplicable(bot, intent, bb, persp)) return Number.NEGATIVE_INFINITY
  const fit = baseFit(bot, intent, bb, persp)
  const need = teamNeed(bot, intent, bb, persp)
  const pressure = (TIME_REGIMES[regime] ?? {})[intent] ?? 1.0
  const c = cost(bot, intent, bb, persp)
  return fit * need * pressure - c
}

// Structural applicability — independent of how good a fit it is. An intent
// is filtered out only when there's no anchor / target / role to attach it to.
// Distance / HP just affect score; they never disqualify.
function isApplicable (bot, intent, bb, persp) {
  if (!persp) return intent === 'retreat' || intent === 'push' || intent === 'defend'
  const flags = bb.match?.flags ?? {}
  const ourCarrier = flags[persp.enemyColor]?.heldBy ?? null  // teammate carrying enemy flag
  const theirCarrierPos = flags[persp.ourColor]?.carrierPos ?? null
  const amICarrier = ourCarrier === bot.username
  switch (intent) {
    case 'return':  return !!theirCarrierPos
    case 'escort':  return !!ourCarrier && !amICarrier
    case 'capture': return !!amICarrier
    default:        return true
  }
}

/**
 * Score every intent for one bot. Returns:
 *   { scores, chosen, runner_up, hysteresis_held, regime, time_multipliers }
 *
 * Hysteresis: if `previousIntent` was chosen last tick and a higher-scoring
 * challenger does NOT exceed the per-intent margin, we keep previous.
 */
export function scoreAll (bot, bb, previousIntent = null) {
  const persp = perspective(bot, bb.match)
  const regime = regimeOf(bot, bb.match)
  const time_multipliers = TIME_REGIMES[regime] ?? {}
  const scores = {}

  if (bot.hp != null && bot.hp <= RETREAT_HP_PREEMPT) {
    for (const i of INTENTS) scores[i] = i === 'retreat' ? 100 : 0
    return {
      scores,
      chosen: 'retreat',
      runner_up: previousIntent && previousIntent !== 'retreat' ? previousIntent : null,
      hysteresis_held: false,
      regime,
      time_multipliers,
      preempt: 'low_hp',
    }
  }

  for (const i of INTENTS) {
    const s = scoreIntent(bot, i, bb, { persp, regime })
    scores[i] = Number.isFinite(s) ? round2(s) : Number.NEGATIVE_INFINITY
  }

  const ranked = INTENTS
    .filter((i) => Number.isFinite(scores[i]))
    .sort((a, b) => scores[b] - scores[a])

  if (ranked.length === 0) {
    return { scores, chosen: null, runner_up: null, hysteresis_held: false, regime, time_multipliers }
  }

  let chosen = ranked[0]
  const runner_up = ranked[1] ?? null
  let hysteresis_held = false

  if (previousIntent && previousIntent !== chosen && Number.isFinite(scores[previousIntent])) {
    const margin = HYSTERESIS_MARGIN[previousIntent] ?? 0.20
    const prevScore = scores[previousIntent]
    const lead = scores[chosen] - prevScore
    if (prevScore > 0 && lead < prevScore * margin) {
      chosen = previousIntent
      hysteresis_held = true
    }
  }

  return { scores, chosen, runner_up, hysteresis_held, regime, time_multipliers }
}

// ---- term helpers ----

function baseFit (bot, intent, bb, persp) {
  const w = WEIGHTS[intent]
  const hp = bot.hp ?? 20
  const maxHp = bot.maxHp ?? 20
  const halfHp = maxHp / 2

  if (!persp && intent !== 'retreat' && intent !== 'push' && intent !== 'defend') return 0
  const flags = bb.match?.flags ?? {}
  const anchors = bb.match?.anchors ?? {}
  const ourFlag    = persp ? anchors[persp.ourColor]?.flag   : null
  const enemyFlag  = persp ? anchors[persp.enemyColor]?.flag : null
  const ourBase    = persp ? anchors[persp.ourColor]?.base   : null
  const ourCarrier = persp ? flags[persp.enemyColor]?.heldBy : null  // teammate w/ enemy flag
  const theirCarrierPos = persp ? flags[persp.ourColor]?.carrierPos : null
  const amICarrier = ourCarrier && ourCarrier === bot.username

  switch (intent) {
    case 'push': {
      const d = distance(bot.pos, enemyFlag) ?? 80
      return w.base - d * w.distance + Math.max(0, hp - halfHp) * w.hpBonus
    }
    case 'defend': {
      const d = distance(bot.pos, ourFlag) ?? 40
      return w.base + Math.max(0, 40 - d) * w.proximity + Math.max(0, hp - halfHp) * w.hpBonus
    }
    case 'return': {
      if (!theirCarrierPos) return 0
      const d = distance(bot.pos, theirCarrierPos) ?? 40
      return w.base + Math.max(0, 40 - d) * w.proximity + Math.max(0, hp - halfHp) * w.hpBonus
    }
    case 'escort': {
      if (!ourCarrier || amICarrier) return 0
      const cpos = bb.bots?.get?.(ourCarrier)?.pos ?? null
      const d = distance(bot.pos, cpos) ?? 20
      return w.base + Math.max(0, 20 - d) * w.proximity
    }
    case 'capture': {
      if (!amICarrier) return 0
      const d = distance(bot.pos, ourBase) ?? 60
      return w.base + Math.max(0, 60 - d) * w.proximity
    }
    case 'retreat': {
      const deficit = Math.max(0, halfHp - hp)
      return w.base + deficit * w.hpDeficit
    }
    default:
      return 0
  }
}

function teamNeed (bot, intent, bb, persp) {
  let m = 1.0
  if (!persp) return m
  const flags = bb.match?.flags ?? {}
  const ourFlagState = flags[persp.ourColor]?.state
  const enemyFlagState = flags[persp.enemyColor]?.state
  const ourCarrier = flags[persp.enemyColor]?.heldBy ?? null
  const amICarrier = ourCarrier === bot.username

  if (intent === 'return' && ourFlagState === 'carried') {
    m *= TEAM_NEED.ourFlagTaken_return
  }
  if (enemyFlagState === 'carried' && ourCarrier) {
    if (intent === 'escort' && !amICarrier) m *= TEAM_NEED.weHoldEnemy_escortNonCarrier
    if (intent === 'capture' && amICarrier) m *= TEAM_NEED.weHoldEnemy_captureCarrier
  }
  if (intent === 'push' && bb.match?.midfieldEmptyMs && bb.match.midfieldEmptyMs > 5000) {
    m *= TEAM_NEED.midfieldEmpty_push
  }
  return m
}

function timePressure (intent, bb) {
  // Pulled from bb.match.regime which the coordinator stamps from the
  // first bot's perspective each tick — good enough; all bots on the same
  // team should agree, and per-team regime divergence is fine.
  const r = bb.match?.regime ?? 'normal'
  const map = TIME_REGIMES[r] ?? {}
  return map[intent] ?? 1.0
}

function cost (bot, intent, bb, persp) {
  if (!persp) return 0
  const anchors = bb.match?.anchors ?? {}
  const ourFlag   = anchors[persp.ourColor]?.flag
  const ourBase   = anchors[persp.ourColor]?.base
  const enemyFlag = anchors[persp.enemyColor]?.flag
  const target = {
    push:    enemyFlag,
    defend:  ourFlag,
    capture: ourBase,
    retreat: ourBase,
  }[intent]
  const d = distance(bot.pos, target)
  if (d == null) return 0
  return d * 0.01
}

function distance (a, b) {
  if (!a || !b) return null
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function round2 (n) { return Math.round(n * 100) / 100 }
