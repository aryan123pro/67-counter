/* GIF helpers shared by the game and the leaderboard page:
   - stampBrand: the small Taqneeq 19.0 watermark baked into every GIF frame
   - encodeGif / shrinkForUpload: turn frames into a GIF, small enough for the shared board
   - rebrandGif: decode an older posted GIF, stamp every frame, re-encode (admin re-brand tool) */

const GIFENC = "https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js";
export const FRAME_W = 288, FRAME_H = 216; // size of recorded clip frames

/* ---------------- branding stamp ---------------- */
export const tqLogo = new Image();
tqLogo.src = "taqneeq-logo.jpg";
export const logoReady = () =>
  tqLogo.complete && tqLogo.naturalWidth ? Promise.resolve() : new Promise((r) => { tqLogo.onload = r; tqLogo.onerror = r; });

// A small, see-through watermark in the top-left corner of a 288×216 frame:
// TQ logo + "TAQNEEQ 19.0" in gold on a light translucent pill, so the video shows through.
export function stampBrand(x) {
  x.save();
  const X = 6, Y = 6, H = 24, LOGO = 18;
  x.font = "10.5px Bungee, sans-serif";
  x.textAlign = "left"; x.textBaseline = "middle";
  const tw = x.measureText("TAQNEEQ 19.0").width;
  const W = 4 + LOGO + 6 + tw + 8;
  // pill
  x.beginPath();
  if (x.roundRect) x.roundRect(X, Y, W, H, H / 2); else x.rect(X, Y, W, H);
  x.fillStyle = "rgba(12, 4, 24, .42)"; x.fill();
  x.lineWidth = 1; x.strokeStyle = "rgba(255, 194, 26, .55)"; x.stroke();
  // logo, clipped round
  if (tqLogo.complete && tqLogo.naturalWidth) {
    x.save();
    x.beginPath(); x.arc(X + 3 + LOGO / 2, Y + H / 2, LOGO / 2, 0, Math.PI * 2); x.clip();
    x.globalAlpha = 0.95; x.drawImage(tqLogo, X + 3, Y + (H - LOGO) / 2, LOGO, LOGO);
    x.restore();
  }
  // wordmark with a soft shadow so it reads on bright backgrounds too
  x.shadowColor = "rgba(0, 0, 0, .55)"; x.shadowBlur = 2; x.shadowOffsetY = 1;
  x.fillStyle = "rgba(255, 194, 26, .95)";
  x.fillText("TAQNEEQ 19.0", X + 4 + LOGO + 6, Y + H / 2 + 1);
  x.restore();
}

// Older GIFs carry an earlier stamp in the top-left ("67 COUNTER" text, or the big branded panel).
// Blur that corner in place (feathered so there's no hard edge) and shade it softly, so the old stamp
// melts into a gentle shadow behind the new see-through watermark.
function coverOldStamp(x) {
  const W = 236, H = 84, IN_W = 196, IN_H = 54; // fully covered area, then a soft fade out to W×H
  const t = document.createElement("canvas"); t.width = W; t.height = H;
  const tx = t.getContext("2d");
  tx.filter = "blur(11px)";
  tx.drawImage(x.canvas, 0, 0, W, H, 0, 0, W, H);
  tx.filter = "none";
  tx.fillStyle = "rgba(12, 4, 24, .38)"; tx.fillRect(0, 0, W, H); // soft shade
  // feather mask: solid over the old stamp, fading out toward the right and bottom edges
  const m = document.createElement("canvas"); m.width = W; m.height = H;
  const mx = m.getContext("2d");
  const gx = mx.createLinearGradient(IN_W, 0, W, 0); gx.addColorStop(0, "#000"); gx.addColorStop(1, "rgba(0,0,0,0)");
  mx.fillStyle = gx; mx.fillRect(0, 0, W, H);
  mx.globalCompositeOperation = "destination-in";
  const gy = mx.createLinearGradient(0, IN_H, 0, H); gy.addColorStop(0, "#000"); gy.addColorStop(1, "rgba(0,0,0,0)");
  mx.fillStyle = gy; mx.fillRect(0, 0, W, H);
  tx.globalCompositeOperation = "destination-in";
  tx.drawImage(m, 0, 0);
  x.drawImage(t, 0, 0);
}

/* ---------------- encoding ---------------- */
export const toDataUrl = (blob) => new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsDataURL(blob); });

// Encode frames (canvases) into a GIF, optionally smaller (w×h), with fewer colours, or skipping frames (step).
export async function encodeGif(frames, { w = FRAME_W, h = FRAME_H, colors = 256, step = 1, delay = 125 } = {}) {
  const { GIFEncoder, quantize, applyPalette } = await import(GIFENC);
  const gif = GIFEncoder();
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true });
  for (let i = 0; i < frames.length; i += step) {
    x.drawImage(frames[i], 0, 0, w, h);
    const { data } = x.getImageData(0, 0, w, h);
    const palette = quantize(data, colors);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: delay * step });
    await new Promise(requestAnimationFrame); // keep the page animating while we encode
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

// Real camera footage is grainy and makes big GIFs, so the copy posted online is shrunk
// step by step until it fits the upload limit (downloads from the results screen keep full quality).
export const UPLOAD_BUDGET = 550 * 1024;
const UPLOAD_LEVELS = [
  {},
  { w: 240, h: 180, colors: 128 },
  { w: 208, h: 156, colors: 64 },
  { w: 208, h: 156, colors: 64, step: 2 },
  { w: 176, h: 132, colors: 32, step: 2 },
];
export async function shrinkForUpload(frames, delay = 125) {
  let blob;
  for (const level of UPLOAD_LEVELS) {
    blob = await encodeGif(frames, { ...level, delay });
    if (blob.size <= UPLOAD_BUDGET) break;
  }
  return blob;
}

/* ---------------- re-brand an older GIF (admin tool) ---------------- */
export const canRebrand = () => "ImageDecoder" in window;

// Fetch a posted GIF (or JPEG still), stamp every frame with the branding, and return an upload-ready data URL.
export async function rebrandGif(url) {
  await logoReady();
  await document.fonts?.ready;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`couldn't fetch GIF (${res.status})`);
  const type = res.headers.get("content-type") || "image/gif";
  const data = await res.arrayBuffer();
  const frame = () => { const c = document.createElement("canvas"); c.width = FRAME_W; c.height = FRAME_H; return c; };

  if (!type.includes("gif")) { // an old still photo: stamp it and keep it a JPEG
    const img = await createImageBitmap(new Blob([data], { type }));
    const c = frame(), x = c.getContext("2d");
    x.drawImage(img, 0, 0, FRAME_W, FRAME_H); coverOldStamp(x); stampBrand(x);
    return c.toDataURL("image/jpeg", 0.85);
  }

  const decoder = new ImageDecoder({ data, type: "image/gif" });
  await decoder.tracks.ready;
  const count = decoder.tracks.selectedTrack.frameCount;
  const frames = [];
  let totalMs = 0;
  for (let i = 0; i < count; i++) {
    const { image } = await decoder.decode({ frameIndex: i });
    const c = frame(), x = c.getContext("2d");
    x.drawImage(image, 0, 0, FRAME_W, FRAME_H);
    coverOldStamp(x);
    stampBrand(x);
    totalMs += (image.duration || 125000) / 1000;
    image.close();
    frames.push(c);
  }
  decoder.close();
  const delay = Math.max(20, Math.round(totalMs / Math.max(1, count)));
  return toDataUrl(await shrinkForUpload(frames, delay));
}
