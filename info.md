# EVA Battle Mission — Reverse Engineering Findings

Source: `ヱヴァンゲリヲン_バトルミッション_2_2_0_APKPure.apk`
Package: `com.bushiroad.eva`
Engine: Unity (Mono backend, not IL2CPP) — `lib/armeabi-v7a/libmono.so` present.
Game DLL: `assets/bin/Data/Managed/Assembly-CSharp.dll` (fully decompilable
with `monodis`; disassembled once to
`scratchpad/assembly-csharp.il` during this analysis session — 533k lines,
~22MB).

## Session summary — status and how to resume (2026-08-25, end of session)

**Solved and verified working:**
- The original goal — get past the boot-time connection-error screen —
  works. Confirmed by screenshot: the game reaches its branded loading
  screen ("データダウンロード中").
- The `BMData` AssetBundle format is fully solved and verified against
  real Unity 4.3.1 engine source: the real 4.6.6f2 client no longer
  rejects our hand-built bundle for *any* compatibility/format reason.
  See "BMData AssetBundle" section below for the full spec and
  `server/build_bmdata.py` for the (documented, source-cited) builder.

**Not yet solved:**
- One narrower bug remains: `AssetBundle.Load("BundleData")` returns null
  at runtime (→ `NullReferenceException` in
  `AssetBundleResource.LoadResourceMap`), even though nothing rejects the
  bundle itself. Root-caused to a silent PPtr-resolution failure, likely
  (not yet confirmed) due to engine class-stripping of `TextAsset` in
  this specific compiled player build. Full detail, what's been ruled
  out, and concrete next experiments are in the "BMData AssetBundle"
  section's "Status" subsection below — **read that before touching this
  again**, several plausible-looking ideas have already been tried and
  didn't work.
- Beyond this bug: even a working `BMData` only gets to an empty/near-empty
  menu, since all the *real* game content (character art, puzzle-board
  data, scenario text, audio) only ever lived on Bushiroad's now-dead
  servers and was never archived anywhere (confirmed via Wayback Machine
  CDX search and general web search — see "Prior art search" below).
  Getting from "menu loads" to "playable game" would mean authoring
  replacement game content from scratch, a much bigger undertaking than
  anything done so far — see the conversation's "realistic next steps"
  discussion for how that was scoped.

**To resume environment state** (all of this may have been torn down
between sessions — check `ps aux` for `node server.js` / `qemu-system` /
`mitmdump` first):
1. Fake server: `cd server && node server.js` (listens on `:8080`).
2. Android emulator: `~/Android/Sdk/emulator/emulator -avd Pixel_3
   -no-snapshot -no-boot-anim -gpu swiftshader_indirect`, then
   `adb wait-for-device` and poll `adb shell getprop sys.boot_completed`.
3. The patched game (`com.bushiroad.eva`, `BASE_URL` byte-patched to
   `http://10.0.2.2:8080/`) should still be installed on the AVD's disk
   image if the same AVD is reused; if not, `server/patched-signed.apk`
   in this directory is the ready-to-install build (`adb install -r
   server/patched-signed.apk`).
4. Launch: `adb shell am start -n
   com.bushiroad.eva/com.unity3d.player.UnityPlayerActivity`, then watch
   `adb logcat` and `server/logs/requests.log`.

## Server URLs

| Purpose | URL | Source |
|---|---|---|
| **Main API base URL** (hardcoded default) | `http://evangelion.donuts.ne.jp/` | `Network.EvaApiClient` static ctor |
| Inquiry / contact page | `http://eva.bushimo.jp/contact` | `EvaApiClient.INQUIRY_URL` const |
| News list (relative path, appended to BASE_URL or asset host) | `webview/news/list` | `EvaApiClient.INFO_URL` const |
| Help page (relative path) | `webview/help` | `EvaApiClient.HELP_URL` const |
| Bushimo portal (Bushiroad's shared login/community SDK, separate system) | `https://www.bushimo.jp/m/...` (many sub-paths, login, dashboard, chat, store, faq etc.) | smali strings, `com.bushiroad.bushimo.sdk.android` |
| Bushimo login | `https://www.bushimo.jp/m/login/`, `.../login/index2.htm?consumer_key=` | smali |
| Ad/analytics (app-adforce, smbeat, MAT/mobileapptracker) | various `*.app-adforce.jp`, `*.smbeat.jp` | smali — not required for gameplay, safe to ignore/block |
| Bushimo image upload | `https://imgup.bushimo.jp/image/regist/timeline/` | smali |
| Archived official blog (dead, historical only) | `http://eva.bushimo.jp/archives/455`, `/about`, `/archives/81` | GameWiki.txt refs |

**Note:** the main game API (`evangelion.donuts.ne.jp`) is served over
**plain HTTP**, not HTTPS. No certificate pinning to work around. This
means a DNS-level redirect (hosts file / local DNS) pointed at a local
HTTP server is sufficient — mitmproxy is only needed if we want to
observe real traffic, not to strip TLS.

The Bushimo SDK (`bushimo.jp`) is a *separate*, shared Bushiroad
cross-game login/community portal — likely also dead, but not required
for core gameplay if we bypass/no-op that login path (game supports
"guest"/local pid-based accounts registered directly against the eva
API — see `RegisterUserId` / `setup/comp`).

## Client → Server protocol

- Transport: `UnityEngine.WWW` + `WWWForm` → **HTTP POST**, multipart
  form-data body, one field per param. Not JSON request bodies.
- Endpoint pattern: `BASE_URL + apiName`, e.g.
  `http://evangelion.donuts.ne.jp/inspection`,
  `http://evangelion.donuts.ne.jp/setup/first`,
  `http://evangelion.donuts.ne.jp/setup/comp`,
  `http://evangelion.donuts.ne.jp/bushimo/inheriting/comp`.
- Response: parsed as **JSON** (via bundled `MiniJSON`) into an
  `IDictionary`.

### Common request params (`EvaApiClient.CommonParams`, sent on every call)

| field | value |
|---|---|
| `ver` | `NativeHelper.GetVersionString()` (app version string) |
| `rev` | `"1"` (hardcoded, `EvaApiClient.REVISION`) |
| `ts` | current unix time |
| `deviceKind` | `2` (hardcoded const `EvaApiClient.deviceKind`) |
| `pid` | current user id (`int64`), included only once a user is registered (`userId != -1`) |
| `sig` | HMAC-style signature over the other params, see below |

### Signature

- `MakeSignature` → `SignatureUtil.MakeSignature(paramSignatureString, key)`.
- Key used: user-specific `binaryHash` if set, else the hardcoded
  fallback `931d5939aa1ae0eb3df6534574470f32`
  (`EvaApiClient.BINARY_HASH` const).
- **Important finding**: on the response side, `EvaRequestHandler.Handle()`
  calls `IsValidResponse(json)` but **discards its return value**
  (`pop` right after the call in IL). The client does **not** actually
  enforce a valid signature on server responses. We do not need to
  reverse/replicate the exact HMAC scheme for our fake server's replies
  to be accepted — success/failure is determined purely by JSON shape
  (see below), not by `sig`.
- We likely still don't need to validate the client's `sig` on requests
  either, since we're not defending against anything — just accept
  whatever it sends.

### Success/error JSON shape (`EvaRequestHandler.ParseError`)

- If top-level `normalError` key is a non-null object with
  `normalErrorCode` (int64) and `normalErrorMessage` (string) →
  treated as a fatal client-side error.
- Else if top-level `error` key is a non-null object with `errorCode`
  (int64) and `errorMessage` (string) → treated as an API error
  (error code `304`/`305` get special no-popup handling; other codes
  raise the standard error dialog).
- Else (both keys absent/null) → **success**.
- ⇒ **Our fake server should simply omit `normalError` and `error`
  from every successful response.**
- If response contains a top-level `ts` (int64), client resyncs its
  local clock to it (`TimeUtil.SetTime`). Safe/useful to always include
  `ts` = current unix time.
- If the underlying HTTP/WWW request itself fails (`request.status`
  false, e.g. connection refused/timeout) → this is the generic
  "network error" popup — i.e. **this is what the user is currently
  seeing**, before any JSON is even involved. Getting *any* HTTP 200
  response with parseable JSON back from `inspection` should already
  change/clear this screen.

## Key API flow (bootstrap sequence, in probable call order)

1. **`GetURL()`** → `POST {BASE_URL}inspection`
   - This is the very first server call on launch (server discovery /
     maintenance check). Response drives `SetURL`:
     ```
     response["inspection"]["url"]              -> new BASE_URL
     response["inspection"]["assetBundleUrl"]    -> ASSET_BUNDLE_URL
     response["inspection"]["utageResourceUrl"]  -> UTAGE_URL (visual-novel engine "Utage" resource host)
     response["inspection"]["review"]            -> bool, app-store-review-mode flag
     ```
   - Minimal viable response:
     ```json
     {
       "inspection": {
         "url": "http://<local-server>/",
         "assetBundleUrl": "http://<local-server>/assets/",
         "utageResourceUrl": "http://<local-server>/utage/",
         "review": false
       },
       "ts": 1234567890
     }
     ```
2. **`First()`** → `POST {BASE_URL}setup/first` — likely new-installation
   bootstrap / first-launch check.
3. **`RegisterUserId()`** → `POST {BASE_URL}setup/comp` with `tpid` =
   current user id — registers/confirms the local user id with the
   server (probably returns real assigned `pid`/account data).
4. **`BushimoCompRequest(inheritingId, inheritingUserId)`** →
   `POST {BASE_URL}bushimo/inheriting/comp` — account-inheritance /
   linking flow via the separate Bushimo portal; only relevant if we
   want to support the "log in via Bushimo to transfer save data"
   path. Skippable for a from-scratch local save.

Further endpoints (asset bundle downloads, actual puzzle-battle master
data, character/scenario data used by the "Utage" visual novel engine,
IAP/receipt checks) have not been reverse-engineered yet — to be
explored screen-by-screen as the fake server is built out, using
`Network.*` classes in `Assembly-CSharp.dll` as the reference for each
new `apiName` and expected response schema.

## Crypto material found (for reference, not yet needed)

- `TRIPLE_DES_KEY = "ce3eb25c02e3f12c3ef568a0"` — used by
  `EvaApiClient.Decrypt(encryptedUUID, iv)`, called from the
  `(userId, uuid, iv)` constructor overload. Purpose: decrypting a
  UUID handed back from a Bushimo account-linking flow. Not required
  if we avoid the Bushimo-login/account-inheritance path entirely.
- `BINARY_HASH` / default signature key:
  `931d5939aa1ae0eb3df6534574470f32`.

## Live test results (2026-08-25) — connection error cleared!

Set up: Android emulator (`Pixel_3` AVD, Android 9 image with ARM
translation, `~/.android/avd/Pixel_3.avd`) + a Node fake server at
`server/server.js` (port 8080).

**Key discovery during live testing**: `evangelion.donuts.ne.jp` has
**no DNS record at all anymore** (confirmed via `getent hosts` on the
host — NXDOMAIN), even though the parent domain `donuts.ne.jp` still
resolves. This is presumably why the game shows a connection error —
it can't even resolve the hostname, let alone connect. This ruled out
the originally-planned DNS-redirect approach (hosts-file edit needs
root, which the `google_apis_playstore` emulator image doesn't allow
via `adb root`; `-http-proxy` doesn't help either since it only
intercepts already-DNS-resolved TCP connections).

**Solution used instead: binary-patch the APK.** The `BASE_URL`
constant in `Network.EvaApiClient`'s static constructor
(`http://evangelion.donuts.ne.jp/`, 31 chars) was replaced in-place
inside `Assembly-CSharp.dll` with a same-length string pointing
directly at our fake server via the Android emulator's host-loopback
alias: `http://10.0.2.2:8080/eeeeeeeee/` (the `eeeeeeeee/` is inert
padding needed only to match the original string's byte length so the
Mono metadata heap stays valid — no real path significance; the fake
server strips it via suffix-matching routes). This avoids DNS
entirely — no root, no proxy, no hosts-file edit needed. The patched,
re-signed APK is at `server/patched-signed.apk` (see "How to
rebuild/reinstall" below); a fresh debug keystore was generated at
`server/debug.keystore` for signing (Play Store's original signature
can no longer be reproduced, doesn't matter for local sideloading).

**Result**: the client's very first call, `POST .../inspection`,
reached our fake server, got back a valid-shaped JSON response
(`{"inspection": {...}, "ts": ...}`), and the game **visibly moved
past the connection-error screen** into its branded loading screen
("データダウンロード中" / "Downloading data", with the loading
bar and EVA unit artwork). This is exactly the primary goal from
PLAN.md — confirmed working.

**Confirmed empirically (updates/corrects the earlier static-analysis
notes above):**
- Params are sent as a **URL query string** appended to the request
  URL (e.g. `...inspection?deviceKind=2&rev=1&sig=...&ts=...&ver=2.2.0`),
  not as a `WWWForm` multipart body, at least for `inspection`. The
  server now parses both (query string primary, body as fallback).
- `X-Unity-Version: 4.6.6f2` header — Unity engine version used.
- The predicted signature bypass is confirmed exactly as analyzed:
  logcat shows `Response has invalid signature. url: ... response:
  {...}` as a **non-fatal** `Unity E` log line — the game logs it and
  proceeds anyway. We do not need to implement real HMAC signing.
- `deviceKind=2`, `rev=1`, `ver=2.2.0` (matches installed APK version)
  confirmed as literal query params sent on every call.

**Next blocker found (past original scope, Phase 2 territory)**: after
`inspection` succeeds, the client calls `GET /assets/BMData` (via the
`assetBundleUrl` we handed back) expecting a **binary Unity
AssetBundle** (`AssetBundleResource.LoadResourceMap()`), not JSON. Our
server currently returns generic JSON for unknown routes, which the
asset-bundle loader can't parse, causing a `NullReferenceException`
inside `LoadResourceMap` — but this happens *after* the loading screen
is already showing, i.e. no user-visible error at this point, it just
likely gets stuck/times out on the loading screen. This is the next
thing to tackle if we push further (see PLAN.md scope note): we'd need
to either construct a real (possibly near-empty) Unity AssetBundle
here, or find out how much of the game degrades gracefully without
one.

## How to rebuild / reinstall the patched APK

```
# from a copy of the original APK extracted to apk_extract/, with the
# patched assets/bin/Data/Managed/Assembly-CSharp.dll already in place:
cd server
BT=~/Android/Sdk/build-tools/35.0.1
"$BT/zipalign" -f -p 4 patched-unsigned.apk patched-aligned.apk
"$BT/apksigner" sign --ks debug.keystore --ks-pass pass:android \
  --key-pass pass:android --out patched-signed.apk patched-aligned.apk

# install (must uninstall first — signature differs from the original):
adb uninstall com.bushiroad.eva
adb install -r patched-signed.apk
```

The one-line byte patch itself (Python, exact-length UTF-16LE
in-place replace):
```python
orig = 'http://evangelion.donuts.ne.jp/'.encode('utf-16-le')
new  = 'http://10.0.2.2:8080/eeeeeeeee/'.encode('utf-16-le')  # same byte length!
data = open('Assembly-CSharp.dll','rb').read()
assert data.count(orig) == 1
open('Assembly-CSharp.dll','wb').write(data.replace(orig, new))
```

## BMData AssetBundle — solved via real Unity 4.3.1 engine source (2026-08-25)

**Huge break**: the user had a leaked real Unity engine C++ source drop at
`/home/xh64bit/Projects/EvaBatMission/UnitySource/unity.7z` (Unity 4.3.1,
~2.1GB uncompressed, fully extracted to `/tmp/unity_full_src` this session
— re-extract with `7z x unity.7z -o<dir>` if needed, it's a solid archive
so partial extracts still take a while). This let us read the *actual*
runtime C++ that parses `WWW.assetBundle`, instead of guessing from
reverse-engineered tools (UnityPy, AssetStudio) that turned out to model a
couple of details differently for this old a version.

**Key source files** (paths inside the extracted tree):
- `unity/PlatformDependent/CommonWebPlugin/UnityWebStream.cpp` —
  `ParseStreamHeader()`: the real bundle-envelope binary format.
- `unity/Runtime/Serialize/SerializedFile.cpp` — `ReadMetadata()`,
  `kCurrentSerializeVersion` (=9 in this source).
- `unity/Runtime/Misc/AssetBundleUtility.cpp` — `FindAssetBundleObject()`
  and `TestAssetBundleCompatibility()`: the actual cause of the
  hardest-to-diagnose failure, see below.
- `unity/Runtime/Misc/AssetBundle.cpp`/`.h` — `AssetBundle::Transfer()`,
  `AssetInfo`, `CURRENT_RUNTIME_COMPATIBILITY_VERSION`.
- `unity/Runtime/BaseClasses/BaseObject.h` — `PPtr<T>::Transfer()`.
- `unity/Runtime/Serialize/TransferFunctions/SafeBinaryRead.h` —
  `TransferSTLStyleArray`/`Map` (used by the stripped/typetree-less player
  build, i.e. exactly our case): `[SInt32 count][elements…]`, map elements
  are `(key, value)` pairs.
- `unity/Runtime/Scripting/TextAsset.cpp`, `NamedObject.cpp` — field order.

The final, working builder is `server/build_bmdata.py` — read its module
docstring for the full field-by-field spec citing exact source lines. Key
findings that corrected earlier (wrong) assumptions from UnityPy/AssetStudio:

1. **No hash/crc fields exist anywhere in the bundle envelope header**, at
   any stream version. UnityPy/AssetStudio both assume `streamVersion>=4`
   adds a 16-byte hash + 4-byte crc — that's simply not true for this
   engine's `ParseStreamHeader()`. Including them (as an earlier attempt
   did) corrupts every subsequent header field, which manifested on-device
   as `Couldn't Decode LZMA Header ... props: 556e697479` (literally
   "Unity" in ASCII — i.e. `headerSize` got misread as 0, seeking back to
   the file's own signature bytes).
2. **`SerializedFile.m_Version` must be ≤ the runtime's own
   `kCurrentSerializeVersion`** (backward-compat check: `if
   (header.m_Version > kCurrentSerializeVersion) return false`) — this
   source's value is 9; used that instead of an earlier guess of 14 (from
   a modern AssetStudio/UnityPy compatibility chart that doesn't
   necessarily apply to this old a version).
3. **The `AssetBundle` object itself (classID 142) must be present** in
   the file, at fileID **1 or 2** specifically
   (`AssetBundleUtility.cpp:FindAssetBundleObject`) — a bare `TextAsset`
   alone (what two earlier attempts shipped) is not enough. Without it,
   Unity falls back to a synthetic `AssetBundle` with
   `m_RuntimeCompatibility = 0`, which then fails
   `TestAssetBundleCompatibility()`'s check that
   `m_RuntimeCompatibility >= AssetBundle::CURRENT_RUNTIME_COMPATIBILITY_VERSION`
   (=1) — producing exactly the on-device error seen: *"could not be
   loaded because it is not compatible with this newer version of the
   Unity runtime. Rebuild the AssetBundle to fix this error."* This was
   the hardest bug to trace — the error text talks about "runtime
   version" but has nothing to do with `SerializedFile.m_Version`; it's
   this specific manifest-object field.
4. The `AssetBundle.m_Container` map (`AssetBundle::GetPathRange`) does
   `ToLower()` on the *lookup* key only, so the *stored* key must already
   be lowercase (`"bundledata"`, not `"BundleData"`) to ever match — the
   game calls `AssetBundle.Load("BundleData")`.
5. When `typeCount==0` (no embedded type tree — required for a
   typetree-stripped player build, since a nonzero `typeCount` with no
   real tree data desyncs every field after it if the runtime can't parse
   type trees), `SerializedFile::ReadMetadata` enforces
   `needsVersionCheck`: either an exact full-engine-version string match,
   or — if `unityVersion` contains a `\n` — the substring after it must
   equal `kAssetBundleVersionNumber` ("1" in this source). We use the
   `"<version>\n1"` form specifically to avoid needing to match
   "4.6.6f2" byte-for-byte (confirmed correct by reading the *write* side
   too, `SerializedFile::BuildMetadataSection`, which does exactly this
   when the `kSerializedAssetBundleVersion` build option is set).

**Status**: with all of the above, the real 4.6.6f2 engine on device
stopped rejecting the bundle entirely — no more "can't be loaded" errors
of any kind, confirmed via logcat across several iterations. The
compatibility/envelope/format layer is fully solved. It now gets as far
as a `NullReferenceException` inside
`AssetBundleResource+<LoadResourceMap>c__Iterator9.MoveNext()`, with a
`ndk_translation: PC modified by signal handler` line just before it in
logcat — that's the emulator's ARM-on-x86 translation layer reporting a
genuine native null-pointer dereference caught by Mono's signal-handler
based null-check (not a software `if (x == null)` throw), confirming a
real null somewhere, not a logic/JSON-parsing error.

**Ruled out** (tested on-device, no change in behavior):
- Empty `BundleData` JSON array (`"[]"`) as the cause — tried a non-empty
  single-entry array (`[{"name":"dummy",...}]`), identical crash.
- A race between our near-instant localhost response and Unity's
  background WWW decompression thread — tried an artificial 800ms delay
  before the server responds to `/BMData` (`server.js`
  `handleBMData`/`delayMs`, still present, harmless to leave in), no
  change.

**Most likely remaining cause, narrowed via source but not yet fixed**:
traced the failure to `AssetBundleUtility.cpp`:
- `LoadNamedObjectFromAssetBundle()` (called by `AssetBundle.Load(string)`)
  → `ProcessAssetBundleEntries()`: for each container entry it does
  `Object* obj = i->second.asset;` (a `PPtr<Object>` implicit conversion,
  i.e. instance-ID resolution) and if `obj == NULL` it just **silently
  `continue`s** — no error logged anywhere. If nothing matched,
  `LoadNamedObjectFromAssetBundle` returns `NULL`, `AssetBundle.Load()`
  returns null in C#, and `ta.get_text()` on that null `TextAsset`
  reference throws exactly the NRE we see. This fits every observed
  symptom (silent, no native error, deep in `ProcessAssetBundleEntries`'s
  call chain) far better than a data-layout bug in the bundle envelope
  itself (which we've now independently confirmed is correct, since the
  bundle-level and file-level checks all pass silently too).
- PPtr resolution goes through `SerializedFile::ReadObject()`
  (`Runtime/Serialize/SerializedFile.cpp:1177`), which does
  `Object::Produce(info.classID, instanceId, kMemBaseObject, mode)` to
  construct the object, and returns/no-ops (no crash, no log) if that's
  NULL. **Leading hypothesis**: Unity strips unused native engine classes
  from release player builds; if this specific shipped build's linker
  never saw a *direct* native instantiation site for `TextAsset` (as
  opposed to just C# IL referencing `UnityEngine.TextAsset`, which the
  linker's static analysis may or may not have counted as "used"),
  `Object::Produce(49, ...)` could legitimately return null in **this
  particular compiled binary**, independent of anything in our hand-built
  bytes being wrong.
- Also independently confirmed **not** the bug (worth not re-checking):
  object-table sort order (`vector_map`/`sorted_vector` requires objects
  in ascending fileID order for its binary-search `find()` —
  `Runtime/Utilities/vector_map.h`; our fileIDs are written 1 then 2,
  already ascending, so this is fine); `RemapClassIDToNewClassID` (only
  remaps legacy ID 1012→1011, doesn't touch 142/49); string/map/PPtr wire
  encoding (independently confirmed against `SerializeTraits<UnityStr>`,
  `SafeBinaryRead::TransferSTLStyleArray/Map`, and `PPtr<T>::Transfer` in
  the source, not just inferred from community tools).

**Session update (2026-08-25, later in the day) — two hypotheses eliminated,
one new lead**:
- Re-read `AssetBundleResource.LoadResourceMap`'s actual IL: the crash line
  is `AssetBundle::Load(string)` → `isinst TextAsset` → `stfld ta` → later
  `ta.get_text()`. Since `isinst` on either a genuinely-null result or a
  non-null-wrong-type result both yield a null `ta`, **this NRE cannot
  distinguish "Load returned NULL" from "Load returned some other type"** —
  ruled out ever telling those apart from logcat alone with this call site.
- Found the actual decisive signal instead: `SerializedFile::ReadObject()`
  logs `ErrorString("Could not produce class with ID " + classID)` (a
  release-safe log, not `#if UNITY_EDITOR`-gated) whenever
  `Object::Produce()` returns NULL because `gRTTI` has no factory for that
  classID — i.e. exactly what "TextAsset is stripped" would look like.
  **Checked logcat across two full fresh app launches — this line never
  appears.** This is strong evidence classID 49 (TextAsset) *is* registered
  in this player's `gRTTI` and `Object::Produce(49, ...)` is succeeding —
  the class-stripping hypothesis from earlier in the day is likely wrong.
  Corroborated independently: `strings libunity.so` (extracted from the
  APK's `lib/armeabi-v7a/`) shows `UnityEngine.TextAsset::get_bytes` and
  `::get_text` icall registrations present in the binary.
- Tried the cheap experiment queued as "next" at the end of the previous
  session (native little-endian object/metadata bytes + `m_Endianess=0`,
  to eliminate `StreamedBinaryRead<true>`'s swap path as a variable — see
  `SerializedFile::ReadHeader`/`ReadObject` in
  `Runtime/Serialize/SerializedFile.cpp`, confirmed the *outer* 20-byte
  header is unconditionally big-endian regardless of this flag, only the
  metadata+object sections are affected). Implemented as
  `BMDATA_LITTLE_ENDIAN=1 python3 build_bmdata.py` (see `build_bmdata.py`
  top for the flag). **Identical crash, byte-for-byte same exception and
  stack line.** This rules out endianness/byte-swapping as the bug.
- New leading theory, not yet tested: traced `AssetBundle.Load(string)`'s
  actual PPtr resolution chain — `AssetBundle::GetPathRange()` →
  `ProcessAssetBundleEntries()` → `Object* obj = i->second.asset` (a
  `PPtr<Object>` → `Object*` implicit conversion) →
  `PPtr<T>::operator T*()` (`Runtime/BaseClasses/BaseObject.h:857-880`):
  ```
  if (GetInstanceID () == 0) return NULL;
  Object* temp = Object::IDToPointer (GetInstanceID ());
  if (temp == NULL) temp = ReadObjectFromPersistentManager (GetInstanceID ());
  ```
  `ReadObjectFromPersistentManager()` (`BaseObject.cpp:216`) has a player-build-only
  early-out: **`if (id < 0) return NULL;`** with the comment "In the Player
  it is not possible to call MakeObjectPersistent, thus instance id's that
  are positive are the only ones that can be loaded from disk". If the
  in-memory instance ID our container's `PPtr(fileID=0, pathID=2)` gets
  remapped to (via
  `PersistentManager::LocalSerializedObjectIdentifierToInstanceIDInternal`
  → `Remapper::GetOrGenerateMemoryID`) ever comes out negative for this
  specific loading path (WWW-streamed assetbundle, not a normal on-disk
  asset), the TextAsset would be **permanently unloadable in a player
  build no matter what our bytes say**, since it'd only ever be
  lazy-resolved through this exact NULL-returning branch. Skimmed
  `Remapper::GetOrGenerateMemoryID` (`Runtime/Serialize/Remapper.h:167`) —
  in the common path it hands out strictly positive, monotonically
  increasing IDs (`m_HighestMemoryID += 2`), which argues against this
  theory for the *normal* case, but there's also a
  `m_ActivePreallocatedPathID`-gated branch
  (`identifier.localIdentifierInFile * 2 + m_ActivePreallocatedIDBase`)
  whose base could plausibly be negative for a temporary/streamed
  assetbundle's namespace — not yet confirmed either way; ran out of
  session time before tracing what sets `m_ActivePreallocatedIDBase` for
  the WWW/UnityWebStream loading path specifically (grep
  `UnityWebStream.cpp` for it — a `PersistentManager` call, not something
  in `UnityWebStream.cpp` itself, first search there came up empty, so it
  must happen in whatever generic "mount this stream as a SerializedFile"
  codepath `WWW.assetBundle`/`PreloadManager` calls into, not yet located).

**Session update (2026-08-25, IL patch session) — root cause narrowed hard,
via ground truth from the real device instead of more guessing**:

Built an IL patcher using Mono.Cecil (NuGet, via `dotnet`) that opens
`Assembly-CSharp.dll`, finds `AssetBundleResource/<LoadResourceMap>c__Iterator9::MoveNext`,
and injects `Debug.Log(...)` calls around the crash site — since this is
Mono (not IL2CPP), the IL is directly editable/reassemblable, same trick
as the `BASE_URL` binary patch, just via Cecil instead of raw byte
replace since we're inserting instructions (which shifts every later
offset — infeasible to hand-patch bytes for this). Script:
`scratchpad/ilpatch/Program.cs` (session-local scratchpad, gone next
session — rewrite from this description if resumed, it's short).
Workflow each iteration: patch DLL → replace it inside a copy of
`server/patched-signed.apk` (plain `zip` update of the one entry,
preserving the existing `BASE_URL` patch) → zipalign → apksigner →
`adb install -r`.

**Empirical results, each one settled by an actual device run, not
inference:**
1. `Debug.Log(AssetBundle.Load("BundleData"))` (dup'd right before the
   `isinst TextAsset`) prints literally **`Null`** — i.e. `Load()` itself
   returns a genuine C++ NULL, not a wrong-typed object. This resolved an
   ambiguity noted at the end of the previous session (the crash site's
   `isinst` can't distinguish those two cases by itself).
2. `AssetBundle.Contains("BundleData")` (a pure `GetPathRange` container
   lookup, no PPtr dereference at all) — **`False`**. Tried with the
   container holding all 3 case variants of the key
   (`"BundleData"`/`"bundledata"`/`"BUNDLEDATA"`) simultaneously — still
   `False` for all. Rules out case-sensitivity/`ToLower()` theories
   entirely.
3. `AssetBundle.mainAsset` (a *direct* `bundle.m_MainAsset.asset` PPtr
   field read — `LoadMainObjectFromAssetBundle`, does not touch
   `m_Container`/the multimap at all) — also **`Null`**, with
   `m_MainAsset` pointed at the same TextAsset. This is the big one: it
   proves the bug is **not** in the multimap/container specifically (a
   live theory going into this session) — it's in resolving *any*
   same-file PPtr reference to the TextAsset object, full stop.
4. Swapped which fileID each object occupies (TextAsset at fileID 1 —
   the *first* object in the file, AssetBundle at fileID 2) and reran
   both probes. **Still `False`/`Null`** for the TextAsset reference,
   while the AssetBundle itself still resolves fine (found via
   `FindAssetBundleObject`'s direct path+fileID lookup, since it checks
   both fileID 1 and 2 explicitly — not via a PPtr). This rules out any
   theory tied to object *position* in the file (first vs. second
   entry, `vector_map`/`sorted_vector` ordering assumptions, etc.) —
   confirmed by re-reading `vector_map.h`/`sorted_vector.h` too: `m_Object`
   is populated via `push_unsorted` with **no subsequent `.sort()` call
   anywhere in `SerializedFile.cpp`**, which is a real oddity worth
   flagging, but doesn't explain our 2-object case since insertion order
   is already ascending either way.

**Where this leaves it**: the AssetBundle object itself always resolves
correctly (found via a *direct* `path+fileID → instanceID` lookup,
`PersistentManager::GetInstanceIDFromPathAndFileID`, independent of any
PPtr machinery). Every attempt to reach the TextAsset via a **PPtr stored
inside the AssetBundle's own serialized fields** (`m_Container`'s
`AssetInfo.asset`, or `m_MainAsset.asset` — both encode `m_FileID=0`
i.e. "this same file", per `PPtr<T>::Transfer`'s
`kNeedsInstanceIDRemapping` branch in `BaseObject.h`) fails silently —
no "Could not produce class" error (`Object::Produce` failing), no
`OutOfBoundsReadingError`, nothing — strongly suggesting
`SerializedFile::ReadObject`'s very first line,
`m_Object.find(fileID) == m_Object.end()`, is the one returning early
(the *only* silent, unlogged failure point in the whole traced chain).
Since object position/fileID value and case-sensitivity are now both
ruled out, the remaining live hypotheses are: (a) something about how
`localSerializedFileIndex == 0` (the "self-reference" convention) gets
resolved specifically for a **WWW-streamed** file's `activeNameSpace`
differs from what a directly-mounted file gets — i.e. self-referential
PPtrs may need a *different* `m_FileID` encoding than 0 for this specific
loading path, not yet tried; or (b) a field-layout mistake elsewhere in
`AssetBundle::Transfer` that happens to still produce a
plausible-looking `m_RuntimeCompatibility` by coincidence (deemed
unlikely — a random 4-byte misread landing on exactly `1` is possible but
not the way to bet) but not yet independently cross-checked against a
byte-perfect *real* reference bundle.

**Concrete next experiments, in rough cheapest-first order, if resumed**:
- (new, cheapest) Try non-zero `m_FileID` values for the self-referential
  PPtrs (e.g. `1`, or whatever `InsertPathNameInternal` would assign this
  bundle's own path as a *non-self* external reference) instead of `0`,
  in case WWW-streamed bundles don't use the "0 = this file" convention
  the way normal scene/asset files loaded via `LoadExternalStream` do.
  Cheap to try — same IL-diagnostic APK is already built and installed,
  just needs a new `BMData.bundle` to test each variant against.
- The IL-patch harness above is now reusable infrastructure — any future
  hypothesis can be tested empirically on-device in a few minutes rather
  than argued from source alone. Keep using it before falling back to
  the Wine/Editor reference-bundle path.

## Session update (2026-08-25, Wine Unity 4.1.3 Editor session)

The user got a real Unity Editor (4.1.3f3) running via Wine, offline-
activated (license at
`~/.wine/drive_c/ProgramData/Unity/Unity_v4.x.ulf`), at
`/home/xh64bit/.wine/drive_c/Program Files (x86)/Unity/Editor/Unity.exe`.
Fully scriptable via `-batchmode -quit -nographics -executeMethod` (Wine
maps the Linux filesystem at `Z:\...`, so a plain Linux path works after
`winepath -w`) — no interactive steps ended up being needed. Full
resume-from-scratch recipe (project setup + build script) is below since
the scratchpad project is session-local:

```
mkdir -p <proj>/Assets/Editor
echo '[]' > <proj>/Assets/BundleData.txt
cat > <proj>/Assets/Editor/BuildScript.cs <<'CS'
using UnityEngine; using UnityEditor;
public class BuildScript {
  public static void BuildAndroid() {
    Object ta = AssetDatabase.LoadAssetAtPath("Assets/BundleData.txt", typeof(TextAsset));
    BuildPipeline.BuildAssetBundle(null, new Object[]{ta}, "BMData_reference.unity3d",
      BuildAssetBundleOptions.CollectDependencies | BuildAssetBundleOptions.CompleteAssets,
      BuildTarget.Android);
  }
}
CS
cd "/home/xh64bit/.wine/drive_c/Program Files (x86)/Unity/Editor/"
PROJ=$(winepath -w <proj>)
wine Unity.exe -batchmode -quit -nographics -createProject "$PROJ"        # first run only
wine Unity.exe -batchmode -quit -nographics -projectPath "$PROJ" -executeMethod BuildScript.BuildAndroid
```

Produced a genuine, real-engine-built `BMData_reference.unity3d` (225
bytes) and hand-parsed it byte-for-byte (no assumptions — every field
size/offset verified against the actual bytes, cross-checked against the
same `Runtime/Serialize/SerializeTraits.h` /
`Runtime/Serialize/TransferFunctions/StreamedBinaryRead.h` /
`Runtime/Serialize/CacheWrap.cpp` source used throughout this
investigation). **Two concrete, confirmed-correct facts came out of
this** (both now reflected in `build_bmdata.py`):

1. **`m_PreloadTable` is not empty.** A real bundle has one `PPtr`
   entry per referenced object, and `m_Container`'s (and presumably
   `m_MainAsset`'s) `AssetInfo.preloadIndex`/`preloadSize` point *into*
   that table (real bundle: `preloadIndex=0, preloadSize=1`) — every
   version of `build_bmdata.py` before this session left the table empty
   and every `AssetInfo` at `(0, 0)`. Fixed.
2. **Android-target bundles are little-endian** (`m_Endianess=0`,
   matching Android's native endianness) for the metadata/object
   section — not big-endian. The *outer* 20-byte `SerializedFileHeader`,
   the directory table, and the outer `"UnityWeb"` stream header/prefix
   are separately confirmed **unconditionally big-endian regardless of
   `m_Endianess`** (verified against the reference bundle's raw bytes,
   not just inferred) — this was a bug in `build_bmdata.py` at the start
   of this session (the `ENDIAN` toggle was leaking into those
   always-big-endian layers too); fixed in `build_bundle()`.

**However — applying fix #2 (switching to little-endian) surfaced a
new, unexplained problem**: on-device, the engine started logging a
previously-never-seen error, `ErrorString`'d loudly (i.e. NOT one of the
silent-failure paths this whole investigation has been fighting):
```
Mismatched serialization in the builtin class 'AssetBundle'.
(Read <N-1> bytes but expected <N> bytes)
The asset bundle '...' could not be loaded because it is not compatible
with this newer version of the Unity runtime.
```
Always short by **exactly 1 byte**, reproduced identically both with and
without the preload-table fix (i.e. it's purely an endianness-flip
artifact, not related to fix #1). Investigated at length — checked
`AllowTransferOptimization()` for every type in the structure (`PPtr`
explicitly returns `false`, ruling out the `TransferSTLStyleArray` fast
"ReadDirect" path for the preload table), checked `SerializeTraits` for
`vector`/`multimap` for a stray extra `Align()` call (none), checked
`TransferBase::IsOldVersion()` (unconditionally `false` for
`StreamedBinaryRead`, confirming no field is being conditionally
skipped), checked `CachedReader::Align4Read()` for a cache-block-boundary
edge case (looks self-consistent given our offsets are already
multiples of 4) — **no root cause found**. Given the byte-exact
big-endian encoding has zero mismatch (many confirmed runs, including
this session), `build_bmdata.py` defaults back to `ENDIAN=">"` /
`m_Endianess=1` for now (`BMDATA_LITTLE_ENDIAN=1` env var to re-enable
the little-endian path for further debugging) — **even though we now
have hard evidence real Android bundles are little-endian**, so this
default is a "known good enough to keep debugging with" choice, not a
"confirmed correct" one.

**Combining fix #1 (preload table) with the proven-byte-exact
big-endian encoding did NOT fix the original bug** — `Contains()` and
`.mainAsset` are still `False`/`Null` on-device, identically to before
this session. So the preload-table structure, while now confirmed
correct against a real bundle, was not (on its own, in big-endian) the
cause of the original resolution failure either.

**Where this leaves things**: two real, confirmed structural bugs were
found and fixed this session (preload table, endianness-layering), but
neither explains the core "same-file PPtr never resolves" symptom
established last session, and fixing the *coarse* endianness question
paradoxically introduced a *new*, cleanly-diagnosable byte-accounting
bug that itself remains unexplained. The reference bundle from 4.1.3 is
also known to be an imperfect ground truth for a 4.6.6f2 reader (its
`AssetBundle` object is provably shorter — no `m_RuntimeCompatibility`
field at all, since that field's `SetVersion(3)`/`CURRENT_RUNTIME_
COMPATIBILITY_VERSION` check was added in a later Unity release — so it
can validate structure/field-order but not be used verbatim on-device).
**SOLVED (2026-08-25, same session, continued):** used exactly that
oracle to bisect. Built a series of variants inserting explicit
zero-byte padding at different candidate positions in the AssetBundle
object (right after `m_Name`, after `m_PreloadTable`, after
`m_Container`, after `m_MainAsset`, right before `m_RuntimeCompatibility`)
and checked both the "Read N / expected M" byte count AND the actual
on-device `Contains()`/`.mainAsset` behavior for each. **3 zero bytes
inserted right after `m_Name`, before `m_PreloadTable`, is the fix** —
this device's real engine (4.6.6f2) has an extra, currently-unidentified
3-byte field there that doesn't exist in the 4.3.1 engine source this
whole investigation was built against (some field added to `AssetBundle`
between 4.3.1 and 4.6.6f2). Zero-filling it works fine — no need to know
its real semantic meaning. Confirmed multiple times, including with a
clean rebuild through the *permanent* `build_bmdata.py` (not just the
ad-hoc bisection script): **zero errors of any kind on device**
(`BMDATA_DEBUG_CONTAINS`/`mainAsset` probes still installed from the IL
patch weren't even reached because the code path changed — the game
sails straight through `AssetBundleResource.LoadResourceMap` and
requests a new endpoint next, `GET /assets/BMRedirect.txt`).

This is now baked permanently into `build_bmdata.py`:
`build_asset_bundle_object()` writes `b"\x00\x00\x00"` right after
`m_Name`, and `ENDIAN`/`FILE_ENDIANESS_BYTE` default to little-endian
(`BMDATA_BIG_ENDIAN=1` env var to go back to the old, no-longer-needed
big-endian path). Also removed a stale assertion
(`assert len(data) % 4 == 0` in `build_serialized_file`) that assumed
every object's own byte length had to be a multiple of 4 — not a real
requirement (only string/array *content* needs 4-byte alignment via
explicit `Align()` calls, not object-to-object boundaries), and the
AssetBundle object is now legitimately 83 bytes (not a multiple of 4).

**`scratchpad/validate_bmdata.py` is now stale** (doesn't know about the
3-byte field) — either update it to skip those 3 bytes or just trust
on-device testing going forward; it served its purpose (catching real
byte-format bugs before device testing) but the device itself is now the
more reliable oracle given how many subtle field-layout facts turned out
to differ from the 4.3.1 source.

**`BMRedirect.txt` handled (2026-08-25, same session)**: traced via IL —
`DownloadManager.Start()` (`<Start>c__Iterator2.MoveNext`) fetches this
via a plain `new WWW(url)` right after `BMData` loads. If the request
"succeeds" (any HTTP 200, regardless of body), the response TEXT is fed
through `BMUtility.InterpretPath()` then `new Uri(...)`, and
**overwrites** `DownloadManager.downloadRootUrl` — replacing what
`initRootUrl()` had already set from the `inspection` response's
`assetBundleUrl` (via the static `DownloadManager.manualUrl`, set by
`AssetBundleResource.LoadResourceMap` calling `SetManualUrl` on first
use). Our old generic JSON stub (`{"ts":...}`) would have been fed to
`new Uri()` as garbage, either throwing or corrupting all future download
URLs. Fixed: `server.js` now has `handleBMRedirect()` returning our own
`assetBundleUrl` as **plain text** (`Content-Type: text/plain`, added a
new `{text: "..."}` response-type branch in the dispatcher, alongside the
existing JSON/binary ones) — a harmless no-op redirect back to ourselves.
Confirmed working: the client re-fetches `BMData` cleanly after this and
moves on to the next stage with no errors from this step.

**Next blocker found, past the original scope of this whole
investigation**: `DownloadManager.Start()` continues past `BMRedirect`
into checking `PlayerPrefs.HasKey("BMDataVersion")`, then (if
`bmUrl.offlineCache` is true, which it is per the baked-in `Resources
Load("Urls")` TextAsset) calls
**`WWW.LoadFromCacheOrDownload(bmDataUrl, lastBMDataVersion+1)`** — a
completely different, **disk-cache-backed** download API
(`ENABLE_CACHING`/`WWWCached` in the engine source, ties into Unity's
`Caching` class) rather than the plain `new WWW(url)` used everywhere
else so far. This throws a `NullReferenceException` inside
`DownloadManager+<Start>c__Iterator2.MoveNext()` on-device — a fresh,
unrelated problem, not yet investigated (likely needs either a real CRC
argument, the emulator's cache directory/`Caching` system initialized
correctly, or the version-number-based cache-busting URL suffix
`LoadFromCacheOrDownload` appends to be something our server actually
recognizes and serves). **Not started yet** — good next step if resumed.

**Overall status**: the core mystery this entire investigation was built
around — AssetBundle.Load/Contains/mainAsset always returning
null/false for a hand-built bundle — is SOLVED. The client now cleanly
loads our hand-built `BMData` bundle, parses its `TextAsset` content,
and proceeds into real `DownloadManager` bootstrap logic several steps
further than this project has ever previously reached.

## Session update (2026-08-25, continued — DownloadManager.LoadFromCacheOrDownload)

Traced the `NullReferenceException` in `DownloadManager+<Start>c__Iterator2.MoveNext()`
via IL: after the `BMRedirect.txt` step, `DownloadManager.Start()`
re-downloads the SAME `BMData` URL a second time (via
`WWW.LoadFromCacheOrDownload(bmDataUrl, lastBMDataVersion+1)` — a
disk-cache-backed WWW variant, `WWWCached` in engine source, still
resolves to the same `ExtractAssetBundle`/ `ExtractAssetBundle` extraction
path we already fixed, so no new format issue there) and this time
expects **three** named `TextAsset`s out of it, not just one:
- `"BundleData"` → `List<BundleData>` (already had this)
- `"BuildStates"` → `List<BundleBuildState>`
- `"BMConfiger"` → `BMConfiger` (a single object, not a list — plain
  POD fields: `compress`, `deterministicBundle`, `bundleSuffix`,
  `buildOutputPath`, `useCache`, `useCRC`, `downloadThreadsCount`,
  `downloadRetryTime`, `bmVersion`)

(Also found and ruled out as *not* needed: `TestDownloadManager`, a
separate/unused test class in the same DLL, wants `"worker"`, `"Cube"`,
`"Sphere"` TextAssets — not on the real code path, don't need these.)

Generalized `build_bmdata.py` to build a bundle with an arbitrary number
of named `TextAsset`s sharing one `AssetBundle` manifest object
(`build_asset_bundle_object()` now takes a list of `(name, fileID)`
pairs; `build_serialized_file()` takes a `{name: json_text}` dict).
`build_bmdata_bundle()` now always includes all three:
`"BuildStates": "[]"`, `"BMConfiger": "{}"` (empty object — its `.ctor`
sets sane defaults and LitJson only overrides fields present in the
JSON) alongside the real `"BundleData"` payload.

**Confirmed on-device**: zero errors, zero crashes anywhere in this
flow now (checked over a 40+ second window, multiple full logcat dumps).
`server.js`'s `handleBMRedirect()` (added this session, see above) and
the 3-TextAsset `BMData` bundle are both working correctly together.

**Where it stops now**: the app sits indefinitely on the
"データダウンロード中" (downloading data) loading screen — alive and
still animating (confirmed via two screenshots ~35s apart showing the
character silhouette in different poses, i.e. not frozen/crashed), but
makes no further network requests (checked the request log over the
same window — nothing after the third `BMData` fetch). This is
consistent with what PLAN.md/info.md already established: `bundles`
(from `BundleData`) is an empty list since we have no real asset-bundle
manifest data, so whatever's *next* in the scene-load pipeline
(presumably `TitleController`/title-screen asset loading, referenced in
an earlier logcat stack trace this project captured) has nothing to
load and is either idling on a `WaitForSeconds`-style coroutine forever,
or waiting on a **local** (non-networked) resource that's part of the
scene/prefab graph and isn't reachable through anything this project
can influence from the server side. Confirmed (again) via prior web
research: no original game content (character art, puzzle-board data,
scenario text) is archived anywhere, so getting from here to an
actually-playable screen would mean authoring replacement content from
scratch — a fundamentally different, much larger undertaking than the
protocol/format reverse-engineering this project has been doing, and
out of scope unless explicitly requested.

**If resumed**: the next useful step would be static analysis (not
server changes) — decompile whatever runs after `DownloadManager.Start()`
returns (search IL for what calls `DownloadManager.Start()`/awaits it,
likely `TitleController` per the earlier stack trace) to find out
exactly what it's blocked on, and whether it's a network call this
project hasn't seen yet (in which case: keep going, screen-by-screen,
same as always) or a hard dependency on real asset content (in which
case this is close to the natural end of what server-side emulation
alone can achieve).

## Session update (2026-08-25, continued — pushed all the way to real master data)

Kept going screen-by-screen from the "stuck idle on loading screen, no
crash" state above, all the way to the actual content wall. In order:

1. **Root-caused the idle freeze**: `TitleController.DownloadAssetBundle()`
   loops `while (AssetBundleResource.Instance.GetProgress() < 1) yield
   return null;` before doing anything else.
   `AssetBundleResource.GetProgress()` delegates to
   `DownloadManager.ProgressOfBundles(assetBundles)`, which **explicitly
   returns `0.0` (not `1.0`/NaN) when its total weight is zero** — i.e.
   an empty `BundleData` list (`"[]"`, what every prior session used)
   can *never* reach progress 1.0. This is why the app sat there
   animating forever with zero network activity and zero crashes: not a
   bug, just nothing to download.
2. Fixed by adding one real, downloadable dummy bundle:
   `BundleData: [{"name": "dummy"}]`, a matching `BuildStates` entry
   (`DownloadManager.download()` does a raw `buildStatesDict[name]`
   indexer — no matching entry throws `KeyNotFoundException`, confirmed
   on-device), and a new server route serving a minimal valid (empty,
   content-free) AssetBundle at `/assets/dummy.assetBundle`. All three
   are now generated together by `build_bmdata.py`
   (`build_bmdata_bundle()`'s new `DUMMY_BUNDLE_NAME` mechanism +
   `build_empty_bundle()`), with `server.js`'s new `handleDummyBundle()`
   serving the second file. Confirmed: progress reaches 1.0, and the
   client moves on to `POST /setup/first` for the first time ever.
3. **`/setup/first`**: `TitleController.OnFirst()` does
   `response["firstSetup"]` and passes it straight into
   `FirstSetUpData.Parse()` with **no null-check** — our old bare
   `{"ts":...}` stub made this a `NullReferenceException`. Needs a
   `"firstSetup": {...}` nested object (its 3 fields — `tpid`/`eud`/`ivs`
   — are read via a reflection loop that silently skips any key not
   present, so a minimal object is fine *structurally*).
4. **The `eud`/`ivs` crypto wall**: even with `firstSetup` present,
   leaving `eud`/`ivs` unset (or empty) makes
   `EvaApiClient(userId, uuid, iv)`'s constructor throw
   `CryptographicException: IV length is different than block size` —
   it unconditionally TripleDES-decrypts `eud` using `ivs` as the IV,
   regardless of whether there's anything meaningful to decrypt. Traced
   `EvaApiClient.Decrypt`'s exact IL to get the precise algorithm:
   `TripleDES.Create()`, `Mode=CBC` (enum value 1), `Padding=PKCS7`
   (value 2), `Key=Encoding.ASCII.GetBytes("ce3eb25c02e3f12c3ef568a0")`
   (24 bytes — the `BINARY_HASH`-adjacent constant from earlier
   sessions), and — confirmed via `StringToByteArray`'s IL, a manual
   hex-digit-pair decoder — **both `eud` and `ivs` are hex strings, not
   base64**. Since response/signature validation is already known to be
   ignored client-side, the *decrypted content* doesn't matter — only
   that decryption doesn't throw. Fixed by precomputing a valid
   TripleDES-CBC-PKCS7 ciphertext with Node's `crypto` module
   (`des-ede3-cbc`, verified round-trips correctly) and hardcoding the
   IV/ciphertext hex in `server.js` (`CRYPTO_IVS`/`CRYPTO_EUD`).
   **Gotcha hit while testing this**: `PlayerPrefs` persists across app
   relaunches within the same install — an earlier broken run's
   empty/invalid `uuid`/`iv` stayed cached, so the client skipped
   `/setup/first` on the next launch and hit the *same* crypto exception
   via the returning-user login path instead. `adb shell pm clear
   com.bushiroad.eva` before each fresh-install-behavior test is
   necessary now that the client actually persists state.
5. **`/setup/comp`**: already handled correctly (echoes `tpid` back as
   `pid`) — no changes needed, and it now actually gets exercised
   end-to-end.
6. **`POST /master`** (brand new endpoint, never seen before this
   session): `Master.MasterInitializer.ParseMaster()` does
   `((IList)response["masterData"]).Cast<IDictionary>()` with no
   null-check (`ArgumentNullException` on a missing key) — needs a
   `"masterData": [...]` array of `{"tableName": ..., "tableValues":
   [...]}` entries. Added `handleMaster()` returning `{"masterData": []}`
   to get past the immediate crash.
7. **The real wall**: `Master.MasterInitializer.Load()` doesn't iterate
   whatever `masterData` we send — it iterates a **hardcoded, compiled-in
   array of `System.Type`** (`MasterInitializer.assetNames`, confirmed
   via IL — a `Type[]` literal built with 61 `ldtoken Master.<Name>`
   entries: `Master.RaidEncount`, `Master.Scenario`, `Master.SkillLeader`,
   `Master.Tips`, `Master.ShopStone`, etc.) and does a **raw dictionary
   indexer** (`data[tableName]`, not `TryGetValue`) for every single one
   — so an empty (or partial) `masterData` throws `KeyNotFoundException`
   the moment it reaches the first table we didn't provide.

**This is the real, structural end of protocol/format reverse-engineering
for this project.** Getting further means providing content for all 61
of those tables (`Master.*` — character stats, scenario/story text,
skills, raid encounters, shop items, tips, and more) with real-enough
field values that the loaded data doesn't immediately break something
else downstream (e.g. a starting character/deck that UI code assumes
exists). That's authoring a large fraction of the game's actual design
data from scratch — a fundamentally different, much bigger undertaking
than anything this project has done so far (which has all been format
emulation: given real bytes/structure knowledge, produce syntactically
valid data satisfying it). Confirmed via this session's IL work that the
61 table names are all we'd need to enumerate to scope that task
precisely, if ever wanted — search `assembly-csharp.il` for
`ldtoken Master\.` to get the full list.

## Session update (2026-08-26 — reached the actual live main menu)

Ran the "stub all 61 master tables empty" experiment. Result:
**no `KeyNotFoundException` at all** — the client sailed straight past
`/master` into a brand-new endpoint, `POST /login`. This settles the
scoping question from the previous update: **master-data content is
NOT required to reach a playable state.** The 61-table wall was a false
alarm — it only needed *presence*, not real content.

Kept going, tracing each new crash via IL exactly as before:

- **`/login`**: `PlayerStatus.Login()`/`TitleController.OnLogin()`
  require a `response["login"]` dict with `userCardList`/`userDeckList`
  (empty ILists are fine — the per-item parse lambdas just never run),
  `userStatus` (empty `{}` is fine, same lenient `JsonData<T>` reflection
  pattern as `FirstSetUpData`), `selectMission.chapterList` (empty list),
  `maxCardExtension` (must be a bare JSON integer — gets `unbox.any
  Int64`, a decimal would throw `InvalidCastException`), and `tosVersion`
  (string). **Non-obvious gotcha**: `tutorial` is read via `ldarg.0`
  (the TOP-LEVEL response), not `ldloc.0` (the "login" sub-dict) like
  every other field in this method — nesting it under `"login"` (the
  natural-looking guess) still NRE'd; it has to be a sibling of `login`
  at the top level. Fixed in `server.js`'s `handleLogin()`.
- With that, `/login` succeeded end-to-end. **The client then showed a
  Terms of Service dialog, accepted it, showed a real "Now Loading..."
  screen with character art (Misato) and an actual progress bar, and
  landed on the real, live, fully interactive main menu** — bottom nav
  bar with マイページ (MyPage/NERV) / ミッション (Mission) / カード
  (Card) / ショップ (Shop) / ガチャ (Gacha) / フレンド (Friend) / ギルド
  (Guild), a MENU button, level indicator, currency counters. This is
  the actual game, not a stub screen.

**One crash was hit along the way**: the embedded Chrome WebView
renderer process crashed (`chromium: aw_browser_terminator.cc: Renderer
process crash detected`) while loading the ToS page content (which is
just our generic `{"ts":...}` JSON stub for the unimplemented
`GET /webview/tos` route, rendered raw by Chrome's WebView), which then
caused Unity's own C# code to throw `InvalidOperationException` trying
to use the now-dead WebView. This looks like an Android WebView/emulator
stability issue triggered by feeding it non-HTML content, not a protocol
or data-format bug — **relaunching the app immediately afterward landed
cleanly on the main menu**, so it wasn't a hard blocker. If it recurs,
implementing `/webview/tos` (and `/webview/help`, `/webview/news/list`
per `EvaApiClient` constants) to return minimal real HTML instead of raw
JSON would be the fix.

**Newly discovered endpoints, not yet implemented** (currently answered
by the generic `{"ts":...}` stub, logged as unknown):
`GET /resource/images/bigcard/<id>_bigcard.png` (card art — explains the
big broken-texture blob on the main menu screenshot), `POST /mypage`
(home-screen player data), `GET /webview/tos`.

**Where this actually leaves the project**: past the entire bootstrap
chain and into the live, playable-looking main menu, with real game UI
rendering and navigable. The originally-worried-about 61-table content
wall turned out not to matter for reaching this point. Real per-screen
content (card art, mission data, shop contents) will presumably still be
needed once navigating into those specific screens — but the "protocol
emulation vs. content authoring" boundary is now demonstrably much
further out than this project assumed even a few hours ago in the same
session. Next step if resumed: navigate into a nav-bar screen (e.g.
ミッション) and see what it actually needs — likely resumes needing the
real Tier 1/2 master data (`m_card`, `m_mission`, `m_wave`, etc.) this
session deliberately left empty to test the bootstrap-only path.

**Summary of what a resumed session inherits**: a fully working local
private-server emulation from cold boot through real account
setup/first/comp/login and ToS acceptance, all the way to the actual
live, interactive main menu screen — using only protocol-format
knowledge, zero real master/card/mission content. Far further than this
project ever expected to get from format emulation alone.
0. (new, from this session) Find and read whatever sets
   `m_ActivePreallocatedPathID`/`m_ActivePreallocatedIDBase` for a
   WWW-streamed/temporary assetbundle load, to confirm or kill the
   negative-instance-ID theory above — this is now the most-likely
   remaining explanation given class-stripping and endianness are both
   ruled out.
1. Try `LoadMainObjectFromAssetBundle`-style access instead (i.e. set
   `m_MainAsset` to point at the TextAsset and see whether *that* path,
   which doesn't go through `ProcessAssetBundleEntries`'s per-entry
   PPtr walk, behaves differently) — would help confirm/deny the
   class-stripping hypothesis without needing new tooling.
2. Try a different, definitely-not-stripped class for the manifest
   payload instead of `TextAsset` — if some other simple class (e.g.
   `GameObject`) resolves fine where `TextAsset` doesn't, that's strong
   confirmation of class stripping specifically.
3. Search the APK's `classes.dex`/native libs for any string table or
   metadata listing linked/registered native classes, to check directly
   whether TextAsset is present, instead of inferring indirectly.
4. As a bigger fallback if 1–3 dead-end: build a *second* real reference
   bundle using the same Wine + Unity 4.6.5 Editor path from earlier in
   this session (license-server TLS/cert issues were resolved — see
   "Unity Editor via Wine" section below — the remaining blocker there
   was only the interactive login step) containing a real `TextAsset`,
   and byte-diff it against our hand-built one to catch anything the
   source-reading missed.

**Build command**: `python3 server/build_bmdata.py '<json>' server/BMData.bundle`
(needs no dependencies beyond the stdlib — `lzma`, `struct`). The
`server.js` `/BMData` route already serves this file's bytes directly.

## Unity 4.6.5 Editor via Wine (set up, not fully used — kept for reference)

Before finding the real leaked engine source (above), the plan was to get
a genuine Unity Editor running to produce a byte-perfect reference
AssetBundle. This got most of the way to actually working and is worth
keeping set up in case it's useful later (e.g. experiment #4 above), even
though the source-reading approach ended up being what actually cracked
the format.

**Why Wine at all**: Unity 4.6.6f2 has no native Linux Editor build —
Unity's first-ever Linux Editor was 2018.1, by which point the legacy
`BuildPipeline.BuildAssetBundle` API (the one that produces this exact old
container format) was long gone. So a genuinely old, Windows-only Editor
running under Wine is the only way to get a real reference build on this
machine.

**What's installed and where**:
- Installer: `UnitySetup-4.6.5.exe` (md5
  `4610c2ba76a0db2b612fdfc2bf1c044e`), downloaded from
  `https://archive.org/download/unity-setup-4.6.5/UnitySetup-4.6.5.exe`
  (an Internet Archive item hosting several old Unity installers). 4.6.5
  is one patch release behind the game's 4.6.6f2 but the on-disk asset
  bundle format is extremely unlikely to differ between two patch
  releases of the same minor version.
- Wine prefix: `$SCRATCH/wineprefix` (session scratchpad dir — see below
  for what `$SCRATCH` resolves to; **this is under `/tmp` and will not
  survive a reboot** — the installer above would need to be re-run if so).
  Installed via `wine UnitySetup-4.6.5.exe /S /D=C:\Unity` (silent NSIS
  install) → `C:\Unity\Unity.exe`.
- A prepared (but not yet built against) sample project at
  `$SCRATCH/BMDataProject`: `Assets/BundleData.txt` (content `[]`) +
  `Assets/Editor/BuildScript.cs` (a `BuildScript.Build()` static method
  calling the legacy `BuildPipeline.BuildAssetBundle` API, meant to be
  invoked via `Unity.exe -batchmode -quit -nographics -projectPath ...
  -executeMethod BuildScript.Build`). Batch mode was never actually
  reached — see blockers below.
- `$SCRATCH` = the session's scratchpad path from this conversation,
  something like
  `/tmp/claude-1000/-home-xh64bit-Projects-EvaBatMission/<session-id>/scratchpad`
  — **a fresh session will have a different path**; treat all of the
  above as "how to redo it", not live paths to reuse directly.

**Blockers hit and fixed, in order**:
1. `-batchmode` crashed immediately (Wine page fault) with no log —
   turned out Unity was blocked on a first-run **license activation**
   dialog, which batch mode can't drive. Confirmed by launching
   interactively (`wine Unity.exe`, no flags) under the session's real X
   display and screenshotting the actual window
   (`magick import -window <id> out.png` — targeting a specific window ID
   works; `-window root` mysteriously always fails with "missing an image
   filename" in this environment, use `xdotool search --name "..."` to
   get window IDs first).
2. License activation showed "Connecting to License Server", then failed
   with `Error: Peer certificate cannot be authenticated with known CA
   certificates for https://license.unity3d.com/...`. **`license.unity3d.com`
   is still alive and responding (HTTP 200)** as of 2026-08-25 — this was
   a stale trust store, not a dead server. Fix: Unity's embedded
   WebKit/curl uses its own CA bundle at
   `C:\Unity\WebKit.resources\certificates\cacert.pem` (dated 2009 in the
   installer) — replaced its contents with the host's
   `/etc/ssl/certs/ca-certificates.crt` (kept a `.orig-2009` backup
   alongside it). This alone fixed the `license.unity3d.com` XML polling
   calls (which use libcurl/openssl directly).
3. The *rendered* activation page (a WebKit-hosted HTML sign-in form) still
   failed to load anything (`fonts.googleapis.com` cert error blocking the
   whole page, not just the stylesheet — this old WebKit build appears to
   treat any TLS error as fatal to the page, not just the failing
   subresource). Tried and failed to fix via: (a) editing the Wine-prefix's
   fake `C:\windows\system32\drivers\etc\hosts` (**no effect** — Wine's
   networking calls the real host resolver directly, doesn't consult its
   emulated hosts file for this), (b) `HOSTALIASES` env var (a legitimate
   no-root glibc per-process hostname-override mechanism — **also no
   effect**, so whatever does the DNS lookup here isn't going through
   glibc's resolver as expected either). What **did** work: routed all
   traffic through `mitmdump` (`mitmdump --listen-port 8888 --set
   tls_version_client_min=SSL3 --set tls_version_client_max=UNBOUNDED
   --set ciphers_client="DEFAULT:@SECLEVEL=0"`, i.e. relaxed to accept
   very old TLS/cipher requests from the ancient client), launched Wine
   with `http_proxy`/`https_proxy`/`HTTP_PROXY`/`HTTPS_PROXY` all set to
   `http://127.0.0.1:8888`, and appended mitmproxy's own generated CA cert
   (`~/.mitmproxy/mitmproxy-ca-cert.pem`) to the same `cacert.pem` from
   step 2. mitmproxy does the real modern-TLS handshake to the real
   servers on our behalf and re-presents everything to the old client
   under its own (now-trusted) cert — this got the real Unity ID sign-in
   form rendering correctly, with the user's provided email pre-fillable.
4. **Where it stopped**: this needs signing in with a real Unity account
   to get a free Personal license — the user offered to type a password
   into the (real, visible-to-them) Wine window themselves, but we never
   completed that login before pivoting to the source-code approach,
   which turned out to fully solve the format question anyway without
   needing this. If resumed, the mitmproxy+cacert.pem+env-var setup above
   should still work for getting back to a fillable login form; from
   there it's just completing the sign-in and running the batch-mode
   build command noted above.

## Session update (2026-08-25, later — real wiki data + card population + login flow)

Found a live community wiki with genuine datamined content for this exact
game: `eva-battlemission.gamerch.com`. This overturned the earlier "no
original content archived anywhere" conclusion for at least card stats —
Tier 1 data (real, directly usable) turned out to include the full card
roster with stats; scenario/puzzle-board layouts remain unarchived
(Tier 3, still needs synthesis or stubbing).

**Empirical test, run before investing in scraping**: temporarily served
all 61 master tables (`m_card`, `m_scenario`, etc. — enumerated via
`TypeToTableName`'s actual regex transform, `"m_" + snake_case(className)`,
not the raw class name as an earlier session wrongly assumed) as empty
arrays via `/master`. **Result: no crash.** The client tolerates a fully
empty master dataset and proceeds to `/login` regardless — master data is
consumed lazily per-screen, not validated as a precondition at load time.
This meant real data could be added incrementally, table by table, rather
than needing all 61 populated before testing anything.

**Card data scraped and wired in**:
- Used `curl` + a hand-written Python regex HTML table parser
  (`scratchpad/parse_cards.py`) against the wiki's per-rarity card-list
  pages (UR/SR/R/N), not `WebFetch`'s AI summarization — the summarizer
  silently dropped numeric stat columns on large (~60+ row) tables, only
  caught by manually diffing a sample of parsed rows against the live
  page.
- Encoded 261 real cards into `Master.Card::Parse()`'s exact 27-field
  schema (`cardId`, `rarityId`, `cost`, `cardName`, `elementType`,
  grow-type/stat quadruplets, `memberSkillId0-5`, `leaderSkillId0-5`,
  etc.) — `server/data_m_card.json`, wired into `server.js` via
  `MASTER_TABLE_DATA.m_card`.
- `/login`'s `userCardList` now grants 12 real starter cards (the
  wiki-listed rarityId≥3 cards, first 12) with stats derived from each
  card's own `defaultHp`/`defaultAttack`/etc. fields.

**`/login` field requirements (traced via IL)**: mirrors the `/setup/first`
pattern — most `login` sub-object fields are read via the lenient
reflection-based parser (missing keys silently default), **except
`tutorial`, which is read directly off the top-level response
(`ldarg.0`), not nested inside `login` (`ldloc.0`)** — the one
inconsistency in an otherwise-uniform response shape. Nesting it inside
`login` (the natural-looking first guess) still throws; costs a full
IL re-read to catch since every other field follows the opposite
pattern.

**WebView ToS crash fixed**: `/webview/tos` previously returned the
generic JSON stub, which Chrome's embedded WebView rendered as its
built-in JSON viewer — this reproducibly crashed the WebView renderer
process (`aw_browser_terminator.cc`), which Unity's own code then turned
into an `InvalidOperationException` from using the now-dead WebView.
Fixed by adding a `{html: "..."}` response-type branch to `server.js`'s
dispatcher and a `handleWebview()` returning real (placeholder-text)
HTML for `/webview/tos`, `/webview/help`, `/webview/news/list`. **Not
fully resolved**: the same `InvalidOperationException`/WebView-renderer
crash was still observed intermittently afterward, sometimes bouncing
the whole app to the Android home screen. Root cause not found — looks
like emulator-level WebView flakiness (the crash is timing-sensitive,
not reproduced by any specific content change), not a content-shape bug.
Treated as non-blocking: a relaunch (`adb shell monkey -p com.bushiroad.eva
-c android.intent.category.LAUNCHER 1`) always recovers, and once the
"agree to ToS" flag is set in `PlayerPrefs`, subsequent launches skip the
ToS WebView screen entirely and go straight to the main menu, so the
flaky screen is only ever hit once per fresh install.

**"Returning user" launch-flow quirk, not investigated**: a relaunch
*without* `pm clear` sometimes shows a distinct "データ更新中" (data
updating) screen that bounces back to the title screen rather than
proceeding, separate from the WebView crash above. Not chased — low
priority, since a `pm clear` + fresh-install cycle is reliable for
testing.

**Confirmed working end-to-end, verified on-device**: fresh install →
title screen ("TAP START") → real-HTML ToS screen → agree → main menu
(all six menu hexagons populated: マイページ/ミッション/カード/ショップ/
ガチャ/フレンド/ギルド) → カード → 一覧 (card list) → shows **"12枚所持"**
(12 owned), matching exactly the `USER_CARD_LIST` grant, each with a
5-star rarity-icon row rendering (card art itself absent — no image
assets, expected) and "Lv Max" labels. Confirms the full pipeline —
wiki scrape → `data_m_card.json` → `/master`'s `m_card` table →
`/login`'s `userCardList` → in-game UI — works correctly.

**Not yet scraped**: `SkillMember`/`SkillLeader` (skill data — confirmed
present on the same wiki, not yet pulled) and `Chapter` (22 real chapter
titles — also confirmed present, not yet pulled). Natural next Tier-1
targets if continuing the same approach. Puzzle-board/stage layout data
remains genuinely unarchived (Tier 3) — would need synthesis from
scratch, unlike cards/skills/chapters.

## Prior art search (2026-08-25)

Searched web (English and Japanese) for any existing community
reverse-engineering, save-data dumps, traffic captures, or private
server projects for this specific game
(`evangelion.donuts.ne.jp` / "ヱヴァンゲリヲン バトルミッション" /
"Evangelion Battle Mission"). Found nothing — no GitHub repos, no
forum threads, no private-server writeups specific to this title. It
appears to be undocumented territory; general "private server for
dead mobile game" discussion exists for other titles but not this one.
⇒ Proceeding from scratch based on static analysis of the APK, as
planned.

## Tooling notes

- `apktool`, `jadx`, `monodis`, `dotnet` are all available locally.
- `monodis --output=foo.il assembly.dll` is the fastest path to full
  IL of the Mono assemblies (no need for ilspycmd, which isn't
  installed). Grep the `.il` for field names / string literals /
  class names to navigate.
- AndroidManifest confirms `android:debuggable="false"`, but no
  network security config restricting cleartext traffic was found —
  consistent with the app using plain `http://` for its main API.
- Main activity: `com.unity3d.player.UnityPlayerActivity`.
