// Fake local replacement server for Evangelion Battle Mission (com.bushiroad.eva).
//
// The real server (http://evangelion.donuts.ne.jp/) has been dead since
// the game's 2016-01-21 shutdown. This server answers the same HTTP API
// (see /home/xh64bit/Projects/EvaBatMission/info.md for the reverse-engineered
// protocol) well enough to get the client past the boot-time connection
// error and, incrementally, further into the app.
//
// Intended to be reached via the Android emulator's `-http-proxy` flag,
// which transparently redirects ALL guest TCP connections through this
// process without needing root or a hosts-file edit. Because of that, this
// server must behave like an HTTP proxy target: request lines may arrive
// as either an absolute-URI ("POST http://evangelion.donuts.ne.jp/inspection
// HTTP/1.1") or origin-form with just a Host header — both are handled below.
//
// Every request is logged to logs/requests.log (and echoed to stdout) so
// unseen endpoints can be discovered and added as we go.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const LOG_FILE = path.join(__dirname, 'logs', 'requests.log');

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(LOG_FILE, stamped + '\n');
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

// Minimal multipart/form-data parser (text fields only — WWWForm.AddField
// never sends file parts for this game's API calls).
function parseMultipart(body, boundary) {
  const fields = {};
  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '--') continue;
    const headerEnd = trimmed.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = trimmed.slice(0, headerEnd);
    const value = trimmed.slice(headerEnd + 4);
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (nameMatch) {
      fields[nameMatch[1]] = value.replace(/\r\n$/, '');
    }
  }
  return fields;
}

function parseUrl(req) {
  // req.url may be an absolute-URI (proxy request-form) or a plain path.
  try {
    return new URL(req.url, 'http://placeholder.invalid');
  } catch {
    return new URL('http://placeholder.invalid/');
  }
}

// The patched client's BASE_URL has a padding path segment
// (see server/README.md) so requests look like
// "/eeeeeeeee/inspection" instead of "/inspection". Match routes by
// suffix instead of exact pathname so the padding is transparently
// ignored, and so any accidental extra leading slashes don't matter.
function matchRoute(pathname) {
  const routeKeys = Object.keys(ROUTES).sort((a, b) => b.length - a.length);
  for (const key of routeKeys) {
    if (pathname.endsWith(key)) return ROUTES[key];
  }
  return null;
}

// ---- Response builders for known endpoints ------------------------------
// See info.md for the field-by-field breakdown of why these shapes were
// chosen (SetURL / ParseError / IsValidResponse in Network.EvaApiClient
// and Network.EvaRequestHandler).

function baseUrlForSelf(req) {
  // Whatever host:port the client reached us on — echoed back so the
  // client's BASE_URL/ASSET_BUNDLE_URL keep pointing at us.
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  return `http://${host}/`;
}

function handleInspection(req, fields) {
  const base = baseUrlForSelf(req);
  return {
    inspection: {
      url: base,
      assetBundleUrl: base + 'assets/',
      utageResourceUrl: base + 'utage/',
      review: false,
    },
    ts: nowUnix(),
  };
}

// Model.Player.SetUser(tpid, eud, ivs) just stores `eud`/`ivs` as
// PlayerPrefs strings, but something downstream (EvaApiClient's
// (userId, uuid, iv) constructor, per earlier session's crypto-material
// notes) unconditionally decrypts them via
// TripleDES.Create() with Mode=CBC, Padding=PKCS7, Key=ASCII bytes of
// the literal string "ce3eb25c02e3f12c3ef568a0" (24 bytes, confirmed via
// EvaApiClient.Decrypt's IL), and both `eud`/`ivs` are hex strings (not
// base64 — confirmed via StringToByteArray's IL, a manual hex decoder).
// A null/empty ivs decodes to a 0-byte IV, which throws
// "IV length is different than block size" before we ever get anywhere
// near the game. Since signature/response validation is already known
// to be ignored client-side (see info.md), the plaintext content here
// is irrelevant — we just need *something* that decrypts cleanly, so a
// fixed IV + a TripleDES-CBC-PKCS7 encryption of an arbitrary string,
// precomputed with Node's crypto (`des-ede3-cbc`, verified to
// round-trip) and hardcoded here.
const CRYPTO_IVS = '0011223344556677';
const CRYPTO_EUD = '31037c96347326ca75fe8a4a5c7fb3d5'; // TripleDES-CBC-PKCS7("localuser") with the key/IV above

function handleSetupFirst(req, fields) {
  // First-launch bootstrap. TitleController.OnFirst() does
  // `response["firstSetup"]` and passes it straight into
  // FirstSetUpData.Parse() with no null-check — a bare `{"ts":...}`
  // reply (this handler's original shape) makes that a NullReference-
  // Exception. FirstSetUpData's fields (tpid/eud/ivs) are read via a
  // reflection loop that skips any key not present in the dict.
  return {
    firstSetup: {
      tpid: Date.now(),
      eud: CRYPTO_EUD,
      ivs: CRYPTO_IVS,
    },
    ts: nowUnix(),
  };
}

function handleSetupComp(req, fields) {
  // Registers/confirms local user id (tpid -> pid). Echo tpid back as pid
  // as a first guess.
  const pid = fields.tpid || '1';
  return {
    pid: Number(pid),
    ts: nowUnix(),
  };
}

function handleBushimoInheritingComp(req, fields) {
  return {
    ts: nowUnix(),
  };
}

// Master.MasterInitializer.ParseMaster() does
// `((IList)response["masterData"]).Cast<IDictionary>()` with no
// null-check — a missing "masterData" key throws ArgumentNullException.
// Each entry would normally be {"tableName": ..., "tableValues": [...]}
// (real character/puzzle/scenario master data) but none of that content
// was ever archived anywhere (see info.md) — an empty list at least lets
// the client proceed past this call without crashing.
// EMPIRICAL TEST (2026-08-25, see info.md): Master.MasterInitializer.Load()
// doesn't iterate whatever `masterData` we send — it walks a HARDCODED,
// compiled-in array of 61 System.Type entries (MasterInitializer.assetNames,
// confirmed via IL: a Type[] literal built from 61 `ldtoken Master.<Name>`
// instructions) and does a RAW dictionary indexer (`data[tableName]`, not
// TryGetValue) for every single one — so any missing table throws
// KeyNotFoundException immediately. Table names are NOT the raw class name:
// MasterInitializer.TypeToTableName() does
// `"m" + Regex.Replace(type.Name, "([A-Z])", "_$0")` then `.ToLower()` —
// e.g. "SkillMember" -> "m_skill_member", "GuildVersusEvent" ->
// "m_guild_versus_event". This list is that exact transform applied to all
// 61 `ldtoken Master.*` names found in Assembly-CSharp.dll's IL (grep
// `ldtoken Master\.` to regenerate/verify against a fresh disassembly).
//
// Sending all 61 with empty tableValues is a scoping experiment: it tells
// us how far an entirely-real-cast, entirely-empty-content client gets
// before the NEXT missing-data crash, which bounds how much of the 61
// tables need real (wiki-sourced) vs. synthesized (invented) vs. genuinely
// empty/stubbable data to reach a playable state. See info.md for results
// once run.
const MASTER_TABLE_NAMES = [
  'm_abnormal_condition', 'm_banner', 'm_bossrush_boss', 'm_bossrush_event',
  'm_bossrush_point_daily', 'm_bossrush_point_daily_reward', 'm_bossrush_point_reward',
  'm_bossrush_point_special_card', 'm_card', 'm_card_bonus', 'm_card_legend',
  'm_card_level', 'm_card_over_limit', 'm_chapter', 'm_chapter_card', 'm_enemy',
  'm_enemy_abnormal_condition', 'm_enemy_party', 'm_gacha', 'm_gacha_group',
  'm_gacha_step', 'm_guild_image', 'm_guild_level', 'm_guild_versus_event',
  'm_guild_versus_model', 'm_guild_versus_point_daily', 'm_guild_versus_point_daily_reward',
  'm_guild_versus_point_daily_user_reward', 'm_guild_versus_point_reward',
  'm_guild_versus_point_user_reward', 'm_guild_versus_rank', 'm_guild_versus_special_card',
  'm_invite_contents', 'm_login_bonus', 'm_login_bonus_detail', 'm_mission',
  'm_mission_bonus', 'm_mission_clear_rank', 'm_mission_clear_reward',
  'm_mission_point_clear', 'm_mission_point_enemy', 'm_mission_point_reward',
  'm_mission_point_special_card', 'm_raid_boss_special_card', 'm_raid_encount',
  'm_raid_event', 'm_scenario', 'm_shop_stone', 'm_skill_leader', 'm_skill_member',
  'm_special_contents', 'm_team_battle', 'm_team_battle_point_reward', 'm_team_event',
  'm_team_group', 'm_team_point_special_card', 'm_tips', 'm_user_level', 'm_wave',
  'm_wave_block', 'm_wave_message',
];

// Real card roster, scraped from the community wiki (eva-battlemission.
// gamerch.com — a dedicated wiki for this exact game, still live) and
// encoded to match Master.Card::Parse()'s exact field list — confirmed via
// IL that Parse() is NOT the lenient JsonData<T>-reflection pattern used
// elsewhere; it's hand-generated code doing an unconditional
// get_Item()+unbox.any per field, so every one of these 27 fields must be
// present with the right type (Int64 for numerics — no decimal points) or
// it throws immediately. cardId/rarityId/cost/cardName/elementType/stats
// are real data (name, rarity, attribute, base+max HP/ATK/DEF/Recovery);
// description/growType/basicExp/useType/skill-ids/salePrice/characterId
// are synthesized placeholders (blank/constant/zero) since the wiki
// doesn't document them and the client doesn't validate them — see
// info.md for the full scraping/encoding writeup.
const CARD_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data_m_card.json'), 'utf8'));

// SkillMember/SkillLeader/Chapter (unlike Card) extend JsonDataCollection<T>
// with plain [JsonField]-attributed properties — the LENIENT
// reflection-based parser, confirmed via IL (no hand-generated Parse()).
// Missing fields default safely, so only the wiki-documented fields
// (name/description, or chapterId/chapterName) are populated; numeric
// effect/target/position fields the wiki doesn't break out in structured
// form are left at 0 — safe for display purposes, just not wired to real
// battle-effect logic. IDs are our own sequential numbering (1..N), since
// the wiki doesn't expose the real internal IDs and nothing besides our
// own data (m_card's memberSkillId0-5/leaderSkillId0-5, currently all 0)
// references them.
const SKILL_MEMBER_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data_m_skill_member.json'), 'utf8'));
const SKILL_LEADER_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data_m_skill_leader.json'), 'utf8'));
const CHAPTER_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data_m_chapter.json'), 'utf8'));

// Master.UserLevel.GetLevelFromAccumulateExp(exp) does
// `collection.Values.Last(kv => kv.Value.accumulateExp <= exp)` — with an
// empty table this throws InvalidOperationException (Linq .Last() with no
// match) for EVERY player, including a brand-new one at exp=0, since
// there's no entry at all to match. Traced from a crash inside
// HeaderController.Awake() on every menu load. No real level-curve data
// exists on the wiki (this is an internal game-balance table, not
// character/story content), so this is a synthesized placeholder curve —
// linearly increasing necessaryExp, level 1 at accumulateExp=0 so a
// fresh account resolves immediately. Good enough to stop the crash and
// show a real (if arbitrary) number in the header; not meant to be a
// faithful reconstruction of the original curve.
const USER_LEVEL_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data_m_user_level.json'), 'utf8'));

const MASTER_TABLE_DATA = {
  m_card: CARD_DATA,
  m_skill_member: SKILL_MEMBER_DATA,
  m_skill_leader: SKILL_LEADER_DATA,
  m_chapter: CHAPTER_DATA,
  m_user_level: USER_LEVEL_DATA,
};

function handleMaster(req, fields) {
  return {
    masterData: MASTER_TABLE_NAMES.map((tableName) => ({
      tableName,
      tableValues: MASTER_TABLE_DATA[tableName] || [],
    })),
    ts: nowUnix(),
  };
}

// PlayerStatus.Login()/TitleController.OnLogin() (see info.md) require a
// nested response["login"] dict with several keys accessed via raw
// (non-null-checked) IDictionary indexers:
//   userCardList (IList, -> Card.Parse per entry — empty list skips this)
//   userDeckList (IList, -> Response.DeckList.Parse — empty list is fine)
//   userStatus (IDictionary, -> Response.UserStatus.Parse — a lenient
//     JsonData<T>-style reflection parser like FirstSetUpData, so {} is
//     safe; get_maxCardNum()/get_userName() read after Parse() just get
//     type defaults (0 / null))
//   selectMission (IDictionary, -> PlayerStatus.LoadMission, which itself
//     requires selectMission["chapterList"] as an IList -> Response.
//     Chapter.LoadList — empty list, untested whether LoadList(null)
//     would've been safe, empty array is the low-risk choice)
//   maxCardExtension, unboxed as Int64 — must be a JSON integer (no
//     decimal point) or the unbox.any throws an InvalidCastException
//   tosVersion (string, float32.TryParse'd — anything parseable is fine)
// `tutorial` is the one exception — read via `ldarg.0` (the TOP-LEVEL
// response), not `ldloc.0` (the "login" sub-dict) like everything else in
// this method — confirmed by re-reading the IL closely after the first
// attempt (nesting it under "login") still NRE'd. -> tutorial["tutorialId"],
// also unboxed as Int64.
// PlayerStatus's per-entry `userCardList` parse target is a DIFFERENT
// `Card` class from `Master.Card` — an owned-card instance
// (userCardId/cardId/level/rank/hp/atk/def/recovery/exp/...) that extends
// `JsonData<Card>`, the same LENIENT reflection-based parser as
// FirstSetUpData/UserStatus (confirmed via IL — unlike Master.Card's
// strict hand-generated Parse()). So unlike m_card, we don't need every
// field here — just enough to reference a real card from CARD_DATA by
// cardId. Grant a small real starter roster so there's something to
// actually see/use in the Card/Deck screens.
const STARTER_CARD_IDS = CARD_DATA.filter((c) => c.rarityId >= 3).slice(0, 12).map((c) => c.cardId);
const USER_CARD_LIST = STARTER_CARD_IDS.map((cardId, i) => {
  const master = CARD_DATA.find((c) => c.cardId === cardId);
  return {
    userCardId: 1000 + i,
    cardId,
    level: 1,
    maxLevel: 1,
    rank: 0,
    hp: master.defaultHp,
    atk: master.defaultAttack,
    def: master.defaultDefence,
    recovery: master.defaultRecovery,
    exp: 0,
    createTime: nowUnix(),
    leaderSkillId: 0,
    memberSkillId: 0,
    deleted: false,
  };
});

// GET /webview/tos (and friends — INQUIRY_URL/HELP_URL/INFO_URL constants
// from EvaApiClient) is loaded directly into an embedded Chrome WebView,
// not parsed by Unity/C# at all. Our earlier generic JSON stub
// (`{"ts":...}`) got rendered by Chrome as raw text/JSON-viewer content,
// which reproducibly crashed the WebView's renderer process
// (`chromium: aw_browser_terminator.cc: Renderer process crash detected`)
// on this specific Android/WebView build — not a Unity or protocol bug,
// but real HTML avoids it entirely.
function handleWebview(req, fields) {
  return {
    html: '<!doctype html><html><body><p>(placeholder — local server)</p></body></html>',
  };
}

// PlayerStatus.LoadMission's selectMission.chapterList feeds
// Response.Chapter::LoadList, which per-entry calls ParseList (IL traced
// above CHAPTER_DATA) — a LENIENT JsonData<T> parser like userCardList,
// EXCEPT it does one unconditional get_Item("missionList") cast to IList,
// so that key must be present (empty array is fine, no missions defined
// yet). Response.Chapter::set_master resolves Master.Chapter by chapterId
// via JsonDataCollection.Find — since /master's m_chapter table (below)
// uses the same chapterId numbering, each of these correctly links up to
// the real chapter name/title client-side.
const CHAPTER_LIST = CHAPTER_DATA.map((c) => ({
  chapterId: c.chapterId,
  startTime: 0,
  endTime: 0,
  totalMissionPoint: 0,
  totalMissionPointDaily: 0,
  missionList: [],
}));

// PlayerStatus.Login() builds PlayerStatus.Decks from
// response["login"]["userDeckList"] via Response.DeckList::Parse — traced
// via IL: if that list is EMPTY, DeckList.Parse synthesizes 5 blank Deck
// objects with a completely empty `cards` dictionary (not even a leader
// slot). That's exactly what an empty [] produced. The crash this causes
// isn't in DeckList itself — it's the very first line of
// FormationController.ExecuteSort() (entered when opening カード→編成),
// which does an UNCONDITIONAL `currentDeck[1]` (the leader-slot indexer,
// Response.Deck::get_Item — a raw Dictionary<int32,Card> lookup, not
// TryGetValue) before any of the rest of the method's more careful
// Position(int32)-based (safe/nullable) lookups. A blank deck has no
// entry at key 1 → KeyNotFoundException. Fixed by sending 5 real decks
// (matching the UI's 5 formation-slot tabs, "Deck1".."Deck5") each with
// a populated leader (position 1) and 5 members (positions 2-6), cycling
// through our 12 real granted starter cards. Response.Deck::Parse reads
// each deckCardList entry's "position"/"userCardId" as STRINGS
// (int64.Parse(x.ToString())), not raw JSON numbers — matched here by
// emitting them as JS numbers, which JSON.stringify renders as bare
// digits that ToString() on the boxed value still parses fine.
const USER_DECK_LIST = Array.from({ length: 5 }, (_, deckIdx) => ({
  deckNo: deckIdx + 1,
  deckCost: 0,
  deckCardList: Array.from({ length: 6 }, (_, slot) => ({
    position: slot + 1,
    userCardId: USER_CARD_LIST[(deckIdx * 6 + slot) % USER_CARD_LIST.length].userCardId,
  })),
}));

function handleLogin(req, fields) {
  return {
    login: {
      userCardList: USER_CARD_LIST,
      userDeckList: USER_DECK_LIST,
      userStatus: {},
      selectMission: { chapterList: CHAPTER_LIST },
      maxCardExtension: 0,
      tosVersion: '1.0',
    },
    tutorial: { tutorialId: 0 },
    ts: nowUnix(),
  };
}

// MenuController's header, loaded right after login. Response.MyPage.Parse
// (traced via IL) does response["myPage"] (unconditional get_Item — must
// be present) then, unless that dict Contains("closed") (a
// game-maintenance/account-closed flag we never want to send), reads FIVE
// more unconditional IList/IDictionary get_Item calls with no null-check:
// loginBonus, information, banner, startDashLogin (all IList — empty
// arrays are fine, their per-entry Parse() calls are simply never
// invoked), and eventBanner (IDictionary — Response.EventBanner is a
// plain lenient JsonData<T>, {} is fine). Separately,
// Model.StaminaModel.SetBonusTime does its own two unconditional
// get_Item calls (bonusEndTime, endTime) on
// response["myPage"]["infinityStaminaBonus"], so that nested object needs
// both keys present even though it's otherwise unrelated to the MyPage
// class itself. "raid"/"guild" are the only two truly optional keys
// (real .Contains() checks) — omitted here.
function handleMyPage(req, fields) {
  return {
    myPage: {
      loginBonus: [],
      information: [],
      banner: [],
      startDashLogin: [],
      eventBanner: {},
      infinityStaminaBonus: { bonusEndTime: 0, endTime: 0 },
    },
    ts: nowUnix(),
  };
}

// GachaController.GetGachaInfo() hits "gacha/list" (not just "gacha"),
// and OnSuccess does an unconditional response["gachaMain"] get_Item then
// Response.Gacha::Parse on it, which itself does one unconditional
// jsonObj["gachaGroup"] get_Item cast to IList — empty array is safe
// (Response.GachaGroup::Parse is only invoked per-entry, never on an
// empty list). No real gacha/banner data exists on the wiki (it's
// time-limited promotional content, not preserved), so this is
// intentionally an empty roster rather than synthesized — same
// reasoning as the empty story/stage content, just for a smaller table.
function handleGachaList(req, fields) {
  return {
    gachaMain: { gachaGroup: [] },
    ts: nowUnix(),
  };
}

// The asset-bundle "resource map" the client downloads right after
// `inspection` succeeds. Must be a real Unity AssetBundle binary (not
// JSON) containing one TextAsset named "BundleData" whose text is a JSON
// array — see server/build_bmdata.py and info.md for how/why this was
// hand-built. `[]` = zero downloadable sub-bundles, which the client
// accepts without crashing (AssetBundleResource.LoadResourceMap).
const BM_DATA_PATH = path.join(__dirname, 'BMData.bundle');

// DownloadManager.Start() (see info.md) fetches this right after BMData
// loads successfully, via a plain `new WWW(url)` — NOT through our
// JSON-response machinery. If the request "succeeds" (any HTTP 200,
// regardless of body), the response TEXT is fed through
// BMUtility.InterpretPath() and `new Uri(...)`, and REPLACES
// DownloadManager.downloadRootUrl (previously set from the `inspection`
// response's assetBundleUrl via SetManualUrl). So this must be plain text
// containing a valid absolute URL, not JSON — anything else would either
// throw a UriFormatException or silently redirect future downloads
// somewhere broken. Just echo back our own assets URL (a no-op redirect).
function handleBMRedirect(req, fields) {
  return { text: baseUrlForSelf(req) + 'assets/' };
}

function handleBMData(req, fields) {
  // Diagnostic: artificial delay to rule out a race where the client's
  // background WWW decompression thread hasn't caught up when the
  // coroutine resumes, given how close-to-instant a localhost response is
  // compared to the original real (much slower) server.
  return { binary: fs.readFileSync(BM_DATA_PATH), delayMs: 800 };
}

// BundleData (inside BMData) now lists one dummy bundle entry so that
// AssetBundleResource.assetBundles is non-empty — DownloadManager.
// ProgressOfBundles() explicitly returns 0.0 (never 1.0) when its total
// weight is zero, so an empty bundle list means TitleController's
// "wait until progress == 1.0" loop spins forever with no further
// network activity and no crash (see info.md). DownloadManager fetches
// this by appending ".assetBundle" to the name and running it through
// formatUrl(), landing here.
const DUMMY_BUNDLE_PATH = path.join(__dirname, 'dummy.assetBundle');

function handleDummyBundle(req, fields) {
  return { binary: fs.readFileSync(DUMMY_BUNDLE_PATH) };
}

const ROUTES = {
  '/inspection': handleInspection,
  '/setup/first': handleSetupFirst,
  '/setup/comp': handleSetupComp,
  '/bushimo/inheriting/comp': handleBushimoInheritingComp,
  '/BMData': handleBMData,
  '/BMRedirect.txt': handleBMRedirect,
  '/dummy.assetBundle': handleDummyBundle,
  '/master': handleMaster,
  '/webview/tos': handleWebview,
  '/webview/help': handleWebview,
  '/webview/news/list': handleWebview,
  '/login': handleLogin,
  '/mypage': handleMyPage,
  '/gacha/list': handleGachaList,
};

// Direct (non-AssetBundle, non-master-data) image fetches — e.g.
// TextureHolder.LoadCharacterImage()'s "resource/images/bigcard/
// {id}_bigcard.png" — are plain `new WWW(url)` GETs the client expects
// to resolve to real image bytes. Traced via IL (MenuController's
// LoadCharacterTexture iterator, the main-page background image): it
// only writes into the UITexture if `www.error` is EMPTY — our old
// blanket 200-JSON "success" stub satisfied that, so the client cached
// and applied `www.texture` on a response body that isn't a decodable
// image, which is Unity's own built-in "broken/missing texture"
// placeholder (rendered as a large red "?" over the main-page
// background, since this UITexture is scaled to fill much of the
// screen). A real HTTP error response makes the client skip the
// texture-set step entirely instead, leaving the UI element untouched —
// the honest option, since no original character art was ever archived
// and none is synthesized here.
const IMAGE_PATH_RE = /\.(png|jpe?g|gif)$/i;

function handleUnknown(req, fields) {
  const pathname = parseUrl(req).pathname;
  log(`!! UNKNOWN ENDPOINT ${req.method} ${pathname} — fields: ${JSON.stringify(fields)}`);
  if (IMAGE_PATH_RE.test(pathname)) {
    return { notFound: true };
  }
  // Best-effort generic "success, nothing to see here" reply: no
  // normalError/error keys means the client treats it as success.
  return { ts: nowUnix() };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const contentType = req.headers['content-type'] || '';
    const url = parseUrl(req);
    let fields = {};

    // Query-string params (this is how EvaApiClient actually sends them,
    // per observed traffic — not as a WWWForm body despite what the
    // decompiled IL for the generic Connect() iterator suggested).
    for (const [k, v] of url.searchParams) fields[k] = v;

    // Also merge in body params, in case some endpoint does POST a body.
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (boundaryMatch) {
      Object.assign(fields, parseMultipart(body, boundaryMatch[1] || boundaryMatch[2]));
    } else if (contentType.includes('application/x-www-form-urlencoded') && body) {
      for (const [k, v] of new URLSearchParams(body)) fields[k] = v;
    }

    const pathname = url.pathname;
    log(`${req.method} ${req.url} (pathname=${pathname}) headers=${JSON.stringify(req.headers)} fields=${JSON.stringify(fields)}`);

    const handler = matchRoute(pathname) || handleUnknown;
    const responseObj = handler(req, fields);

    if (responseObj && typeof responseObj.html === 'string') {
      const buf = Buffer.from(responseObj.html, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': buf.length,
      });
      res.end(buf);
      log(`-> 200 <html> ${buf.length} bytes`);
      return;
    }

    if (responseObj && typeof responseObj.text === 'string') {
      const buf = Buffer.from(responseObj.text, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': buf.length,
      });
      res.end(buf);
      log(`-> 200 <text> ${responseObj.text}`);
      return;
    }

    if (responseObj && responseObj.notFound) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      log(`-> 404`);
      return;
    }

    if (responseObj && responseObj.binary) {
      const buf = responseObj.binary;
      const send = () => {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buf.length,
        });
        res.end(buf);
        log(`-> 200 <binary ${buf.length} bytes>`);
      };
      if (responseObj.delayMs) setTimeout(send, responseObj.delayMs);
      else send();
      return;
    }

    const payload = JSON.stringify(responseObj);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
    log(`-> 200 ${payload}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Fake EVA BM server listening on 0.0.0.0:${PORT}`);
});
