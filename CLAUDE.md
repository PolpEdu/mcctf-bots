# mcctf-bots, project context

Mineflayer client-bot fleet that plays MCCTF 1.8.8 as real player connections. Replaces the abandoned server-side ServerBots plugin (now at `../DeCTF2-NPC.archived/`).

## Key constraints (do not change without asking the user)

- **Server target: MCCTF 3.7.2 on Paper 1.8.8.** Frozen forever. The reference layout is at `../mcctf-servers-reference/New_MCCTF/`; the live test server is at `E:\minecraft server\mcctf-test-1.8.8\`. MCCTF only exists as a 1.8.x plugin, do not propose modernizing.
- **Runtime: Node.js 20+ + Mineflayer 4.37.** Not Java. MCProtocolLib does not support 1.8.x in any maintained release (verified, opencollab Maven only ships 1.18+), and Steveice10's old 1.8-era line is abandoned. Mineflayer is the only well-maintained 1.8-compatible bot framework. See [[mcctf-java-version]] memory and `../DeCTF2-NPC.archived/DECISION-CLIENT-VS-SERVER.md` for the longer story.
- **Each bot is a real client connection.** No server-side plugin spawns them, no NMS, no anticheat exemptions needed, they speak the protocol like a Minecraft client would. MCCTF sees them in tab list, on scoreboard, in chat, identically to humans.
- **Combat AI: mineflayer-pvp + mineflayer-pathfinder + mineflayer-auto-eat.** Battle-tested 1.8 PvP behavior comes from these plugins. We do not port `pvp-bot-fabric`'s code (the algorithm reference under `../DeCTF2-NPC.archived/reference/pvp-bot-fabric/` exists if mineflayer-pvp turns out to be too thin, it has not so far).
- **Targeting is scoreboard-team-aware.** `bot.teamMap[username].name` is checked before attacking. Same team → friendly fire skipped. Different/unknown team → attack. Do not introduce name-based heuristics again, they break bot-vs-bot fights.
- **One JS process holds N bots.** Hybrid model (per [[redeploy-after-fix]] thinking): one Node process per match's bot fleet. Shared in-memory state (TeamBlackboard) coordinates teammates without going through any IPC. A JVM/process per bot was rejected, too heavy, no real isolation benefit at our scale.

## Architecture pointer

See `NEXT.md` for the live roadmap and `README.md` for run instructions. The historical pivot rationale (server-side bot pain → client-bot pivot → Mineflayer because Java didn't have 1.8 protocol support) lives in `../DeCTF2-NPC.archived/DECISION-CLIENT-VS-SERVER.md`, don't re-litigate, just read.

## Server launch

```
"C:\Program Files\Java\jdk-22\bin\java.exe" \
  --add-opens=java.base/java.lang=ALL-UNNAMED \
  --add-opens=java.base/java.lang.reflect=ALL-UNNAMED \
  -Xms1G -Xmx2G -jar paper.jar nogui
```

Run from `E:\minecraft server\mcctf-test-1.8.8\`. Paper 1.8.8 jar boots on Java 22 (warns about `NoSuchFieldException: modifiers`, harmless), but **MCCTF, ViaVersion, ViaBackwards, ViaRewind jars are all class file 61 (Java 17)**. The 32-bit Java 8 at `java8path` will silently drop all plugin loads. Always use the modern JDK. RCON: port 25577, password `<your-rcon-password>`.

## Bot launch + shutdown

```
cd E:\CTF-Rebuilded\mcctf-bots
npm install
node src/index.js --kit heavy        # single bot, will engage nearest non-team player
node src/index.js --kit ninja --count 5 --username NinjaSquad
node scripts/rcon-stop.mjs 127.0.0.1 25577 <your-rcon-password> stop   # clean server shutdown
```

## Anti-patterns to refuse

- **Don't propose porting back to Java / MCProtocolLib.** That path is closed, no maintained 1.8 protocol lib in Java. Vendoring an unmaintained Steveice10 release is not on the table.
- **Don't load `pvp-bot-fabric` as a runtime dep.** It's a Fabric mod requiring 1.21.10+; the server is Paper 1.8.8. The reference clone under `../DeCTF2-NPC.archived/reference/` exists only as an algorithm source if mineflayer-pvp ever falls short. So far it hasn't.
- **Don't spawn a separate process per bot.** Multi-bot-per-JVM is the right tradeoff at our scale (see `NEXT.md` resource projections). Cross-process IPC is unnecessary overhead, shared object refs in one Node process do the same job.
- **Don't add a companion server-side plugin to MCCTF.** Bots learn game state by observing chat + scoreboard like a human. The "expose `GameMatch.currentMatch` over plugin messages" idea from the old DeCTF2 plan is unnecessary now. MCCTF's events are visible enough through the standard protocol.
- **Don't add a Java pathfinder or combat module.** mineflayer-pathfinder handles 1.8 terrain, mineflayer-pvp handles 1.8 PvP. Both are battle-tested on 1.8 specifically.

# RTK (Rust Token Killer) - Token-Optimized Commands

See parent `E:\CTF-Rebuilded\CLAUDE.md` for the full RTK command catalogue. High-impact for this project: `rtk npm install`, `rtk git status` / `rtk git diff` / `rtk git log`, `rtk grep` for code search. No `rtk node` filter exists (Node output is already compact); run it raw.
