/* GIF helpers shared by the game and the leaderboard page:
   - stampBrand: the Taqneeq TQ logo baked into every GIF frame
   - encodeGif / shrinkForUpload: turn frames into a GIF, small enough for the shared board
   - rebrandGif: decode an older posted GIF, stamp every frame, re-encode (admin re-brand tool) */

const GIFENC = "https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js";
export const FRAME_W = 288, FRAME_H = 216; // size of recorded clip frames

/* ---------------- branding stamp ---------------- */
export const tqLogo = new Image();
tqLogo.src = "taqneeq-logo.jpg";
export const logoReady = () =>
  tqLogo.complete && tqLogo.naturalWidth ? Promise.resolve() : new Promise((r) => { tqLogo.onload = r; tqLogo.onerror = r; });

// Watermark: just the Taqneeq TQ logo, small, in the top-left corner of a 288×216 frame.
export function stampBrand(x) {
  if (!(tqLogo.complete && tqLogo.naturalWidth)) return;
  const X = 7, Y = 7, S = 30, R = 7;
  x.save();
  x.shadowColor = "rgba(0, 0, 0, .45)"; x.shadowBlur = 4; x.shadowOffsetY = 1; // lifts it off busy backgrounds
  x.beginPath();
  if (x.roundRect) x.roundRect(X, Y, S, S, R); else x.rect(X, Y, S, S);
  x.fillStyle = "#3b1a73"; x.fill(); // logo's own purple behind the clip, so the shadow has something to cast from
  x.shadowColor = "transparent";
  x.clip();
  x.drawImage(tqLogo, X, Y, S, S);
  x.restore();
}

// Older GIFs carry an earlier stamp in the top-left. Fill that corner in like a photo editor would:
// each column fades from the background along the very top edge (above every old stamp) to the clean
// background just below the stamp, so the patch matches both edges. Its right side is feathered into the
// picture, then the logo goes on top.
//   0 = "67 COUNTER" text only; 1+ = had a branded panel/pill at some point (GIFs went 1 → 2 → …),
//   so clean the whole area the big panel ever covered.
const OLD_STAMP_AREA = { 0: { w: 120, h: 30 }, any: { w: 202, h: 58 } };
function coverOldStamp(x, fromVersion = 0) {
  const { w: IN_W, h: IN_H } = fromVersion > 0 ? OLD_STAMP_AREA.any : OLD_STAMP_AREA[0];
  const F = 40, W = IN_W + F, H = IN_H; // F = feather width on the right
  const cols = Math.max(2, Math.round(W / 10));
  const strip = (y) => { // a row of averaged background colours, cols wide
    const c = document.createElement("canvas"); c.width = cols; c.height = 1;
    c.getContext("2d").drawImage(x.canvas, 0, y, W, 3, 0, 0, cols, 1);
    return c;
  };
  const top = strip(0), bottom = strip(IN_H + 1);
  const t = document.createElement("canvas"); t.width = W; t.height = H;
  const tx = t.getContext("2d");
  tx.imageSmoothingEnabled = true; tx.imageSmoothingQuality = "high";
  tx.drawImage(bottom, 0, 0, W, H); // bottom colours everywhere…
  const fade = document.createElement("canvas"); fade.width = W; fade.height = H; // …top colours fading out downward
  const fx = fade.getContext("2d");
  fx.imageSmoothingEnabled = true;
  fx.drawImage(top, 0, 0, W, H);
  fx.globalCompositeOperation = "destination-in";
  const gy = fx.createLinearGradient(0, 0, 0, H); gy.addColorStop(0, "#000"); gy.addColorStop(1, "rgba(0,0,0,0)");
  fx.fillStyle = gy; fx.fillRect(0, 0, W, H);
  tx.drawImage(fade, 0, 0);
  // a touch of the frame's own grain so the patch doesn't look flat
  tx.globalAlpha = 0.18; tx.filter = "blur(1px)";
  tx.drawImage(x.canvas, 0, IN_H + 2, W, H, 0, 0, W, H);
  tx.globalAlpha = 1; tx.filter = "none";
  // feather the right edge into the picture
  tx.globalCompositeOperation = "destination-in";
  const gx = tx.createLinearGradient(IN_W, 0, W, 0); gx.addColorStop(0, "#000"); gx.addColorStop(1, "rgba(0,0,0,0)");
  tx.fillStyle = gx; tx.fillRect(0, 0, W, H);
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
// ~300 KB keeps 400 GIFs (stored as base64, ~1.33×) around 160 MB — inside Upstash's free 256 MB.
export const UPLOAD_BUDGET = 300 * 1024;
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

// Fetch a posted GIF (or JPEG still), swap its old stamp (fromVersion = the design it has) for the current
// logo watermark on every frame, and return an upload-ready data URL.
export async function rebrandGif(url, fromVersion = 0) {
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
    x.drawImage(img, 0, 0, FRAME_W, FRAME_H); coverOldStamp(x, fromVersion); stampBrand(x);
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
    coverOldStamp(x, fromVersion);
    stampBrand(x);
    totalMs += (image.duration || 125000) / 1000;
    image.close();
    frames.push(c);
  }
  decoder.close();
  const delay = Math.max(20, Math.round(totalMs / Math.max(1, count)));
  return toDataUrl(await shrinkForUpload(frames, delay));
}
