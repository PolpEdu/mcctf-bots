// Team-level constraints layered on top of §1 utility scoring. TEAM-DECISIONS §2.
//
// Each constraint inspects the per-bot intent assignments (output of scoreAll)
// and, if violated, picks the cheapest reassignment(s) to satisfy it. Cheapest
// = smallest score_loss = (current_chosen_score - constraint_intent_score).
//
// Applied per-team (Red / Blue) because counts like "at least 2 pushers" are
// per-roster, not fleet-wide.
//
// Output: mutates each trace in `traces` in place — flips `chosen` and appends
// to `constraint_overrides`. Hysteresis was already applied upstream in
// scoreAll; constraints override hysteresis (team need > individual stickiness).

const CONSTRAINTS = [
  { name: 'at_least_1_defend', n: 1, intent: 'defend', priority: 2 },
  { name: 'at_least_2_push',   n: 2, intent: 'push',   priority: 3 },
]

export function applyConstraints (traces, bb) {
  const teamColors = bb.match?.teamColors ?? {}
  const byColor = new Map()
  for (const [username] of traces) {
    const team = bb.bots.get(username)?.team
    const color = team ? teamColors[team] : null
    if (!color) continue
    if (!byColor.has(color)) byColor.set(color, [])
    byColor.get(color).push(username)
  }

  for (const [, members] of byColor) {
    for (const c of [...CONSTRAINTS].sort((a, b) => a.priority - b.priority)) {
      enforceAtLeast(c, members, traces)
    }
  }
}

function enforceAtLeast (c, members, traces) {
  const have = members.filter((u) => traces.get(u).chosen === c.intent).length
  if (have >= c.n) return

  const candidates = members
    .filter((u) => traces.get(u).chosen !== c.intent)
    .map((u) => {
      const t = traces.get(u)
      const cur = t.scores?.[t.chosen] ?? 0
      const next = t.scores?.[c.intent]
      if (!Number.isFinite(next)) return null
      return { username: u, loss: cur - next }
    })
    .filter((x) => x != null)
    .sort((a, b) => a.loss - b.loss)

  const need = c.n - have
  for (let i = 0; i < need && i < candidates.length; i++) {
    const { username } = candidates[i]
    const t = traces.get(username)
    if (!t.constraint_overrides) t.constraint_overrides = []
    t.constraint_overrides.push({ from: t.chosen, to: c.intent, constraint: c.name })
    t.chosen = c.intent
  }
}
