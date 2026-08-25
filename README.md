# ヱヴァンゲリヲン バトルミッション — Local Private Server

A reverse-engineered local replacement server for **Evangelion Battle
Mission** (`com.bushiroad.eva`), a mobile game whose official servers
have been dead since service ended on 2016-01-21.

This project gets the game past its "connection error" boot screen and
through real account setup (`setup/first`, `setup/comp`) into
master-data loading, using only protocol and Unity `AssetBundle`-format
reverse engineering — no original game content (character art,
puzzle-board data, scenario text) is included or required to get this
far, since none of it was ever archived anywhere after the service shut
down.

Full technical writeup, including the multi-session reverse-engineering
process, is in [`info.md`](info.md). Original plan/scope is in
[`PLAN.md`](PLAN.md).

## What's here

- `server/server.js` — the fake API server (Node, no dependencies)
- `server/build_bmdata.py` — hand-builds the Unity `AssetBundle` binary
  the client expects after `inspection` succeeds (stdlib only)
- `server/debug.keystore` — debug signing key for sideloading a
  binary-patched copy of the APK (see `info.md` for the patch itself and
  why it's needed)

## Not included

The original APK and a leaked Unity engine source drop used during
development are excluded (`.gitignore`) — too large for a repo, and not
ours to redistribute. You'll need your own legally-owned copy of the
APK to use this.

## Status

Reaches real master-data loading (`POST /master`), which requires all
61 of the game's master-data tables (`Master.Scenario`,
`Master.SkillLeader`, etc.) — the actual game content, never archived.
That's the current, well-defined boundary: further progress means
authoring replacement game data from scratch, a different and much
larger undertaking than the protocol/format work done so far.
