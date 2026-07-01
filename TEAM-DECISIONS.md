# TEAM-DECISIONS

Design choices for the v2.a Coordinator. Settle these here BEFORE writing coordinator code, per `NEXT.md` sequencing step 1.

**Scope:** 5v5 (or N-v-N), **all bots running the Heavy kit**. Per-kit scoring bias is deferred, see `NEXT.md` v3 for the kit-specific roadmap. v2.a treats every bot as identical at the scoring layer.

---

## The four pillars

1. **Utility scoring** per bot for each intent, every coordinator tick. Time-aware.
2. **Team needs as constraints**, not headcounts. Coordinator only overrides utility when a constraint breaks.
3. **Auctions for one-shot reactive tasks** (enemy carrier spotted, lone teammate in trouble).
4. **Hysteresis + TUI surfacing** so the team behavior is debuggable, not a black box.

Skipped for v2.a: per-kit scoring weights, ML-fit role assignment, plugin-message channels to MCCTF.

---

## 1. Utility scoring (with time-pressure)

Every coordinator tick (1 Hz), each bot computes a score for each possible intent. The coordinator picks the highest-scoring intent per bot, subject to constraints (§2).

### Intents in scope

`push`, `defend`, `return`, `escort`, `capture`, `retreat`, same set as `NEXT.md` `BotIntent`.

### Score formula

```
score(bot, intent) = base_fit(bot, intent) × team_need(intent) × time_pressure(intent) − cost(bot, intent)
```

- **`base_fit`**, how well does *this bot, right now* match this intent?
  - distance from bot to the relevant anchor (closer = higher for `defend` / `return` / `capture`; less relevant for `push`)
  - current HP (low HP downweights `push` / `return`, upweights `retreat`)
  - inventory state (carrying flag wool → `capture` dominates; out of food → `retreat` upweights)
- **`team_need`**, global multipliers driven off blackboard state:
  - our flag taken → `return` ×2.0 for everyone
  - we hold enemy flag → `escort` ×1.8 for non-carriers, `capture` ×3.0 for the carrier
  - midfield empty for >5 s → `push` ×1.3
- **`time_pressure`**, match-clock-aware multiplier. This is the dimension to design carefully:
  - **First 30 s of match:** `defend` ×0.7. No flag has moved yet; defenders are wasted.
  - **Tied score, <30 s left:** `push` ×2.0 if we don't hold a flag, `defend` ×2.0 if we do. Last-moment swing.
  - **Ahead on score, <60 s left:** `defend` ×1.6, `push` ×0.6. Clock-kill mode.
  - **Behind on score, <60 s left:** `push` ×1.6, `defend` ×0.4. Must-score mode.
  - **Otherwise (mid-match, normal):** all multipliers 1.0.
- **`cost`**, pathing time, blocks-to-traverse, expected damage. Subtracted (not multiplied) so a bad intent can score negative.

### Design decision: weights as data, not code

Put weights in `src/coordinator/scoring.js` as a plain object. Playtest tuning shouldn't require touching logic.

```js
const WEIGHTS = {
  push:   { hp: 0.6, distance: 0.4, /* ... */ },
  defend: { proximity_to_our_flag: 1.0, hp: 0.3, /* ... */ },
  // ...
};
```

### TODO

- [ ] Scrape match duration + elapsed from MCCTF scoreboard sidebar on match start. Store in `blackboard.match.{startedAt, durationMs, remainingMs}`. If sidebar doesn't expose total duration, infer from countdown text format and pin it.
- [ ] Define `score(bot, intent, blackboard) → number` in `src/coordinator/scoring.js`.
- [ ] Implement `base_fit` for each of the 6 intents (simple distance + HP first; layer in nuance later).
- [ ] Implement `team_need` multipliers off blackboard state (`flagCarrier`, `score`, `lastSeenEnemies`).
- [ ] Implement `time_pressure` curve per the bullets above. Each tick computes a `regime` label: `early | normal | clock_kill | must_score | last_swing`.
- [ ] Tie-break rule: when two intents score within 5%, prefer the one the bot already has. (Seeds hysteresis, §4.)

### Open questions to revisit during playtest

- `retreat` as an intent vs. a meta-state that pre-empts everything below an HP threshold. **Lean: pre-empt.** A 3 HP bot scoring `push` highest because it's next to the flag is a bug, not a feature.
- Score against all 6 intents every tick, or short-circuit for obvious cases (carrier → `capture`)? Start with all 6; short-circuit only if profiling demands.

---

## 2. Team needs as constraints

Constraints sit on top of utility scoring. The coordinator intervenes only when a constraint is violated.

### Starter constraints (v2.a)

- `at_least(1, bot.near(our_flag, radius=30))`, someone is always near our flag.
- `at_least(1, bot.intent === 'push')`, never all 5 turtling on defense.
- `no_more_than(3, bot.intent === 'push')`, never all 5 yolo'ing while own flag undefended.
- `at_least(1, bot.escorting(our_carrier))`, when we have a carrier, one bot is glue.
- `no_more_than(1, bot.intent === 'capture')`, only the actual carrier captures.

### Resolution algorithm

```
for each violated constraint:
  candidates = bots whose current intent does NOT satisfy the constraint
  pick the bot with the smallest score_loss = (current_intent_score − required_intent_score)
  override that bot's intent to satisfy the constraint
```

Cheapest re-assignment first. Minimal disruption.

### Conflict priority

When constraints conflict (e.g. 3 bots alive, can't satisfy both `at_least(1, defend)` and `at_least(1, push)` if one is the carrier), use a static priority order:

1. carrier escort (winning the match)
2. flag defense (preventing a loss)
3. push presence (offense exists at all)
4. push cap (don't overcommit)

### TODO

- [ ] Define `Constraint` interface in `src/coordinator/constraints.js`: `{ name, check(blackboard, assignments) → bool, fix(blackboard, assignments) → newAssignments }`.
- [ ] Implement the 5 starter constraints.
- [ ] Run constraint pass AFTER utility scoring, BEFORE intent publish.
- [ ] Log every constraint override into the blackboard so the TUI can render: `OVERRIDE: push → defend (constraint: at_least_1_near_our_flag)`.

---

## 3. Auctions for one-shot reactive tasks

For events that fire between ticks, broadcast a task and let bots bid.

### Tasks that warrant an auction

- *Enemy carrier spotted with our flag* → who chases? Payoff: large.
- *Teammate dropped below 6 HP, mid-combat* → who breaks off to assist? Payoff: medium.
- *Our carrier <10 blocks from cap, alone* → who escorts the seal? Payoff: very large.
- *Open lane to enemy flag, no defender visible* → who exploits? Payoff: medium.

### Bid formula

```
bid = payoff − cost(distance_to_task, hp_penalty, current_intent_value)
winner = max bid; ties broken by lowest current_intent_value
```

Where `current_intent_value` is exactly the utility score from §1, directly the cost of abandoning the current intent. §1 and §3 share the same score function.

### Lifecycle rules

- Auctions fire synchronously on event detection (chat parse, scoreboard delta, entity proximity).
- Winner's `intent` becomes the task. Losers persist their current intent.
- Each task carries an `expiresAt`. If the winner hasn't completed it by then: re-auction **once**, then drop.
- A bot can win a new auction while holding one, only if the new payoff exceeds the remaining payoff of the current task.
- Auctions are paused during the coordinator's own tick to avoid double-assignment. Tick is source of truth for `intent`; auctions only flip bots between ticks.

### TODO

- [ ] Define `Task` shape: `{ kind, payoff, anchor, expiresAt }`.
- [ ] Event detectors that publish tasks: parse MCCTF chat lines (flag pickup / drop / capture), watch `bot.scoreboard`, watch `bot.entities` for proximity triggers.
- [ ] Implement `auction(task, bots) → winnerBot` synchronously when a task fires.
- [ ] Log every auction (task, all bids, winner) to the blackboard for TUI rendering.

---

## 4. Hysteresis + TUI integration

Without hysteresis, per-tick utility scoring flips bots between intents constantly. The TUI ([NEXT.md v2.b](NEXT.md)) is what makes the whole system debuggable, and needs structured data showing *why* each decision was made.

### Hysteresis rule

A bot keeps its current intent unless a competing intent beats it by **≥20% of the current intent's score**. Margin tunable per intent:

- `retreat` → 0% margin (escape is always urgent)
- `escort` → 30% margin (carrier handoffs are costly)
- everything else → 20%

### `decision_trace` (what the coordinator must emit per bot, every tick)

Plug this into the TUI work already in progress, extend the per-bot card from `NEXT.md` v2.b.

```js
{
  scores: { push: 6.1, defend: 7.2, return: 4.0, escort: 2.1, capture: 0, retreat: 1.4 },
  chosen: 'defend',
  runner_up: 'push',          // for hysteresis transparency
  hysteresis_held: true,      // true if we kept current intent despite a near-miss challenger
  time_regime: 'clock_kill',  // early | normal | clock_kill | must_score | last_swing
  time_multipliers: { defend: 1.6, push: 0.6 },
  constraint_overrides: [],   // [{ from: 'push', to: 'defend', constraint: 'at_least_1_near_our_flag' }]
  recent_auctions: [          // last few, for transient flash rendering
    { task: 'flag_chase', won: false, my_bid: 6.4, winning_bid: 8.1, winner: 'lighterBot' },
  ],
}
```

### TUI card sketch (extending v2.b)

```
┌─ blockMaster ──────────────────── HEAVY ── HP 18/20 ── 🍗 16 ─┐
│ intent:    defend  (score 7.2)                                 │
│ runner-up: push    (score 6.1)  ← 18% below, held by hyst.    │
│ regime:    clock_kill  (defend ×1.6, push ×0.6)               │
│ overrides: none                                                │
│ last auction: lost flag_chase to lighterBot (6.4 vs 8.1)      │
└────────────────────────────────────────────────────────────────┘
```

### Header band

- match time elapsed / remaining
- time_pressure regime (with visual cue when it changes, e.g. flash on transition into `clock_kill`)
- active constraints: all satisfied vs N violated, with which ones

### TODO

- [ ] Coordinator emits `decision_trace` per bot per tick into the blackboard.
- [ ] TUI subscribes to blackboard mutations, renders the fields above per bot card.
- [ ] Header band: time / regime / constraint status.
- [ ] Verify in TUI: when the clock crosses into <60 s and we're ahead, every bot card visibly shifts toward `defend` within one tick.
- [ ] Verify auctions render as transient flashes on the relevant bot card.

---

## Acceptance test (carried from `NEXT.md`)

5v5 Heavy-only mirror match plays to completion with:

- non-zero score on at least one side
- no bot stuck on a fence for more than 5 s
- no team perpetually pushing while own flag undefended (constraint §2 prevents this)
- TUI shows live score traces, at least one constraint override during the match, and at least one auction
- visible regime transition into `clock_kill` or `must_score` in the final 60 s

---

## Sequencing into `NEXT.md` v2.a

This document supersedes `NEXT.md` v2.a step 1. Subsequent steps map as:

- **Step 2 (skeleton coordinator)** → implement §1 with placeholder weights, no constraints / auctions yet.
- **Step 3 (TUI shell)** → wire `decision_trace` from §4.
- **Step 4 (role allocation, one role at a time)** → tune §1 weights, layer §2 constraints in one at a time, validating each in the TUI.
- **Step 5 (reactive triggers)** → §3 auctions.
- **Step 6 (acceptance test)** → as above.
