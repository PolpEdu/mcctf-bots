# mcctf-bots

A fleet of client bots for MCCTF. Each bot is a real Minecraft client connection (built on Mineflayer), so the MCCTF plugin just sees them as ordinary players.

▶️ Demo: https://youtu.be/a_TpcwnKXjc (a full 5v5 match with the bots).

## Versions (please read)

MCCTF only exists as a 1.8.x plugin, so the server runs Paper 1.8.8. You don't have to play on a 1.8 client though:

- **Server:** Paper 1.8.8 + MCCTF 3.7.2, with ViaVersion, ViaBackwards and ViaRewind installed. That Via stack is what lets modern clients connect to the old 1.8 server.
- **You (human player):** join with a modern client like 1.21 and Via translates it down to 1.8. That's how I actually play it day to day.
- **Bots:** connect natively as 1.8.8 clients (`version: '1.8.8'` in `src/index.js`). Mineflayer speaks 1.8 directly, so the bots skip Via entirely and talk to the server in its own protocol.

So when I say it "runs on 1.21", I mean the client I join with. The server itself is 1.8.8 and stays that way.

## Status

At v2 a full 5v5 fleet runs. Each bot connects as a real 1.8.8 client, picks a kit (`/heavy`), fights in a team-aware way, eats to stay alive, and follows intents from the coordinator (attack the enemy flag, defend our own, chase carriers, escort, retreat).

### What it looks like in playtests

- **The PvP feels close to human.** Bots eat steak when their health drops and they hit with a slight delay instead of snapping instantly. That was on purpose. Instant-lock kill-aura aim is exactly the thing I wanted to avoid, and this fleet doesn't do it.
- **They show some tactics.** With the coordinator running you can watch them defend and push the flag, and split between offense and defense instead of all clumping together.
- **The lag is a known thing.** Right now I run the server and the whole bot fleet on one machine, and that makes them feel laggy (movement stutters). It's a performance and hosting problem I'm still working on, not a bug in the bot logic. A dedicated or less loaded host smooths it out.

### Where the effort is going

Performance (that local-run lag) and PvP feel are the near-term focus. The strategy side already works and it matters long term, but it isn't the bottleneck right now, so combat feel and smooth movement come first. See `NEXT.md` for the full roadmap and `TEAM-DECISIONS.md` for how the coordinator is designed.

## What you need

- Node.js 20+
- An MCCTF server reachable on `localhost:25566`, set up with:
  - `online-mode=false` in `server.properties` (the bots log in with offline usernames)
  - ViaVersion, ViaBackwards and ViaRewind installed, so you can join with a 1.21 client (see [Versions](#versions-please-read))
  - Launched on JDK 17 or newer (I use JDK 22). The MCCTF and Via jars are Java 17 bytecode, and a 32-bit Java 8 will silently drop every plugin.

## How to run

### 1. Start the MCCTF server

From the server folder, on a modern JDK:

```
java --add-opens=java.base/java.lang=ALL-UNNAMED \
     --add-opens=java.base/java.lang.reflect=ALL-UNNAMED \
     -Xms1G -Xmx2G -jar paper.jar nogui
```

Wait for the `Done (...)! For help, type "help"` line.

### 2. Spawn the bots

```
cd E:\CTF-Rebuilded\mcctf-bots
npm install                                   # first time only
node src/index.js --count 10 --kit heavy      # a full 5v5, MCCTF autobalances the teams
```

A few more examples:

```
npm run spawn1                                 # single bot on 127.0.0.1:25566
node src/index.js --kit heavy                  # one Heavy bot
node src/index.js --count 5 --username NinjaSquad --kit ninja
node src/index.js --count 10 --log-mode tui    # live per-bot TUI dashboard
```

### 3. Join and play

Connect with your 1.21 client to `localhost:25566` (or `<your-LAN-IP>:25566` from another device on your network). Via translates you down to the 1.8 server. Pick a team and type `/heavy`.

### 4. Stop

`Ctrl+C` in the bot terminal disconnects the fleet cleanly. Stop the server from its own console with `stop`, or over RCON:

```
node scripts/rcon-stop.mjs 127.0.0.1 25577 <your-rcon-password> stop
```

### CLI args

- `--host <ip>` (default `127.0.0.1`)
- `--port <port>` (default `25566`)
- `--count <n>`: how many bots (default `1`)
- `--kit <name>`: kit to pick on spawn (default `heavy`, e.g. `ninja`, `archer`, `medic`)
- `--username <prefix>`: fixed name prefix (default is unique random picks from `bot-names.txt`)
- `--log-mode <verbose|tui>`: plain log stream (default) or the live TUI dashboard

## Why Node.js and not Java

MCProtocolLib (the Java option) doesn't support MC 1.8.8 in any maintained release. Opencollab's repo only ships 1.18+, and the old Steveice10 tags from the 1.8 era are abandoned. Mineflayer is the only well-maintained bot framework that still speaks 1.8, so that decided it. There's more background in `../DeCTF2-NPC/DECISION-CLIENT-VS-SERVER.md`.

## Why not server-side bots (like the old ServerBots)

Same doc, `../DeCTF2-NPC/DECISION-CLIENT-VS-SERVER.md`, has the long version. Short story: server-side `ServerPlayer` bots kept running into "the vanilla code path doesn't fire for packetless players" bugs. Real clients get all the vanilla physics and anticheat-clean movement for free, so we stopped fighting the server.

## Roadmap

- [x] Connect, log spawn, auto-reconnect
- [x] mineflayer-pvp and mineflayer-auto-eat wired up
- [x] `/kit heavy` sent on spawn
- [x] Walk toward the nearest enemy via mineflayer-pathfinder
- [x] Team-aware targeting (never hit same-team players)
- [x] CTF objective layer via coordinator intents (push, defend, return, escort, retreat)
- [x] Team coordination (shared blackboard across bots in one process)
- [ ] Performance: fix the local-run lag (smooth movement under a full fleet)
- [ ] Tighten the PvP feel (block-hits, sprint-reset knockback, difficulty tiers)
- [ ] Per-kit combat strategies (Medic heals, Archer kites, Ninja ambushes)
- [ ] Fleet supervisor and autofill (keep N bots alive, a human joins and a bot leaves)

## Thanks

Big thanks to SoCool21 for the original idea and for pointing me in the right direction.
