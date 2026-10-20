/* The shareable page for one round's GIF (served at /s/<round id>).
   Rendered on the server so WhatsApp / iMessage / Instagram DMs show a link preview with the GIF. */

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page({ title, desc, image, body, origin, url }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="67 Counter · Taqneeq 19.0" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
${image ? `<meta property="og:image" content="${esc(origin + image)}" />
<meta property="og:image:type" content="image/gif" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${esc(origin + image)}" />` : ""}
<meta property="og:url" content="${esc(url)}" />
<link rel="icon" type="image/png" href="/tq-icon-64.png" />
<link href="https://fonts.googleapis.com/css2?family=Bungee&family=Josefin+Sans:wght@600&family=Space+Mono:wght@700&display=swap" rel="stylesheet" />
<style>
  :root { --pink: #9000ff; --lime: #ffd000; --cyan: #d9a6ff; --yellow: #ffd000; --gold: #ffd000; --ink: #16002e; --paper: #f6ecff; --bg: #1e003d; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; background: radial-gradient(circle at 50% 20%, #4a0090, var(--bg) 65%); color: var(--paper); font-family: "Space Mono", monospace; display: grid; place-items: center; padding: 24px 16px; }
  main { width: min(520px, 100%); display: grid; gap: 18px; justify-items: center; text-align: center; }
  .brand { display: inline-flex; align-items: center; gap: 10px; border: 3px solid var(--gold); border-radius: 16px; padding: 5px 14px 5px 5px; background: rgba(30, 0, 61, .7); }
  .brand img { width: 42px; height: 42px; border-radius: 10px; }
  .brand b { font-family: Bungee, sans-serif; color: var(--gold); font-size: 18px; line-height: 1; display: block; text-align: left; }
  .brand span { font-family: "Josefin Sans", sans-serif; font-size: 10px; letter-spacing: .25em; display: block; margin-top: 4px; }
  h1 { font-family: Bungee, sans-serif; font-size: clamp(26px, 7vw, 40px); line-height: 1.05; }
  h1 em { font-style: normal; color: var(--yellow); -webkit-text-stroke: 2px var(--ink); paint-order: stroke fill; text-shadow: 4px 4px 0 var(--pink); font-size: 1.4em; display: block; }
  .gif { width: 100%; background: #fff; padding: 10px 10px 12px; border: 4px solid var(--ink); box-shadow: 8px 8px 0 var(--cyan); transform: rotate(-1.5deg); }
  .gif img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #2e0059; }
  .btns { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
  .btn { font-family: Bungee, sans-serif; font-size: 16px; text-decoration: none; color: var(--ink); background: var(--lime); border: 3px solid var(--ink); border-radius: 14px; padding: 11px 18px; box-shadow: 5px 5px 0 var(--ink); cursor: pointer; }
  .btn.alt { background: var(--cyan); }
  .btn.hot { background: var(--pink); color: #fff; }
  .btn:active { transform: translate(3px, 3px); box-shadow: 2px 2px 0 var(--ink); }
  .note { font-size: 13px; opacity: .8; min-height: 1.2em; }
</style>
</head>
<body>
<main>
  <div class="brand"><img src="/taqneeq-logo.jpg" alt="Taqneeq 19.0" /><div><b>TAQNEEQ 19.0</b><span>67 COUNTER</span></div></div>
  ${body}
</main>
</body>
</html>`;
}

export function sharePage(run, origin) {
  if (!run || !run.hasGif) {
    return {
      status: 404,
      html: page({
        origin, url: `${origin}/s/`, title: "67 Counter · Taqneeq 19.0", desc: "How many 6-7s can you do in 30 seconds?",
        body: `<h1>This GIF isn't here anymore</h1><div class="btns"><a class="btn" href="/">▶ PLAY 67</a><a class="btn alt" href="/leaderboard.html">🏆 HALL OF 67</a></div>`,
      }),
    };
  }
  const gif = `/api/gif?id=${run.id}&v=${run.gifV || 1}`;
  const file = `${run.name.replace(/[^\w-]+/g, "_")}-${run.score}-67s.gif`;
  const title = `${run.name} hit ${run.score} six-sevens! · Taqneeq 19.0`;
  const desc = `${run.name} did ${run.score} 6-7s in 30 seconds at Taqneeq 19.0. Think you can beat it?`;
  const url = `${origin}/s/${run.id}`;
  return {
    status: 200,
    html: page({
      origin, url, title, desc, image: gif,
      body: `
  <h1>${esc(run.name)} hit <em>${esc(run.score)}</em> six-sevens in 30s</h1>
  <div class="gif"><img src="${esc(gif)}" alt="${esc(run.name)} doing 6-7s" /></div>
  <div class="btns">
    <a class="btn" href="${esc(gif)}" download="${esc(file)}">⬇ DOWNLOAD GIF</a>
    <button class="btn hot" id="share" type="button">📤 SHARE</button>
  </div>
  <div class="btns"><a class="btn alt" href="/">▶ BEAT IT</a><a class="btn alt" href="/leaderboard.html">🏆 HALL OF 67</a></div>
  <p class="note" id="note"></p>
  <script type="module">
    import { shareGif } from "/share.js";
    const note = document.getElementById("note");
    document.getElementById("share").addEventListener("click", async () => {
      note.textContent = await shareGif(${JSON.stringify({ id: run.id, name: run.name, score: run.score, photo: gif }).replace(/</g, "\\u003c")});
    });
  </script>`,
    }),
  };
}
