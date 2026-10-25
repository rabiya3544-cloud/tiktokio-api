// api/original.js
//
// Proxy for tikwm's "Original Downloader".
// Tries to return the highest-tier unwatermarked HEVC source URL.
// Falls back to the standard HD stream if the original endpoint is gone.
//
// POST /api/original
//   { url: "https://vt.tiktok.com/ZSgQfXgeA" }
//
// Response on success:
//   {
//     ok: true,
//     quality: "original" | "best-available",
//     strategy: "original-json" | "html-form" | "standard-api-fallback",
//     url, size, sizeHuman, resolution, codec, bitrate, field,
//     downloadUrl, probeUrl,
//     note: null | "explains fallback",
//   }
//
// Query:
//   ?debug=1  → include attempts[] and upstream body preview.
//
// IMPORTANT: add this host to ALLOWED_HOSTS in api/tiktokio.js:
//   /(^|\.)tikwm\.com$/i

const ORIGINAL_JSON = "https://www.tikwm.com/api/original/";
const STANDARD_API  = "https://www.tikwm.com/api/";
const HTML_FORM     = "https://www.tikwm.com/originalDownloader.html";
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

  // Preflight — return 200, not 204, so some edge/CDN layers don't strip ACAO.
  if (req.method === "OPTIONS") return res.status(200).end();
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

  // ---- 1. Try the "original" JSON endpoint ----
  try {
    const r = await postForm(ORIGINAL_JSON, targetUrl);
    attempts.push({ strategy: "original-json", status: r.status, ok: r.ok });
    if (r.ok && r.json && r.json.code === 0 && r.json.data) {
      const parsed = extractFromJson(r.json.data);
      if (parsed) return finalize(parsed, "original", "original-json", debug, attempts, r);
    }
  } catch (e) {
    attempts.push({ strategy: "original-json", ok: false, error: String(e.message || e) });
  }

  // ---- 2. Try the HTML form ----
  try {
    const r = await postForm(HTML_FORM, targetUrl, { expect: "html" });
    attempts.push({ strategy: "html-form", status: r.status, ok: r.ok });
    if (r.ok && r.html) {
      const parsed = extractFromHtml(r.html);
      if (parsed) return finalize(parsed, "original", "html-form", debug, attempts, r);
    }
  } catch (e) {
    attempts.push({ strategy: "html-form", ok: false, error: String(e.message || e) });
  }

  // ---- 3. Fallback: standard API (always works, best-available HD) ----
  try {
    const r = await postForm(STANDARD_API, targetUrl, { hd: "1" });
    attempts.push({ strategy: "standard-api-fallback", status: r.status, ok: r.ok });
    if (r.ok && r.json && r.json.code === 0 && r.json.data) {
      const d = r.json.data;
      const bestUrl = d.hdplay || d.play;
      if (bestUrl) {
        const abs = bestUrl.startsWith("http")
          ? bestUrl
          : "https://www.tikwm.com" + bestUrl;
        return finalize(
          {
            url: abs,
            size: toNum(d.size),
            resolution: d.width && d.height ? `${d.width}x${d.height}` : null,
            codec: null,
            bitrate: null,
            field: d.hdplay ? "hdplay" : "play",
          },
          "best-available",
          "standard-api-fallback",
          debug, attempts, r
        );
      }
    }
  } catch (e) {
    attempts.push({ strategy: "standard-api-fallback", ok: false, error: String(e.message || e) });
  }

  return {
    ok: false,
    error: "Could not resolve any download URL",
    hint:
      "All three strategies failed. See attempts[] for per-strategy detail. " +
      "If you want true 'original' quality, open " +
      "https://www.tikwm.com/originalDownloader.html in a browser, " +
      "paste a link, inspect DevTools → Network → the POST that returns a .mp4, " +
      "then update ORIGINAL_JSON and HTML_FORM at the top of api/original.js.",
    attempts,
  };
}

/* ---------------- shared POST helper ---------------- */

async function postForm(endpoint, targetUrl, opts = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const form = new URLSearchParams();
    form.set("url", targetUrl);
    if (opts.hd) form.set("hd", opts.hd);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type":    "application/x-www-form-urlencoded",
        "User-Agent":      BROWSER_UA,
        "Accept":          opts.expect === "html"
          ? "text/html,application/xhtml+xml,*/*;q=0.8"
          : "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer":         "https://www.tikwm.com/",
        "Origin":          "https://www.tikwm.com",
      },
      body: form.toString(),
      signal: controller.signal,
      redirect: "follow",
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    return { ok: res.ok, status: res.status, text, json, html: text };
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ---------------- finalize ---------------- */

function finalize(parsed, quality, strategy, debug, attempts, upstream) {
  const out = {
    ok: true,
    quality,                          // "original" | "best-available"
    strategy,
    url: parsed.url,
    size: parsed.size,
    sizeHuman: parsed.sizeHuman || (parsed.size ? humanSize(parsed.size) : null),
    resolution: parsed.resolution || null,
    codec: parsed.codec || null,
    bitrate: parsed.bitrate || null,
    field: parsed.field,
    downloadUrl: "/api/tiktokio?action=download&url=" + encodeURIComponent(parsed.url),
    probeUrl:    "/api/tiktokio?action=probe&url="    + encodeURIComponent(parsed.url),
    note: quality === "best-available"
      ? "tikwm's original endpoint was unreachable — this is the best HD stream from the standard API."
      : null,
  };
  if (debug) {
    out.upstream = {
      status: upstream && upstream.status,
      bodyPreview: upstream && upstream.text ? upstream.text.slice(0, 300) : null,
    };
    out.attempts = attempts;
  }
  return out;
}

/* ---------------- extractors ---------------- */

function extractFromJson(data) {
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
    url: hit.value.startsWith("http")
      ? hit.value
      : "https://www.tikwm.com" + hit.value,
    size: toNum(data.size ?? data.filesize ?? data.file_size),
    resolution,
    codec: normalizeCodec(data.codec || data.codec_type || data.video_codec),
    bitrate: toNum(data.bitrate ?? data.bit_rate ?? data.br),
    field: hit.key,
  };
}

function extractFromHtml(html) {
  const m = html.match(
    /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|mov|m4v)(?:\?[^\s"'<>\\]*)?/i
  );
  if (!m) return null;

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
