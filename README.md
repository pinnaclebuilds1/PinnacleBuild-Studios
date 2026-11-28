# Pinnacle Builds

The PinnacleBuild-Studios website (`index.html`) and its studio backend: commissions, the private manager, build uploads, and the public feedback/referral board. No Google Sheet, Apps Script or Google Cloud project needed.

| | |
| --- | --- |
| **Live site** | <https://pinnacle-builds-vdb5vf.freebuff.site> |
| **Mirror** (GitHub Pages) | <https://pinnaclebuilds1.github.io/PinnacleBuild-Studios/> |
| **Staging** | <https://pinnacle-builds-vdb5vf-preview.freebuff.site> |

Both public addresses serve the same site and talk to the same backend, so content and the manager stay in sync.

## One thing to do once

The manager (`/#manager`) needs a password before you can sign in. In the Freebuff **Sites → Secrets** panel for this site add:

| Name | Value |
| --- | --- |
| `PB_ADMIN_PASSWORD` | the password you want to use |

Then sign in at `/#manager` with `pinnaclebuilds1@gmail.com` and that password. Everything else — commissions, the public queue, completed builds, feedback and referrals — already works for visitors without any setup.

## Run it locally

```bash
npm start
```

Then open the address it prints (default <http://localhost:3000>).

The first run creates `server/data/` and writes your manager password to `server/data/ADMIN-PASSWORD.txt` (owner email `pinnaclebuilds1@gmail.com`). Open `/#manager` and sign in with those details. To choose your own password and port, copy `.env.example` to `.env`, fill it in, and restart.

The Node server uses only Node 18+ built-ins — no dependencies to install.

## What it does

- **Commissions** — anyone can send a request without an account. Requests land in the manager inbox with the full brief; nothing is emailed automatically, so the reply flow saves the message on the request and opens Gmail with it ready to send.
- **Manager** (`/#manager`) — inbox, statuses, quotes, private notes, archive, done-commission details and pictures, builds with cover/gallery/structure/world uploads, homepage text, featured builds, social links, and a queue listing for the public page.
- **Public pages** — The Vault, completed commissions, and the current queue. Customer emails, Discord names and private notes are never exposed by the public API.
- **Feedback & referrals** — guests can post with a name; every submission waits for approval in the manager's *Feedback & referrals* tab before it appears on the site.
- **Uploads** — images are resized in the browser and served from `/uploads/...`. Cover images, galleries, `.mcstructure` and `.mcworld` files all work.
- **Portfolio** — `media/` holds the images that ship with the site; `server/seed.mjs` loads the studio's own builds into a fresh database once, so the Vault is never empty.
- **Google member accounts** — optional. Set `PB_GOOGLE_CLIENT_ID` to switch them on; without it the site hides the account entry points instead of offering a dead sign-in.

## Two ways to run the backend

Both share the same code (`server/api.mjs`), so the site behaves identically.

1. **Any Node host** — `node server/index.mjs`. Data is a JSON file plus an uploads folder under `server/data/`. Copy that folder to back up.
2. **Freebuff Sites (Cloudflare Workers)** — the published setup. `worker/index.mjs` serves the same `/api` and `/uploads/...` routes from Cloudflare D1 (database) and R2 (uploads). Data lives in the site's own D1/R2 bindings, so back it up from the Sites panel.

## Publishing a change

```bash
npm run build          # builds public/index.html + public/media, and bundles dist/worker.mjs
npm test               # 24 checks against the Node server
node worker/smoke.mjs http://127.0.0.1:8788 YOUR_PASSWORD   # 18 checks against a local Worker
```

Deploy the repository root's `sites.manifest.json` (assets from `public/`, Worker from `dist/worker.mjs`) to the site's preview environment, then to production.

To test the hosted build before publishing:

```bash
npm run build
npx wrangler dev --config wrangler.local.jsonc --port 8788 --var PB_ADMIN_PASSWORD:localtest123
node worker/smoke.mjs http://127.0.0.1:8788 localtest123
```

### GitHub Pages

`.github/workflows/pages.yml` builds `public/` with the API pointed at the live backend (`node deploy/build-site.mjs --api https://pinnacle-builds-vdb5vf.freebuff.site/api`) and publishes only that folder — no server source. The site is one file, so any host works.

Because the mirror lives on `pinnaclebuilds1.github.io` while the backend lives on the hosted domain, the backend accepts cross-origin API calls from that origin only. Add more with `PB_ALLOWED_ORIGINS` (comma-separated list).

## Configuration

| Variable | Used by | Meaning |
| --- | --- | --- |
| `PB_ADMIN_EMAIL` | both | Owner sign-in email (default `pinnaclebuilds1@gmail.com`) |
| `PB_ADMIN_PASSWORD` | both | Manager password. On the Node server an empty value generates one on first run |
| `PB_GOOGLE_CLIENT_ID` | both | Optional Google sign-in client ID (no secret needed) |
| `PB_ALLOWED_ORIGINS` | both | Extra origins allowed to call the API cross-origin |
| `PORT`, `HOST` | Node | Where the local server listens |
| `PB_DATA_DIR` | Node | Where `db.json` and `uploads/` live (default `server/data`) |

## Legacy: Google Apps Script

`Code.gs` and `apps-script/Code.gs` are the old Apps Script backend and are no longer used. The deployed copy only ever answered `site`, which is why member sign-in, feedback and referrals used to return "Unknown request". Keep them only if you still want the Sheet workflow.
