/* GIF helpers shared by the game and the leaderboard page:
   - stampBrand: the Taqneeq 19.0 branding baked into every GIF frame
   - encodeGif / shrinkForUpload: turn frames into a GIF, small enough for the shared board
   - rebrandGif: decode an older posted GIF, stamp every frame, re-encode (admin re-brand tool) */

const GIFENC = "https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js";
export const FRAME_W = 288, FRAME_H = 216; // size of recorded clip frames

/* ---------------- branding stamp ---------------- */
export const tqLogo = new Image();
tqLogo.src = "taqneeq-logo.jpg";
export const logoReady = () =>
  tqLogo.complete && tqLogo.naturalWidth ? Promise.resolve() : new Promise((r) => { tqLogo.onload = r; tqLogo.onerror = r; });

// TQ logo + "TAQNEEQ 19.0" + "NMIMS MPSTME TECH FEST" on a gold-edged panel, top-left of a 288×216 frame
export function stampBrand(x) {
  x.save();
  x.textAlign = "left"; x.textBaseline = "alphabetic";
  x.font = "15px Bungee, sans-serif";
  const w1 = x.measureText("TAQNEEQ 19.0").width;
  x.font = "600 8.5px 'Josefin Sans', sans-serif";
  const w2 = x.measureText("NMIMS MPSTME TECH FEST").width;
  const bw = 50 + Math.max(w1, w2) + 9;
  x.fillStyle = "rgba(18, 2, 31, .96)"; x.strokeStyle = "#ffc21a"; x.lineWidth = 2;
  x.beginPath();
  if (x.roundRect) x.roundRect(5, 5, bw, 44, 10); else x.rect(5, 5, bw, 44);
  x.fill(); x.stroke();
  if (tqLogo.complete && tqLogo.naturalWidth) x.drawImage(tqLogo, 9, 9, 36, 36);
  x.font = "15px Bungee, sans-serif"; x.fillStyle = "#ffc21a"; x.fillText("TAQNEEQ 19.0", 50, 27);
  x.font = "600 8.5px 'Josefin Sans', sans-serif"; x.fillStyle = "#faebd7"; x.fillText("NMIMS MPSTME TECH FEST", 50, 40);
  x.restore();
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
    x.drawImage(img, 0, 0, FRAME_W, FRAME_H); stampBrand(x);
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
    stampBrand(x);
    totalMs += (image.duration || 125000) / 1000;
    image.close();
    frames.push(c);
  }
  decoder.close();
  const delay = Math.max(20, Math.round(totalMs / Math.max(1, count)));
  return toDataUrl(await shrinkForUpload(frames, delay));
}
