// One-shot diagnostic: connect a single bot, log every chat line and every
// scoreboard mutation for 45s, then quit. Used to design observer.js without
// guessing the MCCTF wire format.

import mineflayer from 'mineflayer'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 25566)
const username = process.argv[4] ?? 'ScoutBot'
const durationMs = Number(process.argv[5] ?? 45000)

const bot = mineflayer.createBot({ host, port, username, version: '1.8.8', auth: 'offline' })

bot.on('login', () => console.log(`[login] ${username} (eid=${bot.entity?.id})`))
bot.on('error', (e) => console.log(`[error] ${e.message}`))
bot.on('kicked', (r) => console.log(`[kicked] ${r}`))

bot.once('spawn', () => {
  const p = bot.entity.position
  console.log(`[spawn] ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`)

  // Pick a kit so we leave lobby state
  setTimeout(() => { console.log('[chat:tx] /heavy'); bot.chat('/heavy') }, 1500)

  bot.on('messagestr', (msg) => {
    const t = msg.trim()
    if (t) console.log(`[chat:rx] ${t}`)
  })

  bot.on('scoreboardCreated', (sb) => {
    console.log(`[sb:create] name=${sb.name} title=${stripColors(sb.title)}`)
  })
  bot.on('scoreboardDeleted', (sb) => {
    console.log(`[sb:delete] name=${sb.name}`)
  })
  bot.on('scoreboardTitleChanged', (sb) => {
    console.log(`[sb:title] name=${sb.name} title=${stripColors(sb.title)}`)
  })
  bot.on('scoreUpdated', (sb, item) => {
    console.log(`[sb:score] name=${sb.name} ${stripColors(item.displayName?.toString() ?? item.name)} = ${item.value}`)
  })
  bot.on('scoreRemoved', (sb, item) => {
    console.log(`[sb:rm] name=${sb.name} ${stripColors(item.displayName?.toString() ?? item.name)}`)
  })

  // Snapshot the sidebar every 5s in addition to event-based logging
  setInterval(() => {
    const sb = Object.values(bot.scoreboards ?? {})
      .find((s) => s.position === 'sidebar' || s.name === 'sidebar')
    if (!sb) {
      console.log('[sb:snap] no sidebar')
      return
    }
    const items = (sb.itemsMap ? Object.values(sb.itemsMap) : Object.values(sb.items ?? {}))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .map((i) => `${i.value}: ${stripColors(i.displayName?.toString() ?? i.name)}`)
    console.log(`[sb:snap] title=${stripColors(sb.title)}\n  ${items.join('\n  ')}`)
  }, 5000)
})

function stripColors (s) {
  if (s == null) return ''
  return String(s).replace(/§[0-9a-fk-orA-FK-OR]/g, '')
}

setTimeout(() => {
  console.log('[done] disconnecting')
  bot.quit()
  setTimeout(() => process.exit(0), 500)
}, durationMs)
