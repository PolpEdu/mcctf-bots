# mcctf-bots

Client-bot fleet for MCCTF 1.8.8. Each bot is a real Minecraft client connection (Mineflayer) — the MCCTF plugin sees them as ordinary players.

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

- Node.js 20+
- A running MCCTF server on localhost:25566 (offline-mode for unauth'd usernames)

## Install + run

```
cd E:\CTF-Rebuilded\mcctf-bots
npm install
npm run spawn1
```

CLI args:

- `--host <ip>` (default 127.0.0.1)
- `--port <port>` (default 25565)
- `--count <n>` (default 1)
- `--username <prefix>` (default: random pick from bot-names.txt)

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
