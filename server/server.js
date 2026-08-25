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
function handleMaster(req, fields) {
  return { masterData: [], ts: nowUnix() };
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
};

function handleUnknown(req, fields) {
  log(`!! UNKNOWN ENDPOINT ${req.method} ${parseUrl(req).pathname} — fields: ${JSON.stringify(fields)}`);
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
