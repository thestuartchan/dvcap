// /api/scrape-7709 — daily headless scrape of the CSOP SK Hynix Daily (2x) Leveraged
// Product (7709.HK) fund page for UNITS OUTSTANDING, the real deleveraging tell.
//
// Why headless: the authoritative CSOP page and HKEX are both behind bot-walls
// (HTTP 403 to plain fetch), and no keyless feed carries units for this ETF. A real
// browser (puppeteer-core + @sparticuz/chromium) renders the page and reads the
// number. See data/korea_7709.json (the maintained series this appends to) and
// lib/regime.js → etfUnitsRead (which consumes the series).
//
// Persistence: Vercel's filesystem is read-only, so this commits the new row back to
// data/korea_7709.json via the GitHub contents API. The Asia pre-read reads that file
// (static import). Scheduled at 00:30 UTC (08:30 HKT), before the 01:00 UTC pre-read,
// so the redeploy the commit triggers is ready in time.
//
// Manual/debug: GET /api/scrape-7709?dry=1  → scrape only, no commit (eyeball the number).
//               GET /api/scrape-7709        → scrape + commit (what the cron calls).

const CSOP_URL = 'https://www.csopasset.com/en/products/hk-skhy-2l';
const DATA_PATH = 'data/korea_7709.json';

// ---- number parsing: "202,345,678 Units", "HKD 64.62", "13.07 billion" ----
function parseNum(s) {
  if (s == null) return null;
  let str = String(s).trim();
  const mult = /billion|bn|\bB\b/i.test(str) ? 1e9
             : /million|\bmn\b|\bM\b/i.test(str) ? 1e6
             : 1;
  const n = parseFloat(str.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n * mult : null;
}

// ---- HK-local date (the fund page reports on the HK trading calendar) ----
function hkDate(d = new Date()) {
  // en-CA → YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(d);
}

// ---- pure merge: append entry if its date isn't already present, keep chrono ----
// Exported for local unit tests (no network / no browser).
export function mergeSeries(existing, entry) {
  const arr = Array.isArray(existing) ? existing.slice() : [];
  if (arr.some(e => e && e.date === entry.date)) {
    return { changed: false, series: arr, reason: 'date already recorded' };
  }
  arr.push(entry);
  arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { changed: true, series: arr, reason: 'appended' };
}

// ---- headless scrape → { units, nav, aum, source } ----
async function scrapeCsop() {
  // Dynamic imports so the module loads (and mergeSeries is testable) even where the
  // heavy browser deps aren't installed (e.g. local Windows dev).
  const chromium = (await import('@sparticuz/chromium')).default;
  const puppeteer = (await import('puppeteer-core')).default;

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
  try {
    const page = await browser.newPage();
    // Present as a normal desktop browser; the bot-wall keys partly on this.
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(CSOP_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    // Fund figures often load via XHR after first paint — give them a beat, and try
    // to wait until the NAV label is present.
    await page.waitForFunction(
      () => /nav|net asset value|units|fund size/i.test(document.body.innerText),
      { timeout: 15000 },
    ).catch(() => {});

    // Pull labeled figures out of the rendered text. Regex over innerText is far more
    // resilient to CSS/DOM churn than brittle selectors — the labels change rarely.
    const text = await page.evaluate(() => document.body.innerText);

    const grab = (labels) => {
      for (const label of labels) {
        // label ... number (allow currency/commas, up to a few chars of separators)
        const re = new RegExp(label + '[^0-9]{0,40}([0-9][0-9,\\.]*\\s*(?:billion|bn|million|mn)?)', 'i');
        const m = text.match(re);
        if (m) return m[1];
      }
      return null;
    };

    const unitsRaw = grab(['units\\s*outstanding', 'units\\s*in\\s*issue', 'outstanding\\s*units', 'units\\s*issued', 'number\\s*of\\s*units']);
    const navRaw   = grab(['nav\\s*per\\s*unit', 'net\\s*asset\\s*value\\s*per\\s*unit', 'nav\\b']);
    const aumRaw   = grab(['fund\\s*size', 'assets?\\s*under\\s*management', 'total\\s*net\\s*asset\\s*value', 'net\\s*assets']);

    let units = parseNum(unitsRaw);
    const nav = parseNum(navRaw);
    const aum = parseNum(aumRaw);
    let source = 'csop-headless';

    // Fallback: if the explicit units label wasn't found but AUM & NAV were, derive
    // units = AUM / NAV from the SAME authoritative page (more accurate than a
    // cross-source estimate). Flag it so downstream can see it's derived.
    if ((units == null || units <= 0) && aum && nav) {
      units = Math.round(aum / nav);
      source = 'csop-headless-derived(aum/nav)';
    }

    return { units, nav, aum, source, foundLabels: { unitsRaw, navRaw, aumRaw }, text };
  } finally {
    await browser.close();
  }
}

// ---- GitHub commit-back of the appended series ----
async function commitSeries(series, message) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;               // "owner/name"
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) {
    return { committed: false, reason: 'GITHUB_TOKEN / GITHUB_REPO not set' };
  }
  const api = `https://api.github.com/repos/${repo}/contents/${DATA_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dvcap-macro-scrape-7709',
  };
  // Need the current file sha to update it.
  const getR = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
  if (!getR.ok) return { committed: false, reason: `GitHub GET ${getR.status}` };
  const meta = await getR.json();
  const content = Buffer.from(JSON.stringify(series, null, 2) + '\n', 'utf8').toString('base64');
  const putR = await fetch(api, {
    method: 'PUT', headers,
    body: JSON.stringify({ message, content, sha: meta.sha, branch }),
  });
  if (!putR.ok) return { committed: false, reason: `GitHub PUT ${putR.status}` };
  return { committed: true };
}

async function readSeries() {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return [];
  const api = `https://api.github.com/repos/${repo}/contents/${DATA_PATH}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(api, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'dvcap-macro-scrape-7709' },
  });
  if (!r.ok) return [];
  try { return JSON.parse(await r.text()); } catch { return []; }
}

export default async function handler(req, res) {
  const dry   = req.query.dry === '1';
  const debug = req.query.debug === '1';
  try {
    const scraped = await scrapeCsop();

    // Debug: dump the FULL rendered page text + matched labels, no commit. Use this to
    // tune the label regexes in scrapeCsop() against what CSOP actually renders.
    if (debug) {
      const { text, foundLabels, units, nav, aum, source } = scraped;
      return res.status(200).json({
        ok: true, debug: true,
        parsed: { units, nav, aum, source }, foundLabels,
        textLength: text?.length ?? 0, text,
      });
    }

    if (scraped.units == null || scraped.units <= 0) {
      // Couldn't find the number — return the diagnostics so selectors can be tuned.
      console.error('scrape-7709: units not found', JSON.stringify(scraped.foundLabels));
      const { text, ...rest } = scraped;
      return res.status(502).json({ ok: false, error: 'units not found on page',
        ...rest, textSample: text?.slice(0, 800), hint: 'add ?debug=1 for the full page text' });
    }

    const entry = {
      date: hkDate(),
      units: scraped.units,
      nav: scraped.nav ?? null,
      aum: scraped.aum ?? null,
      source: scraped.source,
    };

    if (dry) {
      return res.status(200).json({ ok: true, dry: true, entry });
    }

    const existing = await readSeries();
    const { changed, series, reason } = mergeSeries(existing, entry);
    if (!changed) {
      return res.status(200).json({ ok: true, committed: false, reason, entry });
    }
    const commit = await commitSeries(series, `chore(korea): 7709 units ${entry.date} = ${entry.units.toLocaleString('en-US')}`);
    return res.status(commit.committed ? 200 : 500).json({ ok: commit.committed, entry, ...commit, points: series.length });
  } catch (e) {
    console.error('scrape-7709 error:', e?.message);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
