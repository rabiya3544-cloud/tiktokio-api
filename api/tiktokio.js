// api/tiktokio.js
//
// Unified TikTok media proxy.
// Merges the former endpoints:
//   POST /api/v1/tk/html   → POST /api/tiktokio?action=html
//   POST /api/v1/tk/size   → POST /api/tiktokio?action=size
//   GET  /api/v1/tk/probe  → GET  /api/tiktokio?action=probe&url=...
//                                 GET  /api/tiktokio?action=download&url=...
//
// Action can also be supplied in the JSON body as `{ action: "..." }`.
// If omitted, it is inferred: `{url}` → probe, `{urls}` → size.

import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

/* ---------------- config ---------------- */

const TKIO_UPSTREAM = "https://tiktokio.com/api/v1/tk/html";

const ALLOWED_HOSTS = [
  /\.tiktokcdn\.com$/i,
  /\.tiktokcdn-us\.com$/i,
  /\.tiktokcdn-eu\.com$/i,
  /\.tiktokv\.com$/i,
  /\.tiktokv\.us$/i,
  /(^|\.)tikwm\.com$/i,          // NEW — tikwm-hosted media
];

const PROBE_TIMEOUT_MS    = 8000;
const SIZE_TIMEOUT_MS     = 8000;
const DOWNLOAD_TIMEOUT_MS = 55000;
const MAX_URLS            = 10;
const SIZE_CONCURRENCY    = 4;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36";

/* ---------------- entry point ---------------- */

export default async function handler(req, res) {
  // Broad CORS — merged handler serves GET + POST.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Content-Disposition"
  );

  if (req.method === "OPTIONS") return res.status(204).end();

  const action = pickAction(req);

  if (!action) {
    return res.status(400).json({
      error: "Missing or unknown action",
      usage: {
        html:     "POST { action: 'html', ... }",
        size:     "POST { action: 'size', urls: [...] }",
        probe:    "GET ?action=probe&url=<cdn-url>",
        download: "GET ?action=download&url=<cdn-url>[&filename=...]",
      },
    });
  }

  try {
    switch (action) {
      case "html":     return await handleHtml(req, res);
      case "size":     return await handleSize(req, res);
      case "probe":    return await handleProbe(req, res);
      case "download": return await handleProbe(req, res, { forceDownload: true });
      default:
        return res.status(400).json({
          error: "Unknown action",
          allowed: ["html", "size", "probe", "download"],
        });
    }
  } catch (err) {
    console.error("tiktokio handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal error" });
    } else {
      try { res.end(); } catch {}
    }
  }
}

function pickAction(req) {
  const q = req.query || {};
  const b = (req.body && typeof req.body === "object") ? req.body : {};

  const explicit = q.action || b.action;
  if (explicit) return String(explicit).toLowerCase();

  if (q.url || b.url) return "probe";
  if ((Array.isArray(q.urls) && q.urls.length) ||
      (Array.isArray(b.urls) && b.urls.length)) return "size";

  return null;
}

/* ---------------- action: html ---------------- */

async function handleHtml(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed for action=html (use POST)" });
  }

  // Accept { url } or { q } or { link } from the client.
  // tiktokio expects form-encoded `q=<url>&lang=en`, not JSON.
  const body = req.body || {};
  const targetUrl = body.url || body.q || body.link;
  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url" });
  }

  try {
    const form = new URLSearchParams();
    form.set("q", targetUrl);
    form.set("lang", "en");

    const upstream = await fetch(TKIO_UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://tiktokio.com/",
        "Origin":  "https://tiktokio.com",
        "Accept":  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: form.toString(),
      redirect: "follow",
    });

    const html = await upstream.text();

    // Helpful for debugging — shows up in Vercel → Logs.
    console.log(
      "[tiktokio] status=%d len=%d preview=%s",
      upstream.status, html.length, html.slice(0, 120).replace(/\s+/g, " ")
    );

    // If upstream failed, pass the diagnostic body back as JSON
    // so the frontend shows something actionable (not just "ok").
    if (!upstream.ok) {
      const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return res.status(upstream.status).json({
        error: "Upstream rejected the request",
        status: upstream.status,
        detail: plain.slice(0, 200) || "(empty body)",
      });
    }

    const clean = html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "");

    res
      .status(upstream.status)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(clean);
  } catch (err) {
    console.error("html proxy error:", err);
    res.status(502).json({ error: "Upstream request failed" });
  }
}

/* ---------------- action: size ---------------- */

async function handleSize(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed for action=size (use POST)" });
  }

  const raw = Array.isArray(req.body && req.body.urls)
    ? req.body.urls
    : (Array.isArray(req.query && req.query.urls) ? req.query.urls : []);

  const urls = raw.slice(0, MAX_URLS);

  if (!urls.length) {
    return res.status(400).json({ error: "No URLs provided" });
  }

  const results = await mapWithConcurrency(urls, SIZE_CONCURRENCY, probeSizeOnly);

  res.status(200).json({
    sizes: results.map((r, i) => ({ url: urls[i], ...r })),
  });
}

/**
 * HEAD-style size probe using `Range: bytes=0-0`.
 * Reads Content-Range's total or falls back to Content-Length.
 */
async function probeSizeOnly(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SIZE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
      redirect: "follow",
    });

    if (response.body && typeof response.body.cancel === "function") {
      try { await response.body.cancel(); } catch {}
    }

    if (!response.ok && response.status !== 206) {
      return { ok: false, error: "HTTP " + response.status };
    }

    const contentRange = response.headers.get("content-range");
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)\s*$/);
      if (m) {
        const bytes = parseInt(m[1], 10);
        return { ok: true, bytes, formatted: humanSize(bytes) };
      }
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const bytes = parseInt(contentLength, 10);
      if (Number.isFinite(bytes)) {
        return { ok: true, bytes, formatted: humanSize(bytes) };
      }
    }

    return { ok: false, error: "No size header" };
  } catch (err) {
    return {
      ok: false,
      error: err.name === "AbortError" ? "Timeout" : "Fetch failed",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ---------------- action: probe / download ---------------- */

async function handleProbe(req, res, opts = {}) {
  const target =
    (req.query && req.query.url) ||
    (req.body && req.body.url);

  if (!target) return res.status(400).json({ error: "Missing url" });

  let parsed;
  try { parsed = new URL(target); }
  catch { return res.status(400).json({ error: "Invalid URL" }); }

  if (!ALLOWED_HOSTS.some(re => re.test(parsed.hostname))) {
    return res.status(403).json({ error: "Host not allowed" });
  }

  const wantsDownload =
    opts.forceDownload ||
    req.query.download === "1" ||
    req.query.download === "true" ||
    (req.body && req.body.download === true);

  if (wantsDownload) return handleDownload(req, res, parsed);
  return handleProbeMeta(res, parsed);
}

async function handleProbeMeta(res, parsed) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const upstream = await fetch(parsed.href, {
      method: "GET",
      headers: cdnHeaders({ Range: "bytes=0-0" }),
      signal: controller.signal,
      redirect: "follow",
    });

    if (upstream.body) {
      try { await upstream.body.cancel(); } catch {}
    }

    const contentType   = upstream.headers.get("content-type") || "";
    const contentRange  = upstream.headers.get("content-range");
    const contentLength = upstream.headers.get("content-length");

    let bytes = null;
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)\s*$/);
      if (m) bytes = parseInt(m[1], 10);
    }
    if (bytes == null && contentLength) {
      bytes = parseInt(contentLength, 10);
    }

    let error = null;
    if (!upstream.ok) {
      try {
        const text = await upstream.text();
        error = text.slice(0, 500);
      } catch {}
    }

    res.status(200).json({
      url:    parsed.href,
      ok:     upstream.ok,
      status: upstream.status,
      type:   contentType.split(";")[0].trim(),
      bytes,
      size:   bytes != null ? humanSize(bytes) : null,
      error,
    });
  } catch (err) {
    res.status(502).json({
      url:   parsed.href,
      ok:    false,
      error: err.name === "AbortError" ? "Timeout" : "Fetch failed",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleDownload(req, res, parsed) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const extra = {};
    if (req.headers.range) extra.Range = req.headers.range;

    const upstream = await fetch(parsed.href, {
      method: "GET",
      headers: cdnHeaders(extra),
      signal: controller.signal,
      redirect: "follow",
    });

    if (!upstream.ok && upstream.status !== 206) {
      const text = await upstream.text().catch(() => "");
      res.status(upstream.status).json({
        error: "Upstream " + upstream.status,
        detail: text.slice(0, 500),
      });
      return;
    }

    if (!upstream.body) {
      res.status(502).json({ error: "Upstream returned no body" });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const filename    = buildFilename(req, contentType);

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", 'attachment; filename="' + filename + '"');

    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    const ar = upstream.headers.get("accept-ranges");
    if (ar) res.setHeader("Accept-Ranges", ar);

    Readable.fromWeb(upstream.body).pipe(res);
    await finished(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({
        error: err.name === "AbortError" ? "Timeout" : "Download failed",
      });
    } else {
      try { res.end(); } catch {}
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ---------------- shared helpers ---------------- */

/**
 * Headers TikTok's CDN expects for signed URLs.
 * `Referer` alone fixes most 403s; the rest cover hotlink / bot checks.
 */
function cdnHeaders(extra) {
  return Object.assign(
    {
      "User-Agent": BROWSER_UA,
      "Referer": "https://www.tiktok.com/",
      "Origin": "https://www.tiktok.com",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",   // no compression → Content-Length is exact
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
    },
    extra || {}
  );
}

function buildFilename(req, contentType) {
  const requested =
    (req.query && req.query.filename) ||
    (req.body && req.body.filename);

  if (requested && typeof requested === "string") return sanitizeFilename(requested);
  return "tiktok-" + Date.now() + extensionFor(contentType);
}

function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 200);
}

function extensionFor(contentType) {
  const t = (contentType || "").toLowerCase();
  if (t.includes("video/mp4"))                             return ".mp4";
  if (t.includes("video/webm"))                            return ".webm";
  if (t.includes("audio/mpeg") || t.includes("audio/mp3")) return ".mp3";
  if (t.includes("audio/mp4")  || t.includes("audio/aac")) return ".m4a";
  if (t.includes("image/jpeg"))                            return ".jpg";
  if (t.includes("image/png"))                             return ".png";
  if (t.includes("image/webp"))                            return ".webp";
  if (t.includes("image/gif"))                             return ".gif";
  return "";
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const decimals = (i === 0 || n >= 10) ? 0 : 1;
  return n.toFixed(decimals) + " " + units[i];
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
