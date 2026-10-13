// ============================================================
// BD govt notices fetcher — streaming NDJSON response
// Each site's notices are sent as soon as they're ready.
// ============================================================

import { ProxyAgent, fetch as undiciFetch } from 'undici';

// Fetch order — most important first so the user sees results quickly
const FETCH_ORDER = [
  { tag: "DSHE",  cls: "dshe",  kind: "detail", host: "dshe.gov.bd",
    url: "https://dshe.gov.bd/pages/notices" },
  { tag: "SHED",  cls: "shed",  kind: "detail", host: "shed.gov.bd",
    url: "https://shed.gov.bd/pages/notices" },
  { tag: "Dhaka", cls: "dhaka", kind: "dhaka", section: "School", host: "dhakaeducationboard.gov.bd",
    url: "https://dhakaeducationboard.gov.bd/index.php/site/product/schoolordercircular?w=on" },
  { tag: "BTEB",  cls: "bteb",  kind: "detail", host: "bteb.gov.bd",
    url: "https://bteb.gov.bd/pages/notices" },
  { tag: "Dhaka", cls: "dhaka", kind: "dhaka", section: "College", host: "dhakaeducationboard.gov.bd",
    url: "https://dhakaeducationboard.gov.bd/index.php/site/product/collegeordercircular?w=on" },
  { tag: "TechEdu", cls: "techedu", kind: "detail", host: "techedu.gov.bd",
    url: "https://techedu.gov.bd/pages/notices" },
  { tag: "Dhaka", cls: "dhaka", kind: "dhaka", section: "SSC", host: "dhakaeducationboard.gov.bd",
    url: "https://dhakaeducationboard.gov.bd/index.php/site/product/ssccorner?w=on" },
  { tag: "Dhaka", cls: "dhaka", kind: "dhaka", section: "HSC", host: "dhakaeducationboard.gov.bd",
    url: "https://dhakaeducationboard.gov.bd/index.php/site/product/hsccorner?w=on" },
  { tag: "Dhaka", cls: "dhaka", kind: "dhaka", section: "JSC", host: "dhakaeducationboard.gov.bd",
    url: "https://dhakaeducationboard.gov.bd/index.php/site/product/jsccorner2?w=on" },
];

const PER_SITE_LIMIT   = 10;
const PROXY_TIMEOUT_MS = 7000;
const INTER_SITE_GAP   = 300;

// Module-scope proxy cache — reused across calls in the same warm container
let proxyCache = { list: [], fetchedAt: 0 };
const PROXY_TTL_MS = 4 * 60 * 1000;

async function getProxies() {
  if (proxyCache.list.length && (Date.now() - proxyCache.fetchedAt) < PROXY_TTL_MS) {
    return proxyCache.list;
  }
  const list = await fetchBdProxies();
  proxyCache = { list, fetchedAt: Date.now() };
  return list;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ---------- Single-site mode (JSON) ----------
  if (req.query.site) {
    const site = FETCH_ORDER.find(s => s.tag.toLowerCase() === req.query.site.toLowerCase());
    if (!site) return res.status(400).json({ error: 'unknown site' });
    let proxies = [];
    try { proxies = await getProxies(); } catch (e) {
      return res.status(500).json({ error: 'proxy fetch failed' });
    }
    const r = await fetchSiteViaProxy(site, proxies, PER_SITE_LIMIT);
    return res.status(200).json({
      tag: site.tag, notices: r.notices, ms: r.ms, error: r.error,
    });
  }

  // ---------- Streaming mode (NDJSON) ----------
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  let proxies = [];
  try {
    proxies = await getProxies();
  } catch (e) {
    res.write(JSON.stringify({ type: 'error', error: 'proxy fetch failed: ' + e.message }) + '\n');
    return res.end();
  }

  res.write(JSON.stringify({
    type: 'start',
    startedAt: new Date().toISOString(),
    proxyPoolSize: proxies.length,
  }) + '\n');

  const dhakaSeen = new Set();
  const t0 = Date.now();

  for (let i = 0; i < FETCH_ORDER.length; i++) {
    const item = FETCH_ORDER[i];
    const r = await fetchSiteViaProxy(item, proxies, PER_SITE_LIMIT);

    let notices = r.notices;
    // Dedup Dhaka across its 5 subsections
    if (item.tag === 'Dhaka') {
      notices = notices.filter(n => {
        if (dhakaSeen.has(n.url)) return false;
        dhakaSeen.add(n.url);
        return true;
      });
    }

    // Attach section to Dhaka notices
    if (item.tag === 'Dhaka') {
      notices = notices.map(n => ({ ...n, section: item.section }));
    }

    res.write(JSON.stringify({
      type: 'site',
      tag: item.tag,
      cls: item.cls,
      section: item.section || null,
      notices,
      ms: r.ms,
      ok: r.ok,
      error: r.error || null,
    }) + '\n');

    if (i < FETCH_ORDER.length - 1) await sleep(INTER_SITE_GAP);
  }

  res.write(JSON.stringify({
    type: 'done',
    updatedAt: new Date().toISOString(),
    totalMs: Date.now() - t0,
  }) + '\n');
  res.end();
}

// ============================================================
async function fetchSiteViaProxy(site, proxyList, limit) {
  const t0 = Date.now();
  let totalAttempts = 0;
  for (let pass = 0; pass < 2; pass++) {
    const shuffled = shuffle([...proxyList]);
    const errors = [];
    try {
      const result = await raceProxies(site, shuffled, errors, limit);
      totalAttempts += shuffled.length;
      return {
        notices: result.notices,
        ok: result.notices.length > 0,
        ms: Date.now() - t0,
        proxyUsed: result.proxyUsed,
        attempts: totalAttempts,
        error: result.notices.length ? undefined : 'parsed 0 notices',
      };
    } catch (e) {
      totalAttempts += shuffled.length;
      if (pass === 0) { await sleep(500); continue; }
      return {
        notices: [], ok: false, ms: Date.now() - t0,
        attempts: totalAttempts, error: e.message || String(e),
      };
    }
  }
  return { notices: [], ok: false, ms: Date.now() - t0, attempts: totalAttempts, error: 'exhausted retries' };
}

function raceProxies(site, proxies, errorsOut, limit) {
  return new Promise((resolve, reject) => {
    let pending = proxies.length;
    let settled = false;
    const controllers = [];
    if (!pending) return reject(new Error('no proxies available'));

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      for (const c of controllers) { try { c.abort(); } catch {} }
      fn(val);
    };

    for (const proxy of proxies) {
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
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
            },
            redirect: 'follow',
          });
          clearTimeout(timer);
          if (!response.ok) { errorsOut.push(`${proxy} HTTP ${response.status}`); return; }
          const body = await response.text();
          if (body.length < 3000) { errorsOut.push(`${proxy} short ${body.length}`); return; }
          const notices = site.kind === "dhaka"
            ? parseDhakaBoard(body, site, limit)
            : parseDetailPage(body, site, limit);
          if (notices.length) {
            finish(resolve, { notices, proxyUsed: proxy });
          } else {
            errorsOut.push(`${proxy} parsed 0`);
          }
        } catch (e) {
          clearTimeout(timer);
          errorsOut.push(`${proxy} ${e.message || e}`);
        } finally {
          pending--;
          if (pending === 0 && !settled) {
            finish(reject, new Error('all proxies failed'));
          }
        }
      })();
    }
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchBdProxies() {
  const sources = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=bd&ssl=all&anonymity=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  ];
  const all = new Set();
  for (const url of sources) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const text = await r.text();
      for (const line of text.split('\n')) {
        const p = line.trim();
        if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(p)) all.add(p);
      }
    } catch {}
  }
  return [...all];
}

// ============================================================
// Detail-page parser (DSHE, SHED, BTEB, TechEdu)
// ============================================================
function parseDetailPage(html, site, limit) {
  const base = new URL(site.url).origin + '/';
  const out = [];
  const seen = new Set();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(html)) !== null && out.length < limit) {
    const row = rm[1];
    let href = null;
    const linkRe = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    while ((lm = linkRe.exec(row)) !== null) {
      if (/(notic|circular|announcement)/i.test(lm[1])) { href = lm[1]; break; }
    }
    if (!href) continue;

    let abs;
    try { abs = new URL(href, base).href; } catch { continue; }
    if (!abs.includes(site.host) || seen.has(abs)) continue;
    seen.add(abs);

    const rowNoLinks = row.replace(/<a[\s\S]*?<\/a>/gi, ' ');
    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = cellRe.exec(rowNoLinks)) !== null) cells.push(stripTags(cm[1]));

    const cands = cells.filter(c =>
      c.length > 5 &&
      !/^[\d\s.\-\/০-৯]+$/.test(c) &&
      !/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(c) &&
      !/^\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}$/i.test(c) &&
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
    out.push({ title: title.slice(0, 220), url: abs, tag: site.tag, cls: site.cls, date, time });
  }

  if (!out.length) {
    const aRe = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(html)) !== null && out.length < limit) {
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

// ============================================================
// Dhaka Board parser (PDF-only)
// ============================================================
function parseDhakaBoard(html, site, limit) {
  const base = new URL(site.url).origin + '/';
  const out = [];
  const seen = new Set();

  const anchors = [];
  const aRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let am;
  while ((am = aRe.exec(html)) !== null) {
    anchors.push({ href: am[1], text: stripTags(am[2]), index: am.index });
  }

  for (const a of anchors) {
    if (out.length >= limit) break;
    const isPdf = /\.pdf(\?|#|$)/i.test(a.href);
    const isDownload = /(download|ডাউনলোড)/i.test(a.text);
    if (!isPdf && !isDownload) continue;

    let abs;
    try { abs = new URL(a.href, base).href; } catch { continue; }
    if (!abs.includes(site.host)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);

    const rowStart = html.lastIndexOf('<tr', a.index);
    const rowEnd = html.indexOf('</tr>', a.index);
    if (rowStart === -1 || rowEnd === -1) continue;
    const rowHtml = html.slice(rowStart, rowEnd + 5);

    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = cellRe.exec(rowHtml)) !== null) {
      const txt = stripTags(cm[1].replace(/<a[\s\S]*?<\/a>/gi, ' '));
      if (txt) cells.push(txt);
    }

    const cands = cells.filter(c =>
      c.length > 5 &&
      !/^[\d\s.\-\/০-৯]+$/.test(c) &&
      !/^\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}$/i.test(c) &&
      !/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(c) &&
      !/^(ডাউনলোড|Download|বিষয়|সর্বশেষ হালনাগাদ)$/i.test(c)
    );
    cands.sort((a, b) => b.length - a.length);
    const title = cands[0];
    if (!title || title.length < 4) continue;

    let date = '';
    for (const c of cells) {
      const dt = extractDateTime(c);
      if (dt && dt.date) { date = dt.date; break; }
    }

    out.push({
      title: title.slice(0, 220),
      url: abs,
      tag: "Dhaka",
      cls: "dhaka",
      date, time: '',
    });
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
  const dateRe = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i;
  const timeRe = /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)/;
  const dm = s.match(dateRe);
  const tm = s.match(timeRe);
  return { date: dm ? dm[1].trim() : '', time: tm ? formatTime(tm[1]) : '' };
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
