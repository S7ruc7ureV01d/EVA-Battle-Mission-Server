# ヱヴァンゲリヲン バトルミッション

A reverse-engineered local replacement server for **Evangelion Battle
Mission** (`com.bushiroad.eva`), a mobile game whose official servers
have been dead since service ended on 2016-01-21.

This project gets the game past its "connection error" boot screen,
through real account setup (`setup/first`, `setup/comp`), and into the
real, interactive main menu — using protocol and Unity
`AssetBundle`-format reverse engineering plus real card data scraped
from a community wiki. No original game content (character art,
puzzle-board data, scenario text) is included, since none of it was
ever archived anywhere after the service shut down.

Full technical writeup, including the multi-session reverse-engineering
process, is in [`info.md`](info.md). Original plan/scope is in
[`PLAN.md`](PLAN.md).

## What's here

- `server/server.js` — the fake API server (Node, no dependencies)
- `server/build_bmdata.py` — hand-builds the Unity `AssetBundle` binary
  the client expects after `inspection` succeeds (stdlib only)
- `server/data_m_card.json` — 261 real cards scraped from
  `eva-battlemission.gamerch.com`, encoded to match `Master.Card`
- `server/debug.keystore` — debug signing key for sideloading a
  binary-patched copy of the APK (see `info.md` for the patch itself and
  why it's needed)

## Status

Reaches the real, interactive main menu. Master data (`POST /master`)
turned out not to be required for the client to proceed — it's consumed
lazily per-screen rather than validated up front. A dedicated wiki for
this game preserves real datamined card stats: 261 real cards are wired
into `m_card`, with 12 granted to the player on login and confirmed
rendering correctly in the in-game card list. Skill and chapter data
are the natural next targets from the same wiki. Actual stage/
puzzle-board layouts were never archived anywhere and remain the real
content wall.

## Help Wanted

If anyone has a save/backup of the game data and wouldn't mind sharing it please hit me on Telegram @s7ruc7urev01d. A device with the game installed and downloaded from back when it was active would also work.
