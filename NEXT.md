# Next

Working roadmap for `mcctf-bots`. Personal notes, not a public changelog.

## ⏯ Resume point (2026-05-22)

Mid-task: wiring intent → bot movement. Coordinator scoring + per-bot perspective + observer + regime clock all working; bots see the right intents but don't act on them yet.

**Done this session:**
- `src/coordinator/scoring.js`, §1 utility scoring, regime classifier, retreat preempt, hysteresis. Per-bot perspective via `bb.match.teamColors[bot.team] → ourColor`.
- `src/coordinator.js`, `tick()` runs scoring, writes `intent` + `decision_trace` per bot. Color-keyed `match` shape (`flags.{Red,Blue}`, `anchors.{Red,Blue}`, `caps.{Red,Blue}`).
- `src/coordinator/observer.js`, chat (stole/picked up/dropped/captured/recovered) + sidebar (`[X/Y] Ends in MM:SS`, `Captures N/M`, `Flag Home|Taken|Dropped`, `Held by X`) → blackboard. Records team→color mapping from `X - Your Team` marker. matchTotalMs floored on `ASSUMED_MATCH_LENGTH_MS = 20*60*1000`.
- `src/tui.js`, 3-col layout for ≥9 bots, scrollable card area, per-bot decision_trace card, header shows both colors' caps + flag states + regime.
- `src/intent-executor.js`, **written but NOT wired**. Per-bot 1 Hz loop translating intent → pathfinder goal / pvp target.
- Removed `coordinateTeams` /switch logic from `src/index.js`, it was fighting MCCTF's autobalancer.

**Verified live:** 9 bots on the running test server. Human captured Red flag during run → Red bots scored `return(12-15)` (chase carrier), Blue bots scored `escort(8.1)` (TheRealPolpy is their carrier). Distance-based score variation working.

**Immediate next steps to resume:**

1. **Wire executor into `src/index.js`**, import `attachExecutor`, call it in `spawnBot()` next to `attachObserver`, detach on `bot.once('end')`. Remove the `engageLoop` function and its setTimeout-4000 call site (the executor's `push`/`defend`/`return` branches replace it).
2. **Smoke test 9 bots**, expect Red bots to actually chase a Red-flag carrier this time, Blue bots to follow whichever teammate has the Blue-team-stolen flag, low-HP bots to walk back to their team spawn (`retreat`).
3. **Likely fix-ups after first run:**
   - Pathfinder goal conflicts: bots might thrash if executor sets a `GoalNear` while pvp is mid-chase. The executor `stop()`s pvp before setting strategic goals, verify this doesn't break combat.
   - Enemy flag anchor: still unknown until a Red player stole-events the Blue flag (or vice versa). Until then, `push` falls back to "nearest enemy" via `nearestEntityPlayer`. Bots without nearby enemies will idle.
   - For the bot's own perspective on its current intent target: the blackboard's `intent: { kind }` doesn't carry the target position. Executor derives it each tick from `match.anchors` / `match.flags`. Consistent so far.
4. **Once movement is observable, advance through TEAM-DECISIONS sequencing:**
   - Step 4 in `TEAM-DECISIONS.md`: tune §1 weights via TUI playtesting, then layer §2 constraints one at a time (start with `at_least(1, defend)`).
   - Step 5: §3 auctions for reactive tasks.
   - Step 6: 5v5 acceptance test.

**Open issues parked:**
- Regime clock floor on `ASSUMED_MATCH_LENGTH_MS`, see Risk-watch items below.
- Per-team strategy split: one Coordinator runs both teams' bots, the color-keyed blackboard works, but if/when we want per-team policy (e.g., different weights for the team that's losing), we'd factor by `bot.team` at the policy layer too.

**Key files at the resume point:**
- `mcctf-bots/TEAM-DECISIONS.md`, design source of truth.
- `mcctf-bots/src/coordinator/`, `scoring.js`, `observer.js`.
- `mcctf-bots/src/intent-executor.js`, written, awaits import.
- `mcctf-bots/src/index.js`, orchestrator; still has `engageLoop` that should be removed.
- `mcctf-bots/scripts/capture-mcctf-state.mjs`, diagnostic tool; reuse for any future wire-format questions.

Test server (Paper 1.8.8, MCCTF 3.7.2) was running in the background as job `bspmwtwye` during this session, may need restart per `CLAUDE.md` launch command if rebooting from cold.

## v0 spike. Heavy bot fights humans ✅

Validated 2026-05-22.

- Single Mineflayer 1.8.8 bot connects to MCCTF on `localhost:25566`
- Picks `/heavy` kit on spawn, equipped automatically by MCCTF
- Engages nearest non-team player via mineflayer-pvp + mineflayer-pathfinder
- Auto-eats below 14/20 food via mineflayer-auto-eat
- Auto-reconnects on disconnect
- Killed `TheRealPolpy` in melee from spawn-spawn distance ~6 blocks (closed via pathfinder ~3 blocks in 2 seconds)
- Server treats it as a normal player (UUID, tab list, scoreboard, kit creation log)

What that proves: the architecture works end-to-end. Real client + community-maintained PvP plugins + zero server-side code = bot indistinguishable from a human in MCCTF's eyes. The whole class of "vanilla path doesn't fire" bugs that killed the server-side approach is gone.

## v1. Team-aware targeting + auto-eat (current)

- [x] `bot.teamMap` lookup gates engagement, only attacks confirmed-different-team players
- [x] Bot stays passive in lobby until kit assigned + team known
- [x] Bot-vs-bot works once two bots are on opposite teams
- [x] `mineflayer-auto-eat` v5 API fix, was loading the plugin but never enabling it (wrong `options`/`startAt` field names, missing `enableAuto()` call, listening for wrong event names). Now correctly: `setOpts({ minHunger: 17, priority: 'foodPoints', returnToLastItem: true })` → `enableAuto()`. Events: `eatStart`, `eatFinish`, `eatFail`. In 1.8 steak takes ~1.6s to eat; bot will pause melee to chew when HP/food drop, then re-equip sword via `returnToLastItem`.
- [x] **Kit-aware HP eat threshold.** Different MCCTF kits modify max HP via attributes, so a hardcoded `minHealth: 16` would mean "80% on default kits, 53% on Heavy-boost kits, never on low-HP kits." Now reads `bot.entity.attributes['generic.maxHealth'].value` and re-applies `minHealth = floor(maxHp * 0.8)` on every `bot.on('health')`, which fires when current OR max HP changes (kit swap, potion effects).
- [x] Manual smoke test: spawn 2 bots, watch them fight. **MCCTF autobalances on join, no `/switch` needed**: 2 bots spawned in one process were assigned `team_1` and `team_2` automatically. Team-aware targeting confirmed: bots ignored same-team players (`TheRealPolpy(team_2)@7.4m` was correctly skipped by Iris_/team_2). Pathfinder closes distance: Noah99 saw `TheRealPolpy` at 31m, pathfound across the map, engaged at d=3.9, killed via heavy melee. Bot-vs-bot direct melee didn't happen on Ancient Ruins because team spawns are 122 blocks apart and each bot finds the nearest enemy first, that's correct behavior, not a bug. Validated 2026-05-22.
- [x] Verify auto-eat actually fires in combat: applied poison effect lvl 4 via RCON to drain HP. At 14/20 HP (below `floor(20 * 0.8) = 16` threshold), bot logged `eating cooked_beef` → 1.6s later `ate (hp=14.0 food=20)`. Auto-eat re-triggered 3× as poison kept ticking. Kit-aware threshold logic confirmed working. Validated 2026-05-22.

## v2. Team coordination + observability (next major focus)

Two parallel tracks: **(a) Coordinator** drives the bots; **(b) TUI dashboard** shows what they're doing. The TUI is dev tooling that makes the coordinator debuggable, build them together, not in sequence.

### v2.a. Coordinator architecture

**The seed question:** how can a team of 5 bots coordinate to win a CTF match?

Easier here than in the Java/server-side world: when N bots share a single Node process, they share state by direct object reference. No IPC, no plugin messages, no broker. The hard part is the **decision logic**, not the transport.

Sketch:

```
class Coordinator {
  blackboard: TeamBlackboard
  bots: Bot[]
  tick() {                       // runs ~1 Hz (slow strategic loop)
    this.blackboard.refresh()    // ingest chat, scoreboard, world state
    this.assignRoles()           // who's atk / def / flex
    this.publishIntents()        // push intent to each bot
  }
}

class TeamBlackboard {
  flagCarrier:    { our: Entity?, enemy: Entity? }
  lastSeenEnemies: Map<username, { pos, t }>
  roles:          Map<botUsername, 'attacker'|'defender'|'flex'|'carrier'|'support'>
  intents:        Map<botUsername, BotIntent>
  score:          { ours: number, theirs: number }
}

type BotIntent =
  | { kind: 'push',     target: Vec3 }   // walk to enemy flag, fight along the way
  | { kind: 'return',   carrier: Entity }// chase + kill an enemy carrier
  | { kind: 'defend',   anchor: Vec3 }   // hold a position near our flag
  | { kind: 'escort',   target: Entity } // stay within N of our carrier, attack threats
  | { kind: 'capture',  base: Vec3 }     // we are the carrier, run home
  | { kind: 'retreat',  to: Vec3 }       // heal up, regroup
```

Bots run per-physics-tick (20 Hz) executing their assigned intent; coordinator runs at 1 Hz updating role assignments. Bots can request role changes (e.g. "I picked up the flag" → set role=carrier; "I'm at 3 HP" → request retreat). Coordinator approves or vetoes.

**Decision dimensions to design before coding:**

- **Role allocation policy.** Static at match start (2/2/1) or dynamic per-tick? Kit-driven (Medic always supports, Archer always defends) or assigned independently of kit? Pure heuristic for v2; ML-fit later if ever.
- **Per-bot state machine.** Transitions between *push / return / defend / escort / capture / retreat*. What triggers each? (e.g. *our flag taken → all attackers re-role as return* until carrier dies).
- **Observation channels.**
  - Chat messages (MCCTF announces flag pickup/drop/capture visibly)
  - Scoreboard sidebar (`bot.scoreboard` → captures + score)
  - Tab list (`bot.teamMap` → rosters)
  - Inventory state (am I carrying the flag wool? check helmet)
  - Vision (`bot.nearestEntity`, `bot.entities` → live enemy positions)
- **Reactive triggers** to design explicitly:
  - *our flag taken → nearest 2 defenders converge on carrier's last-seen path*
  - *our carrier within 10 blocks of cap → all available bots escort*
  - *outnumbered 2v4 at midfield → fall back to defensive line*
  - *enemy carrier alone with our flag → break combat to chase*
- **Failure modes to design against.** All 5 bots clumping. Nobody defending. Everyone retreating when one dies. Carrier engaging unnecessary combat.

**Open `TEAM-DECISIONS.md` in this dir and answer those questions before writing coordinator code.** Acceptance test: 5v5 mirror match plays to completion with non-zero score, no bot stuck on a fence, no team perpetually pushing while own flag undefended.

### v2.b. TUI dashboard

A terminal GUI in the same process showing what each bot is doing in real time. Without it, debugging the coordinator is "tail the log and squint." With it, we see role allocations flip live, observe carrier handoffs, spot bots stuck in retreat-loop instantly.

**What it shows (per bot, one card each):**

```
┌─ blockMaster ──────────────────── HEAVY ── HP 18/20 ── 🍗 16 ─┐
│ state:   engaging                                              │
│ pos:     -84.2, 69.0, 43.1   (team RED, base @ -89.5, ...)    │
│ target:  TheRealPolpy  d=2.9  (team BLUE)                      │
│ intent:  push @ enemy_flag (-95.5, 72.0, 94.5)                │
│ last:    "switched target, old one died"                     │
└────────────────────────────────────────────────────────────────┘
```

Plus a header band: match phase, score (ours vs theirs), flag carrier states, time remaining.

**Tech:** [`blessed`](https://github.com/chjj/blessed), mature Node TUI lib, no React needed. Or `ink` if we want declarative/React. Pick at implementation time; `blessed` is the lower-friction default.

**Data flow:**

```
bot --(state mutation)--> Coordinator.blackboard --(render hook)--> TUI screen
```

Each bot calls `coordinator.report({ state, intent, lastDecision, hp, food, pos, target })` on every meaningful state change. The TUI subscribes to blackboard mutations and re-renders only the affected cards (60 fps cap is overkill; 5–10 Hz is plenty).

**Verbose log toggle:** keep current `console.log` stream available via `--log-mode=verbose` for when the TUI is unhelpful (e.g. headless CI). Default `--log-mode=tui` once this lands.

**Acceptance test for v2.b:** with 5 bots running, the TUI shows 5 cards updating live; killing one shows it die-then-respawn; coordinator role-flip is visibly reflected in `intent` field within 1 second.

### v2 sequencing

1. Write `TEAM-DECISIONS.md` (design only, no code).
2. Implement minimal `Coordinator` + `TeamBlackboard` skeletons. Single role (`attacker`) for every bot. Verify nothing regresses vs. v1 standalone-bot fighting.
3. Implement TUI shell with the placeholder data the skeleton coordinator produces. Now we can *see* the coordinator running.
4. Add role allocation logic, one role at a time. Watch the TUI as we add each, verify each role's intent surfaces correctly before adding the next.
5. Add reactive triggers (flag-taken, etc.) once base roles are stable.
6. Acceptance test: 5v5 bot mirror match end-to-end.

## v2.c. Difficulty tweaks (brainstorm)

Not yet a milestone, collecting tweakable knobs so when we ship difficulty tiers (easy/medium/hard) we have a menu to pick from. Carried forward from the old `DeCTF2-NPC.archived/DESIGN.md` tier schema but re-grounded in what Mineflayer actually lets us change.

**Reaction & decision timing**
- *Engagement delay.* Currently the engageLoop ticks at 1 Hz; can be slowed to 2–3s on easy (bot spots you, hesitates), tightened to ~200 ms on hard (instant lock).
- *Target re-evaluation cadence.* How often we re-check whether the current target is still optimal (e.g. a lower-HP enemy walked into range). Slower = more "tunnel vision," easier to kite.
- *Auto-eat threshold.* `minHunger` / `minHealth` per tier, hard eats earlier (stays topped up), easy waits until almost dead.
- *Disconnect retry backoff.* Cosmetic only, affects fleet behavior more than difficulty.

**Aim & swing**
- *Look angle jitter.* mineflayer-pvp doesn't expose this directly, but we can wrap `bot.look()` to add gaussian noise on pitch/yaw before each attack call. Easy: ±8°. Hard: ±0.5°.
- *Swing cadence.* mineflayer-pvp uses `MaxDamageOffset` `TimingSolver` by default, perfect 1.8 cooldown timing. We can swap to `RandomTicks` (random within window) for easier tiers.
- *Crit-jump probability.* 1.8 crits require falling onto the target. mineflayer-pvp does hop-crit automatically. We can probabilistically suppress the jump (`crit_jump_chance = 0.3` on easy).
- *W-tap / sprint-reset.* 1.8 sprint reset = release sprint right before hitting to apply extra knockback. mineflayer-pvp may or may not do this, worth checking; if it does, expose as a per-tier flag.
- *Block-hit chance.* 1.8 sword right-click to block reduces incoming damage by 50%. Currently the bot doesn't block at all. Wire `bot.activateItem()` on incoming-attack detection, gate by tier.

**Movement**
- *Strafe pattern.* Easy: straight-line chase. Medium: circle-strafe at attack range. Hard: predictive strafe based on opponent's velocity vector.
- *Pathfinder speed.* `Movements.allowSprinting` toggle. Easy: walk only. Hard: sprint-jump-parkour.
- *Stuck detection.* How long pathfinder is allowed to be stuck before re-pathing. Easy: bot gets stuck on a fence forever. Hard: re-paths every 1s of no progress.
- *Retreat threshold.* HP at which the bot disengages and runs to base. Easy: never (suicidal). Hard: 8/20 HP retreat to heal.

**Awareness**
- *View distance for target selection.* `bot.nearestEntity` searches all loaded entities. We can artificially cap the bot's "perception" radius, easy bot ignores enemies > 20 blocks away, hard bot tracks across the whole map.
- *Reaction to being hit.* Currently no logic. Easy: keep doing what you were doing. Hard: immediately turn and engage attacker via `bot.on('entityHurt')` if it's our entity, looking up damager from server packets.
- *Flag awareness.* Easy: ignore CTF objectives entirely (pure DM behavior). Hard: full objective AI from v2.a.

**Mistakes (1.8 PvP feel)**
- *Miss chance.* Probability of swinging when out of melee range (free hit for opponent). Easy: 25%. Hard: 0%.
- *Wrong-target chance.* Probability of locking onto a teammate or projectile entity instead of the actual enemy. Easy: occasional. Hard: never.
- *Food-during-fight.* Easy bot might try to eat in the middle of melee (vulnerable). Hard bot only eats when out of combat or behind cover.

**Per-tier preset (sketch, to be refined when implementing):**

```yaml
easy:
  engage_delay_ms: 2000
  aim_jitter_deg: 8
  crit_jump_chance: 0.3
  block_chance: 0.0
  retreat_hp: 0
  view_distance: 20
  miss_chance: 0.25
medium:
  engage_delay_ms: 700
  aim_jitter_deg: 3
  crit_jump_chance: 0.65
  block_chance: 0.4
  retreat_hp: 4
  view_distance: 40
  miss_chance: 0.05
hard:
  engage_delay_ms: 200
  aim_jitter_deg: 0.8
  crit_jump_chance: 0.9
  block_chance: 0.8
  retreat_hp: 8
  view_distance: 80
  miss_chance: 0.0
```

Open question: should difficulty be **per-bot** (mix tiers in one match) or **per-fleet** (whole bot side at same tier)? Per-bot is more interesting for autofill (v4) where we'd match the lowest human skill in the lobby.

## v3. Kit-specific strategies

MCCTF kits we should specialize for (per plugin.yml aliases): `heavy, soldier, archer, assassin, chemist, dwarf, elf, engineer, mage, medic, necro, ninja, pyro, scout`.

Per-kit modules layer on top of v2's base combat. Pattern: `CombatStrategy` interface, one impl per kit, dispatched on kit choice. mineflayer-pvp's defaults are the base; kit modules override target selection (Medic prefers low-HP teammates over enemies) or movement (Archer kites at distance instead of melee-closing).

Higher priority per the original DeCTF2 maintainer's stated focus:
- [ ] Heavy ✅ (base case, works out of the box with mineflayer-pvp)
- [ ] Soldier, balanced PvP
- [ ] Medic, prioritize healing low-HP teammates over chasing kills
- [ ] Archer, maintain range, kite
- [ ] Pyro, fire-based, AoE
- [ ] Ninja, stealth/mobility, ambush

Lower priority: Engineer, Chemist, Mage, Dwarf, Elf, Scout, Necro, Angel, Wraith, Paladin, Dragger, Shade, Weirdo, Fashionista, Warlock.

## v4. Autofill controller

Per the original spec carried forward: match always has ≥10 players. If a human joins, a bot leaves. If a human leaves, a bot enters. Match never stalls for lack of players.

- Spawn supervisor watches `bot.players` events
- Floor: 10 total
- Mid-match bot spawn must drop a bot cleanly into an active `BattleDuringGameStateHandler` state (test how MCCTF handles late-joiners)
- Mid-match bot despawn: if bot is carrying flag, drop it before disconnecting; send a quit chat line
- Per-skill matchmaking later (difficulty tiers tuning aim noise, reaction delay)

## Open questions for later

- **Skins.** Offline-mode joins mean no skins. Acceptable for v0–v2; revisit if it bothers playtesters.
- **Disconnect resilience.** Bot retries every 5s. Should we cap retries? Backoff?
- **Multi-arena.** MCCTF transitions between maps. Bots stay connected through map changes, verify this in v2 testing.
- **Bot personality variation.** Should each bot have slightly different `mineflayer-pvp` tuning (reaction time, miss chance) so they don't all play identically?
- **Anti-spectator.** If a human ops a bot into spectator/creative via `/gamemode`, bot should detect and exit/rejoin.

## Risk-watch items

- **mineflayer-pvp's deprecated `physicTick` event**, fires a console warning at startup. Cosmetic. If it ever stops firing in a future mineflayer release, combat breaks silently. Keep eye on mineflayer changelog.
- **`bot.teamMap` timing.** Strict targeting requires both us and the target to be team-assigned before the bot engages. If MCCTF ever delays team assignment past kit selection, bots will sit idle. Easy to debug, engageLoop would skip with no target.
- **MCCTF EOL warning.** ViaVersion 5.9 prints "1.8.x has reached end of life" on boot. Functional, but a future Via release may drop 1.8 entirely. Pin ViaVersion if we see this.
- **Java version.** [[mcctf-java-version]], server must launch on Java 17+ despite being 1.8.8 MC. The 32-bit Java 8 silently drops all plugins. Always use `C:\Program Files\Java\jdk-22\bin\java.exe`.
- **Regime clock floors on `ASSUMED_MATCH_LENGTH_MS = 20*60*1000`.** Observer uses `max(observedMax, 20:00)` as `matchTotalMs`, derives `elapsedMs = matchTotalMs - remainingMs`. Known fragilities:
  - If MCCTF ships maps with non-20-min match length, late-joiners get wrong `elapsedMs`. Fix: read the value from MCCTF map config or detect via watching the highest title value early in the match.
  - Map change mid-fleet: `matchTotalMs` carries over. If the next map is shorter, `elapsedMs` looks too low for a tick or two until the new max is observed. Reset on `Resets in` / `Next map in` title transition. Not implemented.
  - Affects only the `early` regime (first 30s); `clock_kill` / `must_score` / `last_swing_*` use `remainingMs` directly and are immune.

## Workflow reminders

- Build: there is no build. `npm install`, then `node src/index.js`.
- Restart-on-code-change: stop the bot (TaskStop ID, or Ctrl+C), restart. No "redeploy" cycle like the Java plugin world.
- Server stop: `node scripts/rcon-stop.mjs 127.0.0.1 25577 <your-rcon-password> stop`.
- Reference algorithms: `../DeCTF2-NPC.archived/reference/pvp-bot-fabric/` if mineflayer-pvp ever falls short, but we have not needed to crack this open yet.
