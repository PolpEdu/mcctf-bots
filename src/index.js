import mineflayer from 'mineflayer'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import mcDataLoader from 'minecraft-data'
import pathfinderPkg from 'mineflayer-pathfinder'
import pvpPkg from 'mineflayer-pvp'
import { loader as autoEatLoader } from 'mineflayer-auto-eat'
import { Coordinator } from './coordinator.js'
import { attachObserver } from './coordinator/observer.js'
import { attachExecutor } from './intent-executor.js'
import { Tui } from './tui.js'

const { pathfinder, Movements } = pathfinderPkg
const { plugin: pvpPlugin } = pvpPkg

const argv = parseArgs(process.argv.slice(2))
const host = argv.host ?? '127.0.0.1'
const port = Number(argv.port ?? 25566)
const count = Number(argv.count ?? 1)
const baseName = argv.username
const kit = argv.kit ?? 'heavy'
const fight = argv.fight !== 'false'
const logMode = argv['log-mode'] ?? 'verbose'  // 'tui' | 'verbose'

const namePool = loadNamePool()
const liveBots = new Set()
let shuttingDown = false

const coordinator = new Coordinator()
coordinator.start()

const tui = logMode === 'tui'
  ? new Tui(coordinator, { onQuit: () => shutdown('TUI') })
  : null

// Verbose-mode diagnostic: dump each tick's chosen intents so we can verify
// scoring flow without a TUI. Sampled at the coordinator's tickMs cadence.
if (logMode === 'verbose') {
  setInterval(() => {
    const m = coordinator.blackboard.match
    const lines = []
    for (const [user, s] of coordinator.blackboard.bots) {
      const t = s.decision_trace
      if (!t?.chosen) continue
      const score = fmt(t.scores?.[t.chosen])
      const ru = t.runner_up ? `${t.runner_up}(${fmt(t.scores?.[t.runner_up])})` : '-'
      const held = t.hysteresis_held ? ' HELD' : ''
      const pre = t.preempt ? ` PREEMPT:${t.preempt}` : ''
      const ov = t.constraint_overrides?.length
        ? ' OVR:' + t.constraint_overrides.map((o) => `${o.from}→${o.to}(${o.constraint})`).join(',')
        : ''
      lines.push(`  ${user}[${s.team ?? '?'}]: ${t.chosen}(${score}) runner=${ru} regime=${t.time_regime}${held}${pre}${ov}`)
    }
    if (lines.length === 0) return
    const fmtA = (a) => a ? `${a.x.toFixed(0)},${a.y.toFixed(0)},${a.z.toFixed(0)}` : '?'
    const rf = m.anchors?.Red?.flag, rb = m.anchors?.Red?.base
    const bf = m.anchors?.Blue?.flag, bb_ = m.anchors?.Blue?.base
    const matchLine = `match caps=R${m.caps?.Red ?? 0}/B${m.caps?.Blue ?? 0} ` +
      `flags=R:${m.flags?.Red?.state ?? '?'}${m.flags?.Red?.heldBy ? `(${m.flags.Red.heldBy})` : ''}` +
      `/B:${m.flags?.Blue?.state ?? '?'}${m.flags?.Blue?.heldBy ? `(${m.flags.Blue.heldBy})` : ''} ` +
      `anchors=R:flag=${fmtA(rf)}/base=${fmtA(rb)} B:flag=${fmtA(bf)}/base=${fmtA(bb_)} ` +
      `colors=${JSON.stringify(m.teamColors ?? {})}`
    console.log(`[${new Date().toISOString()}] tick: ${matchLine}\n${lines.join('\n')}`)
  }, 2000).unref()
}

function fmt (n) {
  return n == null || !Number.isFinite(n) ? '?' : (Math.round(n * 100) / 100).toString()
}

const SPAWN_STAGGER_MS = 500
for (let i = 0; i < count; i++) {
  const username = baseName ? `${baseName}${i || ''}` : pickName()
  setTimeout(() => spawnBot({ host, port, username, index: i }), i * SPAWN_STAGGER_MS)
}

const shutdown = (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  const msg = `\nshutting down (${signal}); disconnecting ${liveBots.size} bot(s)`
  if (tui) tui.log(msg)
  else console.log(msg)
  for (const bot of liveBots) {
    try { bot.quit('shutdown') } catch {}
  }
  coordinator.stop()
  setTimeout(() => {
    if (tui) {
      try { tui.destroy() } catch {}
    }
    process.exit(0)
  }, 1000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP'))

function spawnBot ({ host, port, username, index }) {
  if (shuttingDown) return
  const bot = mineflayer.createBot({
    host,
    port,
    username,
    version: '1.8.8',
    auth: 'offline',
  })
  bot._botUsername = username
  bot._botIndex = index
  liveBots.add(bot)

  coordinator.registerBot(username, { kit, state: 'connecting' })
  const detachObserver = attachObserver(bot, coordinator, username)
  const detachExecutor = attachExecutor(bot, coordinator, username)
  bot.once('end', () => {
    detachObserver()
    detachExecutor()
  })

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvpPlugin)
  bot.loadPlugin(autoEatLoader)

  bot.on('login', () => {
    log(username, `logged in (entityId=${bot.entity?.id}, version=${bot.version})`)
  })

  bot.once('spawn', () => {
    const p = bot.entity.position
    log(username, `spawned at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`)

    const mcData = mcDataLoader(bot.version)
    const movements = new Movements(bot, mcData)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.allowParkour = true
    bot.pathfinder.setMovements(movements)
    // Throttle pathfinder compute so a single bot's A* doesn't stall the Node
    // event loop for the whole fleet — without this, 6 bots × 40ms tickTimeout
    // can stack to ~240ms of pauses, which the client sees as bots freezing
    // then snapping forward (perceived "lag"). Lower per-tick compute trades
    // a bit of path-find latency for smooth position-packet flow.
    bot.pathfinder.tickTimeout = 10        // default 40ms — slice compute finer
    bot.pathfinder.searchRadius = 200      // bound A* so long paths can't grind
    bot.pvp.movements = movements
    bot.pvp.followRange = 1.5
    bot.pvp.attackRange = 3.5

    if (bot.autoEat) {
      bot.autoEat.setOpts({
        priority: 'foodPoints',
        minHunger: 17,
        minHealth: 16,
        bannedFood: [],
        returnToLastItem: true,
        offhand: false,
      })
      bot.autoEat.enableAuto()

      const refreshEatThreshold = () => {
        const maxHp = bot.entity?.attributes?.['generic.maxHealth']?.value ?? 20
        bot.autoEat.setOpts({ minHealth: Math.max(1, Math.floor(maxHp * 0.8)) })
      }
      refreshEatThreshold()
      bot.on('health', refreshEatThreshold)

      bot.autoEat.on('eatStart', (opts) => log(username, `eating ${opts.food?.name ?? '?'}`))
      bot.autoEat.on('eatFinish', () => log(username, `ate (hp=${bot.health?.toFixed(1)} food=${bot.food})`))
      bot.autoEat.on('eatFail', (e) => log(username, `eat fail: ${e?.message ?? e}`))
    }

    bot.on('startedAttacking', () => {
      const t = bot.pvp.target
      log(username, `startedAttacking ${t?.username ?? '?'}`)
      coordinator.report(username, {
        state: 'engaging',
        lastDecision: `attacking ${t?.username ?? '?'}`,
      })
    })
    bot.on('stoppedAttacking', () => {
      log(username, 'stoppedAttacking')
      coordinator.report(username, { state: 'idle', lastDecision: 'target lost/dead' })
    })

    bot.on('health', () => {
      coordinator.report(username, {
        hp: bot.health,
        maxHp: bot.entity?.attributes?.['generic.maxHealth']?.value ?? 20,
        food: bot.food,
      })
    })

    coordinator.report(username, { state: 'spawned' })
    const reportHandle = setInterval(() => {
      if (!bot.entity) return
      const p = bot.entity.position
      const team = bot.teamMap?.[username]?.name ?? null
      const t = bot.pvp?.target
      coordinator.report(username, {
        pos: { x: p.x, y: p.y, z: p.z },
        team,
        target: t?.username
          ? {
              username: t.username,
              dist: p.distanceTo(t.position),
              team: bot.teamMap?.[t.username]?.name ?? null,
            }
          : null,
      })
    }, 1000)
    bot.once('end', () => clearInterval(reportHandle))

    bot.on('messagestr', (msg) => {
      const trimmed = msg.trim()
      if (!trimmed) return
      log(username, `chat: ${trimmed}`)
    })

    statusLoop(bot, username)

    if (!fight) return

    setTimeout(() => {
      log(username, `picking kit /${kit}`)
      bot.chat(`/${kit}`)
    }, 1000)

    // Combat target selection is now driven by the coordinator's intent
    // (push/defend/return/escort) via attachExecutor — no engageLoop here.
    // MCCTF autobalances on join — see [[feedback_team_autobalance]].
  })

  bot.on('death', () => {
    log(username, 'died')
    coordinator.report(username, { state: 'dead', lastDecision: 'died' })
  })

  bot.on('kicked', (reason) => log(username, `kicked: ${reason}`))
  bot.on('error', (err) => log(username, `error: ${err.message}`))
  bot.on('end', (reason) => {
    liveBots.delete(bot)
    coordinator.removeBot(username)
    if (shuttingDown) {
      log(username, `disconnected cleanly (${reason})`)
      return
    }
    log(username, `disconnected (${reason}); retrying in 5s`)
    setTimeout(() => spawnBot({ host, port, username, index }), 5000)
  })
}

function statusLoop (bot, username) {
  const handle = setInterval(() => {
    if (!bot.entity) return
    const p = bot.entity.position
    const team = bot.teamMap?.[username]?.name ?? '?'
    const target = bot.pvp?.target
    const dist = target ? p.distanceTo(target.position).toFixed(1) : '-'
    const tgtTeam = target?.username ? (bot.teamMap?.[target.username]?.name ?? '?') : '-'
    const hp = bot.health?.toFixed(1) ?? '?'
    const food = bot.food ?? '?'
    const nearest = bot.nearestEntity?.((e) => e.type === 'player' && e.username && e.username !== username)
    const nearestStr = nearest
      ? `${nearest.username}(${bot.teamMap?.[nearest.username]?.name ?? '?'})@${p.distanceTo(nearest.position).toFixed(1)}`
      : '-'
    log(username, `state team=${team} pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} hp=${hp} food=${food} target=${target?.username ?? '-'}(${tgtTeam})d=${dist} nearest=${nearestStr}`)
  }, 5000)
  bot.once('end', () => clearInterval(handle))
}

function loadNamePool () {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const path = join(here, '..', 'bot-names.txt')
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  } catch {
    return ['Bot']
  }
}

function pickName () {
  // Sample without replacement so a multi-bot fleet never gets duplicate
  // usernames — offline-mode dupes collide on UUID and kick each other with
  // "You logged in from another location". Falls back to a suffix if the pool
  // is exhausted (more bots than names).
  if (namePool.length === 0) return `Bot${Math.floor(Math.random() * 1e6)}`
  const idx = Math.floor(Math.random() * namePool.length)
  return namePool.splice(idx, 1)[0]
}

function parseArgs (args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
      out[key] = val
    }
  }
  return out
}

function log (name, msg) {
  const line = `[${new Date().toISOString()}] ${name}: ${msg}`
  if (tui) tui.log(line)
  else console.log(line)
}
