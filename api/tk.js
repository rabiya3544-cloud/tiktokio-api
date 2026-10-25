const UPSTREAM = "https://tiktokio.com/api/v1/tk/html";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // 1. Validate the incoming body
  const incoming = req.body;
  if (!incoming || typeof incoming !== "object" || !incoming.url) {
    return res.status(400).json({ error: "Missing 'url' in request body" });
  }

  // 2. Strip tracking parameters (?_r=1&_t=...) which tiktokio rejects
  let cleanUrl;
  try {
    const u = new URL(incoming.url);
    u.search = ""; 
    cleanUrl = u.toString();
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  try {
    // 3. Forward only the cleaned URL
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A browser-like UA avoids some upstream 403s
        "User-Agent": "Mozilla/5.0 (compatible; MyApp/1.0)",
      },
      body: JSON.stringify({ url: cleanUrl }),
    });

    const html = await upstream.text();

    // 4. If upstream fails, do not forward its (often empty) error page
    if (!upstream.ok) {
      console.error("Upstream error:", upstream.status, html.slice(0, 200));
      return res.status(502).json({
        error: "Upstream request failed",
        status: upstream.status,
        detail: html.slice(0, 200), // helps you debug future 400s
      });
    }

    // 5. Clean and return the HTML snippet
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
