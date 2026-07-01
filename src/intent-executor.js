// Per-bot executor: turns coordinator-chosen intents into actual bot actions.
//
// Subscribes to `bb.bots[username].intent.kind` at 1 Hz. Replaces the v1
// engageLoop entirely — combat target selection now flows from intent rather
// than "nearest enemy in entity list."
//
// Intent → action mapping (TEAM-DECISIONS §1, BotIntent in NEXT.md):
//
//   retreat  pathfind to ourBase, NO combat                  (HP preempt or low score)
//   defend   hold near ourFlag; engage anything within ~15b   (idle defender)
//   push     pathfind to enemyFlag; fall back to nearest enemy when no anchor
//   return   bot.pvp.attack(theirCarrier) — the enemy holding our flag
//   escort   GoalFollow(ourCarrier) — a teammate carrying enemy flag
//   capture  pathfind to ourBase as the carrier — avoid combat unless blocked
//
// Idempotence: re-applying the same goal each tick is wasted CPU.
// Diff against `lastKey` and skip when unchanged.

import pathfinderPkg from 'mineflayer-pathfinder'

const { goals } = pathfinderPkg
const { GoalNear, GoalFollow, GoalGetToBlock } = goals

// MCCTF flags are always fence blocks. Pickup triggers when the bot is at a
// cardinal-adjacent block (not diagonal). GoalGetToBlock's isEnd is exactly
// "Manhattan distance == 1", so it never parks the bot on a diagonal.

const TICK_MS = 1000
const DEFEND_HOLD_RANGE = 5      // bot is "at" the defend anchor within this
const DEFEND_ENGAGE_RANGE = 15   // engage enemies who breach this radius
const ESCORT_RANGE = 4           // stay this close to our carrier

// Spread N bots' apply() calls uniformly across the tick window. Without this,
// SPAWN_STAGGER_MS=500 leaves 9 bots clustered on two phase offsets (0/500ms),
// so up to ~5 bots fire setGoal in the same Node turn — A* stacks into 50ms+
// event-loop stalls (the "freeze then snap" lag). Random phase per bot
// decorrelates the kick-offs.
export function attachExecutor (bot, coordinator, username) {
  const bb = coordinator.blackboard
  let lastKey = ''
  let intervalHandle = null
  let retryHandle = null

  const startHandle = setTimeout(() => {
    apply()
    intervalHandle = setInterval(apply, TICK_MS)
    intervalHandle.unref?.()
  }, Math.random() * TICK_MS)
  startHandle.unref?.()

  // Surface pathfinder lifecycle so we can tell whether setGoal silently fails.
  //
  // Two-tier re-eval: events that genuinely change the world (forcedMove,
  // stoppedAttacking) reset lastKey AND immediately re-fire apply(), because
  // pathfinder sometimes silently doesn't grab the first setGoal and we need
  // to retry once the new world state is in. goal_reached is NOT one of these
  // — re-issuing setGoal to the place we already are fires goal_reached again
  // → shake/jitter loop. Just log.
  const invalidateMemo = () => { lastKey = '' }
  const reapply = () => { invalidateMemo(); apply() }
  // path:timeout / path:noPath can fire on all 9 bots in the same Node turn
  // when the fleet's A* is saturated. Re-issuing setGoal immediately just
  // re-saturates it. Jittered backoff (0–200ms) decorrelates retries.
  const reapplyBackoff = () => {
    if (retryHandle) return
    retryHandle = setTimeout(() => { retryHandle = null; reapply() }, Math.random() * 200)
    retryHandle.unref?.()
  }
  const onGoalReached = () => log('goal_reached')
  const onPathUpdate = (r) => {
    if (r?.status === 'noPath') { log('path:noPath'); reapplyBackoff() }
    else if (r?.status === 'timeout') { log('path:timeout'); reapplyBackoff() }
  }
  const onStoppedAttacking = () => { log('stoppedAttacking'); reapply() }
  const onForcedMove = () => { log('forcedMove'); reapply() }
  bot.on?.('goal_reached', onGoalReached)
  bot.on?.('path_update', onPathUpdate)
  bot.on?.('stoppedAttacking', onStoppedAttacking)
  bot.on?.('forcedMove', onForcedMove)

  function log (msg) {
    console.log(`[${new Date().toISOString()}] ${username}: exec ${msg}`)
  }

  function detach () {
    clearTimeout(startHandle)
    if (intervalHandle) clearInterval(intervalHandle)
    if (retryHandle) clearTimeout(retryHandle)
    bot.off?.('goal_reached', onGoalReached)
    bot.off?.('path_update', onPathUpdate)
    bot.off?.('stoppedAttacking', onStoppedAttacking)
    bot.off?.('forcedMove', onForcedMove)
    try { bot.pvp?.stop?.() } catch {}
    try { bot.pathfinder?.stop?.() } catch {}
  }
  return detach

  function apply () {
    if (!bot.entity) return
    const state = bb.bots.get(username)
    if (!state) return
    const intent = state.intent?.kind
    if (!intent) return

    const team = state.team
    const colors = bb.match.teamColors ?? {}
    const ourColor = team ? colors[team] : null
    const enemyColor = ourColor ? (ourColor === 'Red' ? 'Blue' : 'Red') : null
    const anchors = bb.match.anchors ?? {}
    const flags = bb.match.flags ?? {}

    let key = `${intent}:${ourColor ?? '?'}`
    let action = null

    switch (intent) {
      case 'retreat': {
        const dest = ourColor ? anchors[ourColor]?.base : null
        if (dest) { key += `:${vk(dest)}`; action = () => gotoNear(dest, 3) }
        else { key += ':stop'; action = stopMovement }
        break
      }
      case 'defend': {
        const dest = ourColor ? (anchors[ourColor]?.flag ?? anchors[ourColor]?.base) : null
        const nearEnemy = nearestEnemyPlayer(ourColor)
        if (nearEnemy && distance(bot.entity.position, nearEnemy.position) < DEFEND_ENGAGE_RANGE) {
          key += `:engage:${nearEnemy.username}`
          action = () => attackEntity(nearEnemy)
        } else if (dest && distance(bot.entity.position, dest) > DEFEND_HOLD_RANGE) {
          key += `:${vk(dest)}`
          action = () => gotoNear(dest, DEFEND_HOLD_RANGE)
        } else {
          key += ':hold'
          action = stopMovement
        }
        break
      }
      case 'push': {
        const dest = enemyColor ? anchors[enemyColor]?.flag : null
        const enemy = nearestEnemyPlayer(ourColor)
        // Prefer engaging an enemy if one's in sight; otherwise march toward
        // the enemy flag and stand cardinal-adjacent to its block.
        if (enemy && distance(bot.entity.position, enemy.position) < 30) {
          key += `:engage:${enemy.username}`
          action = () => attackEntity(enemy)
        } else if (dest) {
          key += `:${vk(dest)}`
          action = () => gotoBlock(dest)
        } else {
          key += ':idle'
          action = null
        }
        break
      }
      case 'return': {
        const carrier = ourColor ? flags[ourColor]?.heldBy : null
        const entity = carrier ? bot.players?.[carrier]?.entity : null
        if (entity) {
          key += `:chase:${carrier}`
          action = () => attackEntity(entity)
        } else {
          // Carrier known but not in our entity list — path toward last known.
          const pos = ourColor ? flags[ourColor]?.carrierPos : null
          if (pos) { key += `:gotoCarrier:${vk(pos)}`; action = () => gotoNear(pos, 3) }
        }
        break
      }
      case 'escort': {
        const ourCarrier = enemyColor ? flags[enemyColor]?.heldBy : null
        if (ourCarrier && ourCarrier !== username) {
          const entity = bot.players?.[ourCarrier]?.entity
          if (entity) {
            key += `:follow:${ourCarrier}`
            action = () => follow(entity, ESCORT_RANGE)
          } else {
            const pos = enemyColor ? flags[enemyColor]?.carrierPos : null
            if (pos) { key += `:gotoCarrier:${vk(pos)}`; action = () => gotoNear(pos, ESCORT_RANGE) }
          }
        }
        break
      }
      case 'capture': {
        const dest = ourColor ? anchors[ourColor]?.base : null
        if (dest) { key += `:${vk(dest)}`; action = () => gotoNear(dest, 2) }
        break
      }
    }

    if (key === lastKey) return
    lastKey = key
    log(`apply ${key}`)
    if (action) action()
  }

  // ---- action primitives ----

  function gotoNear (pos, range) {
    try { bot.pvp?.stop?.() } catch {}
    if (!bot.pathfinder) { log('NO PATHFINDER PLUGIN'); return }
    bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, range))
  }

  function gotoBlock (pos) {
    try { bot.pvp?.stop?.() } catch {}
    if (!bot.pathfinder) { log('NO PATHFINDER PLUGIN'); return }
    bot.pathfinder.setGoal(new GoalGetToBlock(pos.x, pos.y, pos.z))
  }

  function follow (entity, range) {
    try { bot.pvp?.stop?.() } catch {}
    if (!bot.pathfinder) { log('NO PATHFINDER PLUGIN'); return }
    bot.pathfinder.setGoal(new GoalFollow(entity, range), true)
  }

  function attackEntity (entity) {
    try { bot.pvp.attack(entity) } catch {}
  }

  function stopMovement () {
    try { bot.pathfinder?.stop?.() } catch {}
    try { bot.pvp?.stop?.() } catch {}
  }

  function nearestEnemyPlayer (ourColor) {
    if (!bot.nearestEntity) return null
    return bot.nearestEntity((e) => {
      if (e.type !== 'player' || !e.username || e.username === username) return false
      const team = bot.teamMap?.[e.username]?.name
      if (!team) return false
      const myTeam = bot.teamMap?.[username]?.name
      return team !== myTeam
    })
  }
}

function distance (a, b) {
  if (!a || !b) return Infinity
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function vk (p) { return `${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}` }
