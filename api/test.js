// ============================================================
// POC: Fetch a BD govt site through a free BD proxy
// Usage: /api/test?url=https://dshe.gov.bd/pages/notices
// ============================================================

import { ProxyAgent, fetch as undiciFetch } from 'undici';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const target = req.query.url || 'https://dshe.gov.bd/pages/notices';

  const t0 = Date.now();

  // -------- Step 1: get a list of BD proxies --------
  let proxies = [];
  try {
    const listRes = await fetch(
      'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=bd&ssl=all&anonymity=all'
    );
    const text = await listRes.text();
    proxies = text
      .trim()
      .split('\n')
      .map(p => p.trim())
      .filter(p => p.includes(':') && !p.startsWith('<'));
  } catch (e) {
    return res.status(500).json({
      error: 'Failed to fetch proxy list',
      detail: e.message,
    });
  }

  if (!proxies.length) {
    return res.status(500).json({
      error: 'Proxy list is empty — proxyscrape returned nothing',
    });
  }

  // -------- Step 2: try the first 8 proxies in parallel --------
  const slice = proxies.slice(0, 8);
  const attempts = await Promise.all(slice.map(p => tryProxy(p, target)));

  // -------- Step 3: report the first success --------
  const success = attempts.find(a => a.status === 200 && a.length > 5000);

  if (success) {
    return res.status(200).json({
      ok: true,
      target,
      totalMs: Date.now() - t0,
      proxyUsed: success.proxy,
      status: success.status,
      length: success.length,
      preview: success.preview,
      allAttempts: attempts.map(a => ({
        proxy: a.proxy,
        status: a.status,
        ms: a.ms,
        length: a.length,
        error: a.error,
      })),
    });
  }

  return res.status(500).json({
    ok: false,
    target,
    totalMs: Date.now() - t0,
    proxyCount: proxies.length,
    error: 'All proxies failed',
    allAttempts: attempts.map(a => ({
      proxy: a.proxy,
      status: a.status,
      ms: a.ms,
      error: a.error,
    })),
  });
}

// ------------------------------------------------------------
// Try one proxy against one URL
// ------------------------------------------------------------
async function tryProxy(proxy, target) {
  const t0 = Date.now();
  try {
    const dispatcher = new ProxyAgent(`http://${proxy}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);

    const response = await undiciFetch(target, {
      dispatcher,
      signal: controller.signal,
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
    const html = await response.text();

    return {
      proxy,
      status: response.status,
      ms: Date.now() - t0,
      length: html.length,
      preview: html.slice(0, 300),
    };
  } catch (e) {
    return {
      proxy,
      error: e.message || String(e),
      ms: Date.now() - t0,
    };
  }
}