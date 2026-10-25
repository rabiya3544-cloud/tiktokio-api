const UPSTREAM = "https://tiktokio.com/api/v1/tk/html";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let cleanUrl;
  try {
    const u = new URL(req.body?.url);
    u.search = "";
    cleanUrl = u.toString();
  } catch {
    return res.status(400).json({ error: "Invalid URL", received: req.body });
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/json",
        "Referer": "https://tiktokio.com/",
        "Origin": "https://tiktokio.com",
      },
      body: JSON.stringify({ url: cleanUrl }),
    });

    const body = await upstream.text();

    // DEBUG: return everything we know, as JSON
    return res.status(200).json({
      sentUrl: cleanUrl,
      upstreamStatus: upstream.status,
      upstreamHeaders: Object.fromEntries(upstream.headers),
      upstreamBodyLength: body.length,
      upstreamBodyPreview: body.slice(0, 1000),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err), message: err?.message });
  }
}
