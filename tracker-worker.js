/* Runs MediaPipe pose tracking off the main thread so the game never stutters while you 67.
   We only use it to find your palms: the pose model infers hand position from the whole arm,
   so it keeps tracking even when fast 67s turn your hands into a motion-blurred smear
   (a pure hand model loses blurry hands).
   Classic (non-module) worker on purpose: MediaPipe's wasm loader needs importScripts. */
const V = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// The CDN serves the CommonJS bundle with a non-JS MIME type, which importScripts rejects,
// so fetch it synchronously (allowed in workers) and evaluate it with a module/exports shim.
self.module = { exports: {} };
self.exports = self.module.exports;
const xhr = new XMLHttpRequest();
xhr.open("GET", `${V}/vision_bundle.cjs`, false);
xhr.send();
if (xhr.status !== 200) throw new Error(`could not load vision bundle (${xhr.status})`);
(0, eval)(xhr.responseText);
const { PoseLandmarker, FilesetResolver } = self.module.exports;

let landmarker = null;
let lastTs = 0;

async function init() {
  const fileset = await FilesetResolver.forVisionTasks(`${V}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    // VIDEO mode: tracks from the previous frame instead of re-finding the body every frame,
    // which halves the cost (IMAGE mode only managed ~15 fps on a MacBook). Its landmark smoothing
    // is velocity-adaptive, so fast 67s pass through almost untouched.
    runningMode: "VIDEO", numPoses: 1,
    minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
  });
  try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch { landmarker = await PoseLandmarker.createFromOptions(fileset, opts("CPU")); }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    try { await init(); self.postMessage({ type: "ready" }); }
    catch (err) { self.postMessage({ type: "error", message: String((err && err.message) || err) }); }
    return;
  }
  if (msg.type === "frame") {
    const t0 = performance.now();
    let landmarks = null;
    try {
      const ts = Math.max(lastTs + 1, Math.round(msg.t)); // timestamps must strictly increase
      lastTs = ts;
      const lm = landmarker.detectForVideo(msg.bitmap, ts).landmarks?.[0];
      // only shoulders (11,12) and hands (15–22) are needed; send plain objects so they clone cheaply
      if (lm) landmarks = lm.map((p, i) => (i >= 11 && i <= 22 ? { x: p.x, y: p.y, visibility: p.visibility } : null));
    } catch {}
    msg.bitmap.close();
    self.postMessage({ type: "result", t: msg.t, landmarks, ms: performance.now() - t0 });
  }
};
