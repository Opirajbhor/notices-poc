# Govt Notices Aggregator

A single-page web app that aggregates the latest notices, circulars, and announcements from nine Bangladeshi government education sites into one dashboard.

**Live app:** https://notices-poc.vercel.app/

---

## Features

- **9 sources, one dashboard** — DSHE, SHED, BTEB, TechEdu, and five Dhaka Education Board sections (School, College, JSC, SSC, HSC).
- **Tabbed interface** — switch between sources; each tab shows a count and an unread dot.
- **Browser notifications** — get alerted when a new notice appears (opt-in via the 🔔 button).
- **Keyword alerts** — highlight and notify on keywords you care about (e.g. `পরীক্ষা, ছুটি, বদলি`).
- **Star / bookmark** — save notices to a dedicated ★ Starred tab.
- **Read / unread tracking** — unread cards have a red left border; the page title shows the total unread count.
- **Search + date filter** — filter by title or by date range (today / week / month).
- **Auto-polling** — refreshes from the API every 5 minutes.
- **Local cache** — starred, read, and settings state persists in `localStorage`.
- **Zero cost** — runs entirely on Vercel's free tier using free BD proxies.

---

## Architecture

```
┌──────────────────┐       ┌────────────────────────┐       ┌──────────────────┐
│  Browser (HTML)  │──────▶│  Vercel Function       │──────▶│  Free BD proxies │
│  index.html      │ fetch │  /api/notices.js       │ fetch │  (2,000+ pool)   │
└──────────────────┘       └────────────────────────┘       └────────┬─────────┘
                                                                    │
                                                                    ▼
                                                          ┌──────────────────┐
                                                          │  Govt websites   │
                                                          │  (9 sources)     │
                                                          └──────────────────┘
```

**Why the proxies?** The government sites block Cloudflare IPs and return errors to any non-Bangladeshi server. Free BD proxies route the request through a Bangladeshi IP, so the sites respond normally. The function races all proxies in parallel and uses the first one that returns valid HTML.

**Why not client-side?** Browser `fetch()` is blocked by CORS — the govt sites do not send `Access-Control-Allow-Origin` headers. The Vercel function acts as a server-side proxy that bypasses CORS.

---

## Project Structure

```
notices-poc/
├── index.html          # The web app (HTML + CSS + JS)
├── api/
│   └── notices.js      # Vercel serverless function
├── package.json        # Node dependencies (undici)
├── vercel.json         # Function config (60s timeout)
└── README.md
```

---

## Sources

| Tag | Site | Type |
|---|---|---|
| `DSHE` | dshe.gov.bd | Detail page |
| `SHED` | shed.gov.bd | Detail page |
| `BTEB` | bteb.gov.bd | Detail page |
| `TechEdu` | techedu.gov.bd | Detail page |
| `Dhaka-School` | dhakaeducationboard.gov.bd | PDF only |
| `Dhaka-College` | dhakaeducationboard.gov.bd | PDF only |
| `Dhaka-JSC` | dhakaeducationboard.gov.bd | PDF only |
| `Dhaka-SSC` | dhakaeducationboard.gov.bd | PDF only |
| `Dhaka-HSC` | dhakaeducationboard.gov.bd | PDF only |

**Deduplication:** Dhaka Board notices often appear in multiple sections. The function dedupes by PDF URL, keeping the notice in the highest-priority tab:
`Dhaka-School` → `Dhaka-College` → `Dhaka-JSC` → `Dhaka-SSC` → `Dhaka-HSC`.

---

## Deploying

### Prerequisites
- A GitHub account
- A Vercel account (sign in with GitHub)

### Steps

1. **Create the repo** on GitHub and push these files to the root:
   ```
   package.json
   vercel.json
   index.html
   api/notices.js
   ```

2. **Import the repo** on [vercel.com](https://vercel.com):
   - Click **Add New → Project**
   - Select the repo
   - Click **Deploy**

3. **Wait ~60 seconds.** Vercel installs `undici` and builds the function.

4. **Open the app:**
   ```
   https://YOUR-PROJECT.vercel.app/
   ```

Vercel auto-deploys on every push to `main`.

---

## How the Function Works

On each call to `/api/notices`:

1. Fetches a list of ~2,500 HTTP proxies from public sources.
2. For each of the 9 sites (sequentially):
   - Races the full proxy pool against the target URL.
   - The first proxy to return valid HTML (>5 KB) wins and all others are aborted.
   - If all proxies fail, waits 600ms and retries once with a reshuffled pool.
3. Parses the HTML into `{ title, url, tag, date, time }` objects.
4. Dedupes Dhaka Board sections by URL.
5. Returns the aggregate JSON.

A typical crawl takes 30–45 seconds for all 9 sites.

### API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/notices` | GET | Fetch all sites |
| `/api/notices?site=DSHE` | GET | Fetch one site (faster, useful for testing) |

### Response shape

```json
{
  "sites": {
    "DSHE": [{ "title": "...", "url": "...", "tag": "DSHE", "date": "10/12/2026", "time": "" }],
    "SHED": [...]
  },
  "updatedAt": "2026-10-13T07:32:10Z",
  "lastCrawledAt": "2026-10-13T07:32:10Z",
  "errors": [],
  "meta": {
    "DSHE": { "ok": true, "ms": 3646, "count": 10, "proxyUsed": "51.225.138.217:80" }
  },
  "totalMs": 19274,
  "proxyPoolSize": 2484
}
```

---

## Configuration

### HTML (`index.html`)

| Constant | Default | Purpose |
|---|---|---|
| `VERCEL_ENDPOINT` | `/api/notices` | API path (relative = works on any domain) |
| `POLL_MS` | `300000` | Auto-poll interval (5 min) |

### Function (`api/notices.js`)

| Constant | Default | Purpose |
|---|---|---|
| `PER_SITE_LIMIT` | `10` | Notices per site |
| `PROXY_TIMEOUT_MS` | `7000` | Per-proxy timeout |
| `INTER_SITE_GAP` | `500` | Pause between sites (ms) |

---

## Local Development

```bash
# Install dependencies
npm install

# Run locally with Vercel CLI
npx vercel dev
```

Then open `http://localhost:3000/`.

---

## Troubleshooting

**App shows "No notices yet"**
- Click **Force crawl**. The first call has to fetch proxies and crawl 9 sites — takes ~45 seconds.
- If it still fails, open the **Debug log** panel and check the `meta` output. A `✗` on a site means all proxies failed for that site; just click Force crawl again.

**Function returns 504 timeout**
- Vercel's free tier allows 60 seconds per invocation. If the crawl exceeds this (rare), retry — the proxy pool changes on every call.
- If it happens consistently, reduce `PER_SITE_LIMIT` or split the function into two endpoints.

**One tab is empty but others work**
- That site's proxy race lost the coin flip. Click **Force crawl** — a different shuffle almost always succeeds.
- Free proxies are unreliable by nature; ~1 in 10 crawls may return partial results.

**Notifications don't appear**
- Click **🔔 Enable alerts** and grant browser permission.
- Notifications only fire for notices **new since the last crawl**. On the very first crawl, everything is new, so no alerts fire — that's intentional to avoid spamming.

---

## Known Limitations

- **Free proxies** are unreliable. Expect occasional partial crawls. Retry usually fixes them.
- **Only 10 notices per site** are fetched (the latest). Older notices are not archived.
- **Vercel Hobby tier** limits: 100 GB-hrs/month of function execution, 1M invocations/month, 100 deployments/day. Comfortably enough for personal use.
- **No server-side cache.** Each request re-crawls. If the app is opened frequently, consider adding Upstash Redis for a 15-min cache.

---

## License

Personal use. Not affiliated with any government body. Respect `robots.txt` and terms of service of the source sites. This tool only reads publicly available notices.
