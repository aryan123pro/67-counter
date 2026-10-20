/* Sharing a round's GIF.
   - Phones: opens the share sheet with the GIF file itself (WhatsApp, Instagram, etc.) plus the link.
   - Otherwise: the system share sheet with the link, or the link is copied to the clipboard.
   The link (/s/<id>) is a page with the GIF, a download button and a "beat it" button.
   Returns a short message for the caller to show. */

const BASE = String(globalThis.API_BASE || "").replace(/\/$/, "") || location.origin; // share pages live on the server
export const shareUrl = (run) => `${BASE}/s/${encodeURIComponent(run.id)}`;

export async function shareGif(run) {
  const online = Boolean(run.id) && !String(run.photo || "").startsWith("data:"); // posted to the shared board
  const url = online ? shareUrl(run) : "";
  const text = `${run.name} hit ${run.score} six-sevens in 30s at Taqneeq 19.0 🫴🫴 Think you can beat it?`;
  const fileName = `${String(run.name).replace(/[^\w-]+/g, "_")}-${run.score}-67s.gif`;

  // 1) share the GIF file itself (mostly phones)
  if (navigator.canShare && run.photo) {
    try {
      const blob = await (await fetch(run.photo)).blob();
      const file = new File([blob], blob.type === "image/jpeg" ? fileName.replace(/\.gif$/, ".jpg") : fileName, { type: blob.type || "image/gif" });
      const data = { files: [file], title: "67 Counter · Taqneeq 19.0", text: url ? `${text} ${url}` : text };
      if (navigator.canShare(data)) {
        await navigator.share(data);
        return "Shared! 🎉";
      }
    } catch (err) {
      if (err?.name === "AbortError") return "";
      console.warn("file share failed, falling back to the link:", err);
    }
  }
  if (!url) return "Use ⬇ GIF to save it, then share it anywhere.";
  // 2) share the link
  if (navigator.share) {
    try { await navigator.share({ title: "67 Counter · Taqneeq 19.0", text, url }); return "Shared! 🎉"; }
    catch (err) { if (err?.name === "AbortError") return ""; }
  }
  // 3) copy the link
  try { await navigator.clipboard.writeText(url); return "Link copied — paste it anywhere 🔗"; }
  catch { return url; }
}
