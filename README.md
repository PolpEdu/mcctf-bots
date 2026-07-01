# mcctf-bots

Client-bot fleet for MCCTF 1.8.8. Each bot is a real Minecraft client connection (Mineflayer) — the MCCTF plugin sees them as ordinary players.

## Status

v0 spike. Connects to a 1.8.8 server, logs spawn position, retries on disconnect. No AI yet.

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
- [ ] mineflayer-pvp + mineflayer-auto-eat wired up
- [ ] `/kit heavy` sent on spawn
- [ ] Walk toward nearest enemy via mineflayer-pathfinder
- [ ] CTF objective layer (grab flag, return flag, defend)
- [ ] Team coordination (shared blackboard across bots in one process)
- [ ] Fleet supervisor (`npm run fleet -- --count 10` keeps 10 bots alive)
