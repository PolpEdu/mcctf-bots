// MCCTF observer: turns one bot's chat + scoreboard stream into blackboard
// state. One observer per bot, but all observers write into the same shared
// blackboard. State is COLOR-KEYED (Red/Blue), so observers from opposite
// teams never overwrite each other's perspective.
//
// Wire format learned empirically — see scripts/capture-mcctf-state.mjs.
//
//   Sidebar (name="score"):
//     title:  "[1/3] Ends in 14:29"                   ← MM:SS = match remaining
//     items:
//       " Red - Your Team"                            ← OUR color (this bot's)
//       "   Captures 0/3"
//       "   Flag Home" | "Flag Taken" | "Flag Dropped"
//       "   * Held by <player>"                       ← only when Flag Taken
//       " Blue"                                       ← the other color
//       ...
//
//   Chat:
//     "<player> stole|picked up|dropped|captured|recovered the <Red|Blue> flag!"
//
// CTF semantics — easy to get backwards:
//   "Red flag" = the flag OWNED by Red. Blue players steal/carry/capture it.
//   "Held by X" under the Red block means X (a Blue player) carries our flag.
//   For coordinator/scoring: each bot has a team; its color comes from
//   bb.match.teamColors[bot.team]; ours = anchors[ourColor]/flags[ourColor].

const FLAG_RE = /^(\S+) (stole|picked up|dropped|captured|recovered) the (Red|Blue) flag!$/
const COLOR_STRIP = /§[0-9a-fk-orA-FK-OR]/g

// Per MCCTF map config (`time=20` on Modern Diversity and other test maps),
// matches run 20:00. Used as a floor for `matchTotalMs` so late-joining bots
// still derive correct `elapsedMs` instead of treating their join time as
// match start. Revisit if MCCTF ships maps with non-default match length.
const ASSUMED_MATCH_LENGTH_MS = 20 * 60 * 1000

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ blackboard: any }} coordinator
 * @param {string} username
 */
export function attachObserver (bot, coordinator, username) {
  const bb = coordinator.blackboard

  // The color this BOT's POV reflects. Used only to populate teamColors map
  // (so other bots on the same team_N can resolve color too).
  let myColor = null
  let myTeam = null  // 'team_1' | 'team_2', from bot.teamMap

  // Track if we've recorded this bot's team-spawn anchor yet.
  let baseRecorded = false

  // MCCTF redirects the player's compass needle via the vanilla spawn_position
  // packet (Bukkit's setCompassTarget). By default it points at the player's
  // OWN team flag (orientation/defense aid) — verified empirically: Red bot
  // compass at (74,53,35) sits near Red spawn (89,68,89), Blue bot compass at
  // (238,53,65) sits near Blue spawn (223,68,11). So each bot writes its own
  // flag anchor; cross-team data sharing populates both colors in the bb.
  // May briefly point at world spawn before MCCTF overrides it — the next
  // packet corrects it.
  let lastSpawnPos = null

  bot.on('messagestr', onChat)
  bot.on('scoreUpdated', onSidebar)
  bot.on('scoreRemoved', onSidebar)
  bot.on('scoreboardTitleChanged', onSidebar)
  bot.on('scoreboardCreated', onSidebar)
  bot.on('move', onMove)
  bot._client?.on('spawn_position', onSpawnPosition)

  const refresh = setInterval(publish, 1000)
  refresh.unref?.()

  function detach () {
    bot.off('messagestr', onChat)
    bot.off('scoreUpdated', onSidebar)
    bot.off('scoreRemoved', onSidebar)
    bot.off('scoreboardTitleChanged', onSidebar)
    bot.off('scoreboardCreated', onSidebar)
    bot.off('move', onMove)
    bot._client?.removeListener?.('spawn_position', onSpawnPosition)
    clearInterval(refresh)
  }
  return detach

  // ---- compass target (enemy flag) ----

  function onSpawnPosition (packet) {
    const loc = packet?.location
    if (!loc || typeof loc.x !== 'number') return
    lastSpawnPos = { x: loc.x, y: loc.y, z: loc.z }
    recordOwnFlagAnchor()
  }

  function recordOwnFlagAnchor () {
    if (!lastSpawnPos || !myColor) return
    const anchors = cloneAnchors()
    const prev = anchors[myColor].flag
    if (prev && prev.x === lastSpawnPos.x && prev.y === lastSpawnPos.y && prev.z === lastSpawnPos.z) return
    anchors[myColor].flag = { ...lastSpawnPos }
    bb.setMatch({ anchors })
  }

  // ---- team-spawn anchor ----
  // Bot starts in lobby (y=214 on test maps); first time y<150 = teleported
  // to team spawn. Record that as `anchors[myColor].base`.

  function onMove () {
    if (baseRecorded) return
    const p = bot.entity?.position
    if (!p || p.y > 150) return
    if (!myColor) return            // wait until sidebar reveals our color
    baseRecorded = true
    const anchors = cloneAnchors()
    anchors[myColor].base = vec(p)
    bb.setMatch({ anchors })
  }

  // ---- chat: flag events ----

  function onChat (msg) {
    const m = FLAG_RE.exec(String(msg).trim())
    if (!m) return
    const [, player, verb, color] = m
    const pPos = bot.players?.[player]?.entity?.position

    const flags = cloneFlags()
    const anchors = cloneAnchors()

    if (verb === 'stole') {
      // Player just removed the flag from its home block — their current
      // position is exactly where the flag block lived.
      if (pPos) anchors[color].flag = vec(pPos)
      flags[color] = { state: 'carried', heldBy: player, carrierPos: pPos ? vec(pPos) : null }
    } else if (verb === 'picked up') {
      // Re-pickup from dropped state; position is the drop point.
      flags[color] = { state: 'carried', heldBy: player, carrierPos: pPos ? vec(pPos) : null }
    } else if (verb === 'dropped') {
      flags[color] = { state: 'dropped', heldBy: null, carrierPos: pPos ? vec(pPos) : null }
    } else if (verb === 'captured') {
      flags[color] = { state: 'home', heldBy: null, carrierPos: null }
      // Bump caps for the team that captured. Captor's team = OPPOSITE color
      // of the flag captured. We may not know color→team yet; sidebar refresh
      // will overwrite caps anyway, so leave this to sidebar.
    } else if (verb === 'recovered') {
      flags[color] = { state: 'home', heldBy: null, carrierPos: null }
    }
    bb.setMatch({ flags, anchors })
    publish()
  }

  // ---- sidebar parse ----

  function onSidebar () {
    parseSidebar()
    publish()
  }

  function parseSidebar () {
    const sb = findSidebar()
    if (!sb) return

    const title = strip(sb.title)
    const tm = /Ends in (\d{1,2}):(\d{2})/.exec(title)
    if (tm) {
      const remainingMs = (Number(tm[1]) * 60 + Number(tm[2])) * 1000
      // matchTotalMs = max of (ASSUMED_MATCH_LENGTH_MS, any larger value
      // we've actually observed in the title). Floor on the assumed length
      // protects late-joiners; the max lets us correct upward if the map runs
      // longer than expected.
      const matchTotalMs = Math.max(bb.match.matchTotalMs ?? 0, remainingMs, ASSUMED_MATCH_LENGTH_MS)
      const elapsedMs = matchTotalMs - remainingMs
      bb.setMatch({ remainingMs, matchTotalMs, elapsedMs })
    }

    const itemsMap = sb.itemsMap ?? sb.items ?? {}
    const lines = Object.values(itemsMap)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .map((i) => strip(i.displayName?.toString?.() ?? i.name).trim())

    const teams = { Red: null, Blue: null }
    let cur = null
    for (const raw of lines) {
      if (!raw) continue
      const header = /^(Red|Blue)( - Your Team)?$/.exec(raw)
      if (header) {
        cur = header[1]
        teams[cur] = { caps: null, max: null, flag: null, heldBy: null }
        if (header[2]) myColor = cur
        continue
      }
      if (raw === 'Your Stats') { cur = null; continue }
      if (!cur || !teams[cur]) continue

      const caps = /^Captures (\d+)\/(\d+)$/.exec(raw)
      if (caps) { teams[cur].caps = Number(caps[1]); teams[cur].max = Number(caps[2]); continue }
      const flag = /^Flag (Home|Taken|Dropped)$/.exec(raw)
      if (flag) { teams[cur].flag = flag[1]; continue }
      const held = /^\* Held by (.+)$/.exec(raw)
      if (held) { teams[cur].heldBy = held[1]; continue }
    }

    // Caps: write by color directly. (Sidebar from each team's bot perspective
    // shows the SAME absolute caps — last write wins is fine, they agree.)
    const caps = { Red: teams.Red?.caps ?? bb.match.caps?.Red ?? 0,
                   Blue: teams.Blue?.caps ?? bb.match.caps?.Blue ?? 0 }
    const maxCaps = teams.Red?.max ?? teams.Blue?.max ?? bb.match.maxCaps ?? null

    // Flag state from sidebar — preserve carrierPos from chat (sidebar doesn't
    // carry position). Merge only if the state actually came from this sidebar.
    const flags = cloneFlags()
    for (const c of ['Red', 'Blue']) {
      if (!teams[c]) continue
      const s = teams[c]
      const state = s.flag === 'Home' ? 'home'
                  : s.flag === 'Taken' ? 'carried'
                  : s.flag === 'Dropped' ? 'dropped'
                  : flags[c].state
      flags[c] = {
        state,
        heldBy: s.heldBy ?? (state === 'carried' ? flags[c].heldBy : null),
        carrierPos: flags[c].carrierPos,   // keep last known until chat updates
      }
    }

    // Record this bot's team → color mapping once we know both.
    myTeam = bot.teamMap?.[username]?.name ?? myTeam
    const teamColors = { ...(bb.match.teamColors ?? {}) }
    if (myTeam && myColor) teamColors[myTeam] = myColor

    bb.setMatch({ caps, maxCaps, flags, teamColors })

    // spawn_position may have arrived before we knew our color — try again.
    recordOwnFlagAnchor()
  }

  function findSidebar () {
    const all = Object.values(bot.scoreboards ?? {})
    return (
      all.find((s) => s.position === 1) ||
      all.find((s) => s.name === 'score') ||
      all.find((s) => /Ends in/.test(strip(s.title)))
    )
  }

  // ---- live carrier position ----

  function publish () {
    const flags = cloneFlags()
    let touched = false
    for (const c of ['Red', 'Blue']) {
      const heldBy = flags[c].heldBy
      if (!heldBy) continue
      const e = bot.players?.[heldBy]?.entity?.position
      if (e) {
        flags[c] = { ...flags[c], carrierPos: vec(e) }
        touched = true
      }
    }
    if (touched) bb.setMatch({ flags })
  }

  // Shallow clones so we never mutate bb.match in place.
  function cloneFlags () {
    const src = bb.match.flags ?? {}
    return {
      Red:  { ...(src.Red  ?? { state: 'home', heldBy: null, carrierPos: null }) },
      Blue: { ...(src.Blue ?? { state: 'home', heldBy: null, carrierPos: null }) },
    }
  }
  function cloneAnchors () {
    const src = bb.match.anchors ?? {}
    return {
      Red:  { ...(src.Red  ?? { flag: null, base: null }) },
      Blue: { ...(src.Blue ?? { flag: null, base: null }) },
    }
  }
}

function vec (p) { return { x: p.x, y: p.y, z: p.z } }
function strip (s) { return s == null ? '' : String(s).replace(COLOR_STRIP, '') }
