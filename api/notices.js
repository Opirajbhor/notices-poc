// ============================================================
// BD govt notices fetcher — combines Dhaka Board into one
// group. Robust parser for PDF-only table pages.
// ============================================================

import { ProxyAgent, fetch as undiciFetch } from 'undici';

// Five Dhaka Board sections that all feed into one "Dhaka" tab
const DHAKA_SECTIONS = [
  { id: "School",  url: "https://dhakaeducationboard.gov.bd/index.php/site/product/schoolordercircular?w=on" },
  { id: "College", url: "https://dhakaeducationboard.gov.bd/index.php/site/product/collegeordercircular?w=on" },
  { id: "JSC",     url: "https://dhakaeducationboard.gov.bd/index.php/site/product/jsccorner2?w=on" },
  { id: "SSC",     url: "https://dhakaeducationboard.gov.bd/index.php/site/product/ssccorner?w=on" },
  { id: "HSC",     url: "https://dhakaeducationboard.gov.bd/index.php/site/product/hsccorner?w=on" },
];

const SITES = [
  { tag: "DSHE",    cls: "dshe",    host: "dshe.gov.bd",    url: "https://dshe.gov.bd/pages/notices",    kind: "detail" },
  { tag: "SHED",    cls: "shed",    host: "shed.gov.bd",    url: "https://shed.gov.bd/pages/notices",    kind: "detail" },
  { tag: "BTEB",    cls: "bteb",    host: "bteb.gov.bd",    url: "https://bteb.gov.bd/pages/notices",    kind: "detail" },
  { tag: "TechEdu", cls: "techedu", host: "techedu.gov.bd", url: "https://techedu.gov.bd/pages/notices", kind: "detail" },
];

const PER_SITE_LIMIT   = 10;
const PER_DHAKA_SECTION = 10;
const PROXY_TIMEOUT_MS = 7000;
const INTER_SITE_GAP   = 400;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const t0 = Date.now();
  let proxies = [];
  try {
    proxies = await fetchBdProxies();
  } catch (e) {
    return res.status(500).json({ error: 'Proxy list fetch failed', detail: e.message });
  }
  if (!proxies.length) return res.status(500).json({ error: 'No BD proxies available' });

  const payload = {
    sites: {},
    updatedAt: new Date().toISOString(),
    lastCrawledAt: new Date().toISOString(),
    errors: [],
    meta: {},
    totalMs: 0,
    proxyPoolSize: proxies.length,
  };

  // -------- 4 primary sites --------
  for (let i = 0; i < SITES.length; i++) {
    const site = SITES[i];
    const r = await fetchSiteViaProxy(site, proxies, PER_SITE_LIMIT);
    payload.sites[site.tag] = r.notices;
    payload.meta[site.tag] = {
      ok: r.ok, ms: r.ms, count: r.notices.length,
      proxyUsed: r.proxyUsed, attempts: r.attempts,
      error: r.error || undefined,
    };
    if (r.error) payload.errors.push(`${site.tag}: ${r.error}`);
    if (i < SITES.length - 1) await sleep(INTER_SITE_GAP);
  }

  // -------- Dhaka Board: 5 sections merged into one --------
  const dhakaStart = Date.now();
  const dhakaSeen = new Set();
  const dhakaAll = [];
  const dhakaMeta = { sections: {} };

  for (let i = 0; i < DHAKA_SECTIONS.length; i++) {
    const sec = DHAKA_SECTIONS[i];
    const site = {
      tag: "Dhaka",
      cls: "dhaka",
      host: "dhakaeducationboard.gov.bd",
      url: sec.url,
      section: sec.id,
      kind: "dhaka",
    };
    const r = await fetchSiteViaProxy(site, proxies, PER_DHAKA_SECTION);
    let kept = 0;
    for (const n of r.notices) {
      if (dhakaSeen.has(n.url)) continue;
      dhakaSeen.add(n.url);
      dhakaAll.push({ ...n, section: sec.id });
      kept++;
    }
    dhakaMeta.sections[sec.id] = {
      ok: r.ok, count: kept, fetched: r.notices.length,
      ms: r.ms, error: r.error || undefined,
    };
    if (r.error) payload.errors.push(`Dhaka/${sec.id}: ${r.error}`);
    if (i < DHAKA_SECTIONS.length - 1) await sleep(INTER_SITE_GAP);
  }

  // Sort Dhaka by date descending (newest first)
  dhakaAll.sort((a, b) => {
    const da = parseAnyDate(a.date) || new Date(0);
    const db = parseAnyDate(b.date) || new Date(0);
    return db - da;
  });

  payload.sites["Dhaka"] = dhakaAll;
  payload.meta["Dhaka"] = {
    ok: dhakaAll.length > 0,
    ms: Date.now() - dhakaStart,
    count: dhakaAll.length,
    sections: dhakaMeta.sections,
  };

  payload.totalMs = Date.now() - t0;
  return res.status(200).json(payload);
}

// ============================================================
// Fetch a site via proxy race
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
      if (pass === 0) { await sleep(600); continue; }
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
            finish(reject, new Error('all proxies failed: ' + errorsOut.slice(0, 3).join('; ')));
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
// PARSER A — DSHE/SHED/BTEB/TechEdu (detail pages)
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

  // Fallback
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
// PARSER B — Dhaka Board (PDF-only tables)
// Strategy: find PDF links first, then walk back to the row
// ============================================================
function parseDhakaBoard(html, site, limit) {
  const base = new URL(site.url).origin + '/';
  const out = [];
  const seen = new Set();

  // Collect every anchor in the page
  const anchors = [];
  const aRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let am;
  while ((am = aRe.exec(html)) !== null) {
    anchors.push({ href: am[1], text: stripTags(am[2]), index: am.index });
  }

  for (const a of anchors) {
    if (out.length >= limit) break;

    // Accept PDF links or links with download-ish text
    const isPdf = /\.pdf(\?|#|$)/i.test(a.href);
    const isDownload = /(download|ডাউনলোড|দেখুন)/i.test(a.text);
    if (!isPdf && !isDownload) continue;

    let abs;
    try { abs = new URL(a.href, base).href; } catch { continue; }
    if (!abs.includes(site.host)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);

    // Find the enclosing <tr>
    const rowStart = html.lastIndexOf('<tr', a.index);
    const rowEnd = html.indexOf('</tr>', a.index);
    if (rowStart === -1 || rowEnd === -1) continue;
    const rowHtml = html.slice(rowStart, rowEnd + 5);

    // Extract text from <td> cells
    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = cellRe.exec(rowHtml)) !== null) {
      const txt = stripTags(cm[1].replace(/<a[\s\S]*?<\/a>/gi, ' '));
      if (txt) cells.push(txt);
    }

    // Title: longest cell that isn't a date or a button word
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

    // Date from any cell
    let date = '';
    for (const c of cells) {
      const dt = extractDateTime(c);
      if (dt && dt.date) { date = dt.date; break; }
    }

    out.push({
      title: title.slice(0, 220),
      url: abs,
      tag: site.tag,          // always "Dhaka"
      cls: site.cls,          // always "dhaka"
      date,
      time: '',
    });
  }

  return out;
}

// ============================================================
// Helpers
// ============================================================
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

const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function extractDateTime(raw) {
  if (!raw) return null;
  const s = bnToEn(raw);
  const dateRe = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i;
  const timeRe = /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)/;
  const dm = s.match(dateRe);
  const tm = s.match(timeRe);
  return { date: dm ? dm[1].trim() : '', time: tm ? formatTime(tm[1]) : '' };
}

function parseAnyDate(d) {
  if (!d) return null;
  const s = bnToEn(String(d)).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[2]-1, +m[1]); }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mon !== undefined) return new Date(+m[3], mon, +m[1]);
  }
  return null;
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
