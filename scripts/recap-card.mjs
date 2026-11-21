// scripts/recap-card.mjs — render the weekly earnings card to a PNG for the Market Intel post.
//
//   node scripts/recap-card.mjs <input.json> <out.png>
//
// input.json: { "monday": "YYYY-MM-DD", "rows": [UW upcoming-earnings rows], "stars": ["TICK", …],
//               "notes": { "YYYY-MM-DD": "Market closed · Thanksgiving" }, "headerRight": "line\nline" }
// Prints counts only (names on the card, dropped, stars): the rows are Stu's licensed UW data and
// the output goes to his private channel, never a log.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { selectRows, capStars, cardHtml } from '../lib/earningsCard.js';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node scripts/recap-card.mjs <input.json> <out.png>'); process.exit(2); }
const input = JSON.parse(readFileSync(inPath, 'utf8'));
const { rows, dropped } = selectRows(input.rows || []);
const stars = capStars(input.stars || [], rows);

// Logos: UW's logo URLs, fetched once each; a logo that fails shows the ticker instead.
const logos = {};
await Promise.all(rows.map(async (r) => {
  if (!r.logo || !/^https:\/\/storage\.googleapis\.com\/uwassets\//.test(r.logo)) return;
  try {
    const res = await fetch(r.logo, { signal: AbortSignal.timeout(10000) });
    const type = res.headers.get('content-type') || '';
    if (res.ok && type.startsWith('image/')) logos[r.ticker] = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  } catch { /* the tile shows the ticker */ }
}));

const html = cardHtml({ monday: input.monday, rows, stars, notes: input.notes || {}, headerRight: input.headerRight || '', logos });
const htmlPath = join(tmpdir(), `recap-card-${process.pid}.html`);
writeFileSync(htmlPath, html);
// The container's Playwright is global (require() resolves it; an ESM import does not).
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 800 }, deviceScaleFactor: 1 });
await page.goto(`file://${htmlPath}`);
await page.waitForTimeout(300);
await page.screenshot({ path: outPath, fullPage: true });
await browser.close();
console.log(JSON.stringify({ names: rows.length, logos: Object.keys(logos).length, dropped: dropped.length, stars: stars.length }));
