# 67 Counter · Taqneeq 19.0

How many 6-7s can you do? A camera game: palms up, pump your hands up and down in turns, and every time
your palms swap places is one rep. Hype-man voice, live coach, music, highlight GIFs, and a shared
leaderboard with player profiles.

## Deploy on Vercel

1. Import this repo in Vercel (no build settings needed).
2. **Storage → Marketplace → Upstash Redis → Create / Connect** to this project (free tier is plenty).
   This adds the `KV_REST_API_URL` / `KV_REST_API_TOKEN` environment variables.
3. **Settings → Environment Variables → `ADMIN_KEY`** = a password of your choice. Open **`/admin`** on the site
   and log in with it to delete players or rounds, clear the board, download a backup or update GIF branding.
4. Redeploy so the new variables are picked up.

Every device then shares one live leaderboard. Players must enter a name; each 30-second round's
score and highlight GIF post automatically.

Without the database (or when served by a plain static server) the game still works and keeps the
leaderboard on each device instead.

## Run locally

```sh
python3 -m http.server 6767     # leaderboard stays on this device
# or, for the shared leaderboard: npm i -g vercel && vercel link && vercel env pull && vercel dev
```

The camera needs `localhost` or HTTPS.
