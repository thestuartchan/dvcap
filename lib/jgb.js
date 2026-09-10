// lib/jgb.js — the Japanese government bond curve, from the ministry that issues it.
//
// ── WHY THIS SOURCE ──────────────────────────────────────────────────────────
// The Asia brief lists the Nikkei among four indices and holds SoftBank, Advantest, Recruit and
// Nintendo on its watchlist, and its rates line quoted the US 2s, 10s and 30s and nothing else.
// Japan is a rates story in its own right and the board could not see it.
//
// There is no free JGB YIELD feed on the quote provider this board already uses: ^JP10Y,
// JP10YT=RR and JGB10Y.TO all miss, and the only thing that does come back is a bond-ETF PRICE —
// a proxy wearing a yield's job, which is the substitution this codebase refuses everywhere else.
//
// The Ministry of Finance publishes the whole curve daily, free and keyless, and it is the
// authoritative print rather than anyone's derivation of it. Two things about the file are
// load-bearing:
//
//   IT IS SHIFT-JIS, not UTF-8. Decoded as UTF-8 the header and the date column are mojibake and
//   a lenient parser would read the columns by position and silently mis-map the tenors.
//
//   THE DATES ARE JAPANESE-ERA. "R8.9.9" is Reiwa 8, the ninth of September — 2026-09-09. Read as
//   a Gregorian year that is 2008, which is not a plausible date and so is worth asserting rather
//   than hoping: a curve dated eighteen years ago must not reach a brief.
export const JGB_URL = 'https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv';
export const JGB_TIMEOUT_MS = 12000;
// Reiwa began on 2019-05-01, so Reiwa 1 is 2019 and Reiwa N is 2018 + N.
export const REIWA_EPOCH = 2018;
// The tenors the brief quotes. The file carries sixteen; a rates line does not.
export const JGB_TENORS = Object.freeze(['2年', '10年', '30年']);
export const TENOR_LABEL = Object.freeze({ '2年': '2yr', '10年': '10yr', '20年': '20yr', '30年': '30yr', '40年': '40yr' });

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};

// "R8.9.9" → "2026-09-09". Returns null on anything that is not an era date, so a footer row or a
// blank line cannot become a curve.
export function parseEraDate(s) {
  const m = /^([RHS])(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  // Only Reiwa is wired: Heisei ended in 2019 and a Heisei-dated row in today's file would mean
  // something is wrong with the fetch, not that the curve is thirty years old.
  if (m[1] !== 'R') return null;
  const y = REIWA_EPOCH + Number(m[2]);
  const mo = String(Number(m[3])).padStart(2, '0'), d = String(Number(m[4])).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function parseJgbCsv(bytes) {
  let text;
  try {
    text = new TextDecoder('shift_jis', { fatal: false }).decode(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    return null;   // no Shift-JIS decoder — better to have no curve than a mis-mapped one
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // The header is the row whose first cell is the base-date column. Found by content, not by
  // index: the file opens with a title row whose shape has changed before.
  const hdrIdx = lines.findIndex(l => /^基準日,/.test(l));
  if (hdrIdx < 0) return null;
  const head = lines[hdrIdx].split(',').map(c => c.trim());
  const rows = [];
  for (const line of lines.slice(hdrIdx + 1)) {
    const cells = line.split(',').map(c => c.trim());
    const date = parseEraDate(cells[0]);
    if (!date) continue;
    const curve = {};
    for (let i = 1; i < head.length; i++) {
      const v = num(cells[i]);
      if (v != null && head[i]) curve[head[i]] = v;
    }
    if (Object.keys(curve).length) rows.push({ date, curve });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, latest: rows[rows.length - 1], tenors: head.slice(1).filter(Boolean) };
}

// The shape the rest of the board consumes: one field per tenor, each carrying its own date so
// lib/vintage.js can age it exactly as it ages a FRED series.
export function jgbFields(parsed) {
  if (!parsed?.latest) return null;
  const { date, curve } = parsed.latest;
  const prior = parsed.rows.length > 1 ? parsed.rows[parsed.rows.length - 2] : null;
  const out = { date, source: 'Japan MoF daily JGB curve' };
  // ONLY THE LABELLED TENORS. The file carries sixteen and the untranslated keys are Japanese
  // strings; letting them through would put 「4年」 into the API payload and into anything that
  // iterates it, for no reader's benefit.
  for (const t of parsed.tenors) {
    const v = curve[t];
    if (v == null || !TENOR_LABEL[t]) continue;
    const p = prior?.curve?.[t] ?? null;
    out[TENOR_LABEL[t]] = {
      value: v, date, name: `JGB ${TENOR_LABEL[t]}`, src: 'MoF jgbcm.csv', cadence: 'daily',
      prev: p, prevDate: prior?.date ?? null,
      deltaBps: p != null ? Math.round((v - p) * 100) : null,
    };
  }
  return out;
}

// WARN AND RETURN NULL, NEVER BLOCK — the same rule every other optional feed here runs on.
export async function fetchJgb({ timeoutMs = JGB_TIMEOUT_MS } = {}) {
  try {
    const r = await fetch(JGB_URL, {
      headers: { Accept: 'text/csv,*/*', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`MoF answered ${r.status}`);
    const parsed = parseJgbCsv(new Uint8Array(await r.arrayBuffer()));
    if (!parsed) throw new Error('JGB payload had no parseable curve');
    return jgbFields(parsed);
  } catch (e) {
    console.warn('[jgb] MoF curve unavailable — the Japan leg will be absent:', e?.message || e);
    return null;
  }
}
