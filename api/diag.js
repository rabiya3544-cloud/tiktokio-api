// api/diag.js — temporary diagnostic. Delete when done.
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const target = req.query.url || "https://vt.tiktok.com/ZSgQfXgeA";
  const URL_ = "https://tiktokio.com/api/v1/tk/html";
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
             "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const results = {};

  async function attempt(name, opts) {
    try {
      const r = await fetch(URL_, opts);
      const text = await r.text();
      results[name] = {
        status: r.status,
        length: text.length,
        preview: text.slice(0, 200).replace(/\s+/g, " "),
      };
    } catch (e) {
      results[name] = { error: String(e.message || e) };
    }
  }

  // 1. JSON body  { url }  (what your current code sends)
  await attempt("json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: target }),
  });

  // 2. Form-encoded  q=<url>  (common PHP scrape API shape)
  await attempt("form_q", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: target }).toString(),
  });

  // 3. Form-encoded  url=<url>
  await attempt("form_url", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url: target }).toString(),
  });

  // 4. Form-encoded  q=<url>  + browser headers
  await attempt("form_q_headers", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
      "Referer": "https://tiktokio.com/",
      "Origin":  "https://tiktokio.com",
    },
    body: new URLSearchParams({ q: target }).toString(),
  });

  res.status(200).json({ target, results });
}
