const UPSTREAM = "https://tiktokio.com/api/v1/tk/html";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const incoming = req.body;
  if (!incoming || typeof incoming !== "object" || !incoming.url) {
    return res.status(400).json({ error: "Missing 'url' in request body" });
  }

  let cleanUrl;
  try {
    const u = new URL(incoming.url);
    u.search = ""; // Strip tracking parameters like ?_r=1&_t=...
    cleanUrl = u.toString();
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/json",
        // These two headers are the most likely missing pieces:
        "Referer": "https://tiktokio.com/",
        "Origin": "https://tiktokio.com",
      },
      body: JSON.stringify({ url: cleanUrl }),
    });

    const html = await upstream.text();

    if (!upstream.ok) {
      console.error("Upstream rejected request. Status:", upstream.status, "Body:", html);
      return res.status(502).json({
        error: "Upstream request failed",
        status: upstream.status,
        detail: html.slice(0, 500) // This will now show you *why* it failed
      });
    }

    const clean = html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "");

    res
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .status(200)
      .send(clean);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).json({ error: "Upstream request failed" });
  }
}
