// api/original.js
//
// Proxy for tikwm's "Original Downloader".
// Attempts to return the highest-tier unwatermarked HEVC source URL
// rather than the standard compressed 1080p stream.
//
// POST /api/original
//   { url: "https://vt.tiktok.com/ZSgQfXgeA" }
//
// Response:
//   {
//     ok: true,
//     strategy: "json" | "html",
//     url: "https://...",                 // direct original-file URL
//     size: 11534336,
//     sizeHuman: "11 MB",
//     resolution: "1080x1920",
//     codec: "hevc",
//     bitrate: 6865000,
//     downloadUrl: "/api/tiktokio?action=download&url=..."
//   }
//
// Query:
//   ?debug=1  → include raw upstream payloads for troubleshooting.
//
// Add this host to ALLOWED_HOSTS in api/tiktokio.js if not already there:
//   /(^|\.)tikwm\.com$/i

const JSON_ENDPOINT = "https://www.tikwm.com/api/original/";
const HTML_ENDPOINT = "https://www.tikwm.com/originalDownloader.html";
const TIMEOUT_MS    = 15000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36";

/* ---------------- entry ---------------- */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const target = body.url || body.q || body.link;
  if (!target) return res.status(400).json({ error: "Missing url" });

  const debug = req.query && req.query.debug === "1";

  try {
    const result = await resolveOriginal(target, debug);
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    console.error("[original] unhandled:", err);
    return res.status(502).json({
      ok: false,
      error: err.name === "AbortError" ? "Timeout" : "Resolver failed",
      message: String(err.message || err),
    });
  }
}

/* ---------------- orchestration ---------------- */

async function resolveOriginal(targetUrl, debug) {
  const attempts = [];

  // Strategy 1 — dedicated JSON endpoint (fast, structured).
  try {
    const r = await tryJsonApi(targetUrl);
    attempts.push({ strategy: "json", status: r.status, ok: r.ok });
    if (r.ok && r.data) {
      const parsed = extractFromJson(r.data);
      if (parsed) return finalize(parsed, "json", debug, attempts, r);
    }
    if (debug) attempts[attempts.length - 1].raw = r.raw;
  } catch (e) {
    attempts.push({ strategy: "json", ok: false, error: String(e.message || e) });
  }

  // Strategy 2 — submit to the HTML form and scrape the download link.
  try {
    const r = await tryHtmlForm(targetUrl);
    attempts.push({ strategy: "html", status: r.status, ok: r.ok });
    if (r.ok && r.html) {
      const parsed = extractFromHtml(r.html);
      if (parsed) return finalize(parsed, "html", debug, attempts, r);
      if (debug) attempts[attempts.length - 1].preview = r.html.slice(0, 400);
    }
  } catch (e) {
    attempts.push({ strategy: "html", ok: false, error: String(e.message || e) });
  }

  return {
    ok: false,
    error: "Could not extract an original-file URL",
    hint:
      "tikwm's internal endpoint likely changed. Open " +
      "https://www.tikwm.com/originalDownloader.html in your browser, " +
      "paste a link, open DevTools → Network, and inspect the actual " +
      "POST request. Then update JSON_ENDPOINT or HTML_ENDPOINT at the " +
      "top of api/original.js to match.",
    attempts,
  };
}

function finalize(parsed, strategy, debug, attempts, upstream) {
  const out = {
    ok: true,
    strategy,
    url: parsed.url,
    size: parsed.size,
    sizeHuman: parsed.sizeHuman || (parsed.size ? humanSize(parsed.size) : null),
    resolution: parsed.resolution || null,
    codec: parsed.codec || null,
    bitrate: parsed.bitrate || null,
    field: parsed.field,
    downloadUrl:
      "/api/tiktokio?action=download&url=" + encodeURIComponent(parsed.url),
    probeUrl:
      "/api/tiktokio?action=probe&url=" + encodeURIComponent(parsed.url),
  };
  if (debug) {
    out.upstream = { status: upstream && upstream.status };
    out.attempts = attempts;
    if (upstream && upstream.raw) out.upstream.raw = upstream.raw;
    if (upstream && upstream.html) out.upstream.preview = upstream.html.slice(0, 600);
  }
  return out;
}

/* ---------------- strategy 1: JSON API ---------------- */

async function tryJsonApi(targetUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const form = new URLSearchParams();
    form.set("url", targetUrl);

    const res = await fetch(JSON_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "User-Agent":    BROWSER_UA,
        "Accept":        "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer":       "https://www.tikwm.com/",
        "Origin":        "https://www.tikwm.com",
      },
      body: form.toString(),
      signal: controller.signal,
    });

    const text = await res.text();
    console.log("[original][json] status=%d body=%s",
      res.status, text.slice(0, 300).replace(/\s+/g, " "));

    let json = null;
    try { json = JSON.parse(text); } catch {}

    return {
      ok: res.ok && json && json.code === 0 && !!json.data,
      status: res.status,
      data: json && json.data,
      raw: json || text.slice(0, 500),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ---------------- strategy 2: HTML form ---------------- */

async function tryHtmlForm(targetUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const form = new URLSearchParams();
    form.set("url", targetUrl);

    const res = await fetch(HTML_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "User-Agent":    BROWSER_UA,
        "Accept":        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer":       "https://www.tikwm.com/originalDownloader.html",
        "Origin":        "https://www.tikwm.com",
      },
      body: form.toString(),
      signal: controller.signal,
      redirect: "follow",
    });

    const html = await res.text();
    console.log("[original][html] status=%d len=%d preview=%s",
      res.status, html.length, html.slice(0, 200).replace(/\s+/g, " "));

    return { ok: res.ok, status: res.status, html };
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ---------------- extractors ---------------- */

function extractFromJson(data) {
  // Try common fields an "original" endpoint might return.
  const candidates = [
    { key: "original_url", value: data.original_url || data.originalUrl },
    { key: "url",          value: data.url },
    { key: "play",         value: data.play },
    { key: "hdplay",       value: data.hdplay },
  ];
  const hit = candidates.find(c => c.value && /^https?:\/\//.test(c.value));
  if (!hit) return null;

  const w = Number(data.width);
  const h = Number(data.height);
  const resolution =
    w && h ? `${w}x${h}` :
    (typeof data.resolution === "string" ? data.resolution : null);

  return {
    url: hit.value,
    size: toNum(data.size ?? data.filesize ?? data.file_size),
    resolution,
    codec: normalizeCodec(data.codec || data.codec_type || data.video_codec),
    bitrate: toNum(data.bitrate ?? data.bit_rate ?? data.br),
    field: hit.key,
  };
}

function extractFromHtml(html) {
  // Find the first video-ish URL in the returned HTML.
  const m = html.match(
    /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|mov|m4v)(?:\?[^\s"'<>\\]*)?/i
  );
  if (!m) return null;

  // Try to scrape a nearby "size" string, e.g. "11.0MB".
  const sizeMatch = html.match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\b/i);

  return {
    url: m[0].replace(/&amp;/g, "&"),
    size: null,
    sizeHuman: sizeMatch ? sizeMatch[0] : null,
    resolution: null,
    codec: "hevc (assumed)",
    bitrate: null,
    field: "html-scrape",
  };
}

/* ---------------- helpers ---------------- */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeCodec(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.includes("265") || s.includes("hevc")) return "hevc";
  if (s.includes("264") || s.includes("avc"))  return "h264";
  return s;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const d = (i === 0 || n >= 10) ? 0 : 1;
  return n.toFixed(d) + " " + units[i];
}
