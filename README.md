# mcctf-bots

Client-bot fleet for MCCTF. Each bot is a real Minecraft client connection (Mineflayer) — the MCCTF plugin sees them as ordinary players.

**▶️ Demo:** https://youtu.be/a_TpcwnKXjc — a full 5v5 match with the bot fleet.

## Versions (important)

MCCTF only exists as a **1.8.x** plugin, so the **server runs Paper 1.8.8**. But you
don't have to play on a 1.8 client:

- **Server:** Paper **1.8.8** + MCCTF 3.7.2, with **ViaVersion + ViaBackwards + ViaRewind**
  installed. That Via stack is what lets modern clients connect to the 1.8 server.
- **Human players:** join with a **modern client (1.21)** — Via translates it down to 1.8.
  This is how the project is actually played day-to-day.
- **Bots:** connect **natively as 1.8.8** clients (`version: '1.8.8'` in `src/index.js`).
  Mineflayer speaks 1.8 directly, so bots skip Via entirely and talk to the server in its
  own protocol.

So "runs on 1.21" refers to the *client you join with*, not the server. The server is
1.8.8 and stays that way.

## Status

v2 — a full 5v5 fleet runs. Each bot connects as a real 1.8.8 client, picks a kit
(`/heavy`), fights team-aware, auto-eats to survive, and follows coordinator-driven
CTF intents (attack the enemy flag, defend our own, chase carriers, escort, retreat).

### Playtest notes (from live 5v5 runs)

- **PvP looks almost-human.** Bots eat steak on low health and swing with a slight,
  human-like delay rather than snapping instantly — deliberately *not* kill-aura-style
  (instant-lock aim was a known problem to avoid, and this fleet doesn't do it).
- **Emergent tactics.** With the coordinator wired, bots visibly defend and push the
  flag, split between offense and defense rather than all clumping.
- **Known issue: local-run lag.** Running the server and the whole bot fleet on one
  machine makes the bots feel laggy (movement stutters). This is a **performance /
  hosting** problem still being troubleshooted, not a bot-logic bug — a dedicated or
  less-loaded host smooths it out.

### Where the work is

Performance (the local-run lag above) and PvP fidelity are the near-term focus.
Strategy/coordination already works and matters long-term, but it's *not* the current
bottleneck — combat feel and frame-consistency come first. See `NEXT.md` for the
detailed roadmap and `TEAM-DECISIONS.md` for the coordinator design.

## Prereqs

- **Node.js 20+**
- A running **MCCTF server** reachable on `localhost:25566`, with:
  - `online-mode=false` in `server.properties` (bots use offline-auth usernames)
  - ViaVersion + ViaBackwards + ViaRewind installed (so you can join with a 1.21 client — see [Versions](#versions-important))
  - Launched on **JDK 17+** (JDK 22 recommended). The MCCTF/Via jars are Java 17 bytecode; a 32-bit Java 8 silently drops all plugins.

## How to run

### 1. Start the MCCTF server

From the server folder, on a modern JDK:

```
java --add-opens=java.base/java.lang=ALL-UNNAMED \
     --add-opens=java.base/java.lang.reflect=ALL-UNNAMED \
     -Xms1G -Xmx2G -jar paper.jar nogui
```

Wait for `Done (...)! For help, type "help"`.

### 2. Spawn the bots

```
cd E:\CTF-Rebuilded\mcctf-bots
npm install                                   # first time only
node src/index.js --count 10 --kit heavy      # a full 5v5 (MCCTF autobalances teams)
```

Other examples:

```
npm run spawn1                                 # single bot on 127.0.0.1:25566
node src/index.js --kit heavy                  # one Heavy bot
node src/index.js --count 5 --username NinjaSquad --kit ninja
node src/index.js --count 10 --log-mode tui    # live per-bot TUI dashboard
```

### 3. Join and play

Connect with your **1.21 client** to `localhost:25566` (or `<your-LAN-IP>:25566` from
another device). Via translates you down to the 1.8 server. Pick a team and `/heavy`.

### 4. Stop

`Ctrl+C` in the bot terminal disconnects the fleet cleanly. Stop the server from its
console with `stop`, or over RCON:

```
node scripts/rcon-stop.mjs 127.0.0.1 25577 <your-rcon-password> stop
```

### CLI args

- `--host <ip>` (default `127.0.0.1`)
- `--port <port>` (default `25566`)
- `--count <n>` — number of bots (default `1`)
- `--kit <name>` — kit to pick on spawn (default `heavy`; e.g. `ninja`, `archer`, `medic`)
- `--username <prefix>` — fixed name prefix (default: unique random picks from `bot-names.txt`)
- `--log-mode <verbose|tui>` — plain log stream (default) or the live TUI dashboard

## Why Node.js instead of Java

MCProtocolLib (Java) doesn't support MC 1.8.8 in any maintained release — opencollab's repo only ships 1.18+; old Steveice10 tags from the 1.8 era are abandoned. Mineflayer is the only well-maintained 1.8-compatible bot framework. See `../DeCTF2-NPC/DECISION-CLIENT-VS-SERVER.md` for the broader pivot.

## Why not server-side bots (like ServerBots)

See `../DeCTF2-NPC/DECISION-CLIENT-VS-SERVER.md`. Short version: server-side `ServerPlayer` bots kept hitting "vanilla path doesn't fire for packetless players" bugs. Real clients get all vanilla physics + anticheat-clean movement for free.

## Roadmap

- [x] Connect, log spawn, auto-reconnect
- [x] mineflayer-pvp + mineflayer-auto-eat wired up
- [x] `/kit heavy` sent on spawn
- [x] Walk toward nearest enemy via mineflayer-pathfinder
- [x] Team-aware targeting (never hit same-team players)
- [x] CTF objective layer — coordinator intents (push / defend / return / escort / retreat)
- [x] Team coordination (shared blackboard across bots in one process)
- [ ] **Performance: fix local-run lag** (smooth movement under a full fleet)
- [ ] Tighten PvP feel (block-hits, sprint-reset knockback, per-tier difficulty)
- [ ] Per-kit combat strategies (Medic heals, Archer kites, Ninja ambushes)
- [ ] Fleet supervisor / autofill (keep N bots alive; human joins → bot leaves)

## Acknowledgements

Thanks to **SoCool21** for the original idea and pointing this in the right direction.
