/* GET /api/gif?id=<round id> → the round's highlight GIF (only exists if the player chose to post it).
   Clips never change once posted, so the CDN can cache them forever. */
import * as db from "./_db.js";

export default async function handler(req, res) {
  if (!db.connected) return res.status(503).end();
  const id = String(req.query.id || "");
  if (!/^[a-z0-9-]{6,40}$/i.test(id)) return res.status(400).end();
  try {
    const stored = await db.getGif(id);
    if (!stored) return res.status(404).end();
    const i = stored.indexOf(":");
    const type = stored.slice(0, i) === "jpeg" ? "image/jpeg" : "image/gif";
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    return res.status(200).send(Buffer.from(stored.slice(i + 1), "base64"));
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }
}
