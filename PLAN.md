# Plan: Local Private Server for Evangelion Battle Mission (EVA BM)

## Primary Goal

The game `com.bushiroad.eva` (Evangelion Battle Mission, service ended
2016-01-21) currently fails on launch because it cannot reach its
original game server (`http://evangelion.donuts.ne.jp/`). The goal is
to stand up a **local replacement server** that answers the game's API
calls well enough to get the client past the initial connection-error
screen and, ideally, into actual gameplay (puzzle battle mode).

This is being done against our own legally-owned APK copy, purely for
preservation/offline-play purposes (abandoned service, no working
official server exists anymore).

## What we know so far (see info.md for full details)

- The game is a **Mono Unity** app (not IL2CPP) — `Assembly-CSharp.dll`
  is fully readable IL via `monodis`, no native disassembly needed for
  game logic.
- All game-server communication goes through `Network.EvaApiClient`.
- Base URL is **plain HTTP**, not HTTPS: `http://evangelion.donuts.ne.jp/`
  — no TLS/cert-pinning to defeat. A simple DNS redirect + local HTTP
  server is sufficient; mitmproxy is only needed as an *inspection*
  tool if we want to watch what a live device actually sends, not as
  a mandatory MITM layer for the final solution.
- Requests are `UnityEngine.WWWForm` POSTs (multipart form fields), to
  `BASE_URL + apiName` (e.g. `.../inspection`, `.../setup/first`,
  `.../setup/comp`, `.../bushimo/inheriting/comp`).
- The very first call on boot is `EvaApiClient.GetURL()` → POST to
  `inspection`. This is almost certainly the call whose failure
  produces the "connection error" screen the user currently sees.
- Response signature validation (`IsValidResponse`) is computed but its
  result is **discarded** (`pop`) — the client does not actually reject
  responses with a bad/missing signature. This drastically simplifies
  building a fake server: we do not need to reverse the HMAC scheme
  correctly for the client to accept our responses.
- Error detection is purely based on JSON shape: a response is treated
  as success as long as it has no `normalError` object and no `error`
  object. We just omit those keys.

## Proposed approach

1. **Traffic capture / verification pass (optional but recommended)**
   Run the APK in an Android emulator (or the user's rooted phone via
   adb) with mitmproxy in transparent/regular proxy mode once, purely
   to confirm real request shapes (exact form fields, headers, User-Agent)
   before hand-writing the fake server. This validates the static
   analysis above against ground truth.

2. **Build a local fake API server** (Node/Python, simple HTTP server)
   implementing at minimum:
   - `POST /inspection` → returns `{"inspection": {"url": "http://<local>/", "assetBundleUrl": "...", "utageResourceUrl": "...", "review": false}, "ts": <unixtime>}`
   - `POST /setup/first`, `POST /setup/comp` — new-user bootstrap flow
   - Whatever additional endpoints the client requests next, discovered
     iteratively by running the game against our server and reading its
     request logs (grey-box: server-driven exploration, since we have
     full IL access to `Assembly-CSharp.dll` to know what fields any
     given screen will demand next).

3. **Redirect the game's traffic to our server**:
   - Rooted phone: edit `/etc/hosts` to map `evangelion.donuts.ne.jp` →
     our machine's LAN IP, or use adb `reverse`/iptables redirect.
   - Emulator: use an emulator DNS override / custom AVD DNS, or run
     the fake server bound to the address the emulator resolves the
     hostname to (simplest: also override on emulator's hosts file,
     writable when running as root on emulator, or use `-dns-server`
     / a local DNS resolver like dnsmasq pointed at our IP).
   - mitmproxy can alternatively be used as the redirect mechanism
     itself (intercept + rewrite requests to local server) if hosts-file
     editing proves inconvenient on the target device.

4. **Iterate**: expand the fake server's endpoint coverage screen by
   screen — decompiling further `Assembly-CSharp.dll` sections
   on-demand for each new `apiName` the client calls, cross-referenced
   against expected JSON response shape (from `SetURL`-style setters
   and whatever deserializes each response into game data structures).

## Decisions (confirmed with user 2026-08-25)

- **Test target**: Android emulator first (fast iteration), rooted
  phone via adb as a later verification pass once the emulator setup
  works.
- **Scope**: Start with Phase 1 only — get the client past the
  connection-error screen (answer `inspection` + initial `setup/*`
  calls). Reassess how far to push toward real gameplay after that
  works.
- **Prior art**: none available from the user. Did a web search for
  any existing community reverse-engineering / private-server efforts
  for this game before starting from scratch — see findings in
  info.md ("Prior art search" section).

## Outcome (session paused 2026-08-25 — see info.md for full detail)

**Primary goal: achieved.** The client gets past the connection-error
screen and reaches its branded loading screen against our local fake
server. Solution ended up diverging from the plan above in two ways
discovered along the way:
- `evangelion.donuts.ne.jp` turned out to have **no DNS record at all**
  (not just a dead server — the hostname itself doesn't resolve), which
  ruled out the planned DNS-redirect approach. Solved instead by
  binary-patching the `BASE_URL` string in `Assembly-CSharp.dll` to point
  directly at the emulator's host-loopback address (`10.0.2.2`), keeping
  the same byte length so no re-linking was needed. See info.md for the
  exact patch.
- Went considerably further than Phase 1 as a bonus: reverse-engineered
  and hand-built the `BMData` AssetBundle (the next thing the client
  downloads after `inspection` succeeds) down to the exact byte format,
  using a leaked real Unity 4.3.1 engine source drop the user provided
  partway through. This is **not yet fully working** — one remaining
  bug (detailed in info.md) stops the client from reading the bundle's
  contents even though the bundle itself is no longer rejected.

**Not attempted**: real gameplay (Phase 2+). Confirmed no archived
original game content exists anywhere (asset bundles, character data,
puzzle-board data) — getting to actual gameplay would mean authoring all
of that from scratch, a substantially larger undertaking than server
emulation, and out of scope unless explicitly requested.

## Non-goals (unless requested)

- No attempt to defeat encryption used for account credential exchange
  (`TRIPLE_DES_KEY`/Bushimo login) — that's for a real login flow we
  don't need for a private local server; we can bypass by never hitting
  that path (create-new-user path only) or by handling it since we
  control the key already found (see info.md).
- No modification/repackaging of the APK is planned initially — network
  redirection should be enough. Repacking (e.g. to force cleartext /
  point at a hardcoded new host) is a fallback if hosts-based redirects
  prove unworkable on the test device.
