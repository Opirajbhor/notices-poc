// ============================================================
// BD govt notices fetcher — runs on Vercel, fetches through
// free Bangladeshi HTTP proxies so the request appears local.
// ============================================================

import { ProxyAgent, fetch as undiciFetch } from 'undici';

const SITES = [
  { tag: "DSHE",    cls: "dshe",    host: "dshe.gov.bd",    url: "https://dshe.gov.bd/pages/notices" },
  { tag: "SHED",    cls: "shed",    host: "shed.gov.bd",    url: "https://shed.gov.bd/pages/notices" },
  { tag: "BTEB",    cls: "bteb",    host: "bteb.gov.bd",    url: "https://bteb.gov.bd/pages/notices" },
  { tag: "TechEdu", cls: "techedu", host: "techedu.gov.bd", url: "https://techedu.gov.bd/pages/notices" },
];

const PER_SITE_LIMIT   = 10;
const PROXY_TIMEOUT_MS = 7000;
const PROXY_BATCH      = 12;   // race this many per site in parallel

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const siteFilter = req.query.site; // optional: ?site=DSHE
  const targets = siteFilter
    ? SITES.filter(s => s.tag.toLowerCase() === siteFilter.toLowerCase())
    : SITES;

  if (!targets.length) {
    return res.status(400).json({ error: `Unknown site: ${siteFilter}` });
  }

  const t0 = Date.now();

  // Fetch a fresh pool of BD proxies once
  let proxies = [];
  try {
    proxies = await fetchBdProxies();
  } catch (e) {
    return res.status(500).json({ error: 'Proxy list fetch failed', detail: e.message });
  }
  if (!proxies.length) {
    return res.status(500).json({ error: 'No BD proxies available right now' });
  }

  // Split the proxy pool evenly across the target sites so they
  // don't fight over the same proxy concurrently.
  const perSite = Math.max(4, Math.floor(proxies.length / targets.length));

  const results = await Promise.all(
    targets.map((site, i) => {
      const slice = proxies.slice(i * perSite, i * perSite + perSite);
      return fetchSiteViaProxy(site, slice);
    })
  );

  const payload = {
    sites: {},
    updatedAt: new Date().toISOString(),
    lastCrawledAt: new Date().toISOString(),
    errors: [],
    meta: {},
    totalMs: Date.now() - t0,
    proxyPoolSize: proxies.length,
  };

  for (const r of results) {
    payload.sites[r.site.tag] = r.notices;
    payload.meta[r.site.tag] = {
      ok: r.ok,
      ms: r.ms,
      count: r.notices.length,
      proxyUsed: r.proxyUsed || undefined,
      error: r.error || undefined,
    };
    if (r.error) payload.errors.push(`${r.site.tag}: ${r.error}`);
  }

  return res.status(200).json(payload);
}

// ============================================================
// Fetch a site — race through proxies, first success wins
// ============================================================
async function fetchSiteViaProxy(site, proxyList) {
  const t0 = Date.now();
  const controllers = [];
  const errors = [];

  try {
    const html = await new Promise((resolve, reject) => {
      let pending = proxyList.length;
      let settled = false;

      for (const proxy of proxyList) {
        const ctrl = new AbortController();
        controllers.push(ctrl);
        const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);

        (async () => {
          try {
            const dispatcher = new ProxyAgent(`http://${proxy}`);
            const response = await undiciFetch(site.url, {
              dispatcher,
              signal: ctrl.signal,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
              },
              redirect: 'follow',
            });

            clearTimeout(timer);
            if (!response.ok) {
              errors.push(`${proxy} HTTP ${response.status}`);
              return;
            }
            const body = await response.text();
            if (body.length < 5000) {
              errors.push(`${proxy} short ${body.length}`);
              return;
            }

            if (!settled) {
              settled = true;
              // abort remaining races
              for (const c of controllers) { try { c.abort(); } catch {} }
              resolve({ html: body, proxyUsed: proxy });
            }
          } catch (e) {
            clearTimeout(timer);
            errors.push(`${proxy} ${e.message || e}`);
          } finally {
            pending--;
            if (pending === 0 && !settled) {
              reject(new Error('all proxies failed: ' + errors.slice(0, 3).join('; ')));
            }
          }
        })();
      }

      if (!proxyList.length) reject(new Error('no proxies available'));
    });

    const notices = parseNotices(html.html, site);
    return {
      site,
      notices,
      ok: notices.length > 0,
      ms: Date.now() - t0,
      proxyUsed: html.proxyUsed,
      error: notices.length ? undefined : 'parsed 0 notices',
    };
  } catch (e) {
    return {
      site,
      notices: [],
      ok: false,
      ms: Date.now() - t0,
      error: e.message || String(e),
    };
  }
}

// ============================================================
// Fetch the current list of BD HTTP proxies
// ============================================================
async function fetchBdProxies() {
  const url =
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=bd&ssl=all&anonymity=all';
  const r = await fetch(url);
  const text = await r.text();
  const list = text
    .trim()
    .split('\n')
    .map(p => p.trim())
    .filter(p => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(p));

  // Shuffle so we don't always hit the same first few
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ============================================================
// Parser (same logic we used on the Worker)
// ============================================================
function parseNotices(html, site) {
  const base = new URL(site.url).origin + '/';
  const out = [];
  const seen = new Set();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(html)) !== null && out.length < PER_SITE_LIMIT) {
    const row = rm[1];

    let href = null;
    const linkRe = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    while ((lm = linkRe.exec(row)) !== null) {
      if (!/(notic|circular|announcement)/i.test(lm[1])) continue;
      href = lm[1];
      break;
    }
    if (!href) continue;

    let abs;
    try { abs = new URL(href, base).href; } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);

    const rowNoLinks = row.replace(/<a[\s\S]*?<\/a>/gi, ' ');
    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = cellRe.exec(rowNoLinks)) !== null) cells.push(stripTags(cm[1]));

    const cands = cells.filter(c =>
      c.length > 5 &&
      !/^[\d\s.\-\/০-৯]+$/.test(c) &&
      !/^(দেখুন|ডাউনলোড|Download|View|ইমেজ|ফাইল সমূহ|কার্যকলাপ|প্রকাশের তারিখ)$/i.test(c)
    );
    cands.sort((a, b) => b.length - a.length);
    const title = cands[0];
    if (!title || title.length < 4) continue;

    let date = '', time = '';
    for (const c of cells) {
      const dt = extractDateTime(c);
      if (dt && dt.date) { date = dt.date; time = dt.time; break; }
    }

    out.push({
      title: title.slice(0, 220),
      url: abs,
      tag: site.tag,
      cls: site.cls,
      date, time,
    });
  }

  // Fallback: scan all anchors
  if (!out.length) {
    const aRe = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(html)) !== null && out.length < PER_SITE_LIMIT) {
      if (!/(notic|circular|announcement)/i.test(am[1])) continue;
      const text = stripTags(am[2]);
      if (!text || text.length < 6) continue;
      let abs;
      try { abs = new URL(am[1], base).href; } catch { continue; }
      if (!abs.includes(site.host) || seen.has(abs)) continue;
      seen.add(abs);
      const dt = extractDateTime(text);
      out.push({
        title: text.replace(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}.*$/, '').trim().slice(0, 220),
        url: abs, tag: site.tag, cls: site.cls,
        date: dt?.date || '', time: dt?.time || '',
      });
    }
  }

  return out;
}

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const BN_DIGITS = { '০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9' };
function bnToEn(s) { return String(s).replace(/[০-৯]/g, d => BN_DIGITS[d]); }

function extractDateTime(raw) {
  if (!raw) return null;
  const s = bnToEn(raw);
  const dateRe = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}-\d{2}-\d{2})/;
  const timeRe = /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)/;
  const dm = s.match(dateRe);
  const tm = s.match(timeRe);
  return { date: dm ? dm[1] : '', time: tm ? formatTime(tm[1]) : '' };
}

function formatTime(t) {
  if (!t) return '';
  t = t.trim();
  if (/am|pm/i.test(t)) return t.replace(/\s+/g, ' ').toUpperCase();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}
