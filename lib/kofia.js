// kofia.js — parse the KOFIA summary blob (copied from freesis.kofia.or.kr) into
// structured Korea-gate fields. Shared by the dashboard preview (client) and the
// save endpoint (server) so the parse + validation are identical.
//
// One entry = 3 lines:
//   * [{KOREAN_LABEL}]({url})
//   {UNIT} | {MM/DD}
//   {BALANCE} {DELTA} {PCT}%
// Match by KOREAN label; map to an English display + field key + role. Unmapped
// labels (주식형펀드 순자산 etc.) are ignored.

export const KOFIA_LABELS = {
  '신용융자':         { key: 'marginLoans', display: 'Margin Loans (신용융자)',        role: 'gate'  },
  '투자자예탁금':     { key: 'deposits',    display: 'Investor Deposits (투자자예탁금)', role: 'gate'  },
  'CMA잔고':          { key: 'cma',         display: 'CMA Balance (CMA잔고)',           role: 'gate'  },
  'KOSPI지수':        { key: 'kospi',       display: 'KOSPI (KOSPI지수)',               role: 'index' },
  '국고채(3년)':      { key: 'kr3yGovt',    display: 'KR 3Y Govt (국고채 3년)',          role: 'macro' },
  '회사채(3년, AA-)': { key: 'kr3yCorp',    display: 'KR 3Y Corp AA− (회사채 3년)',      role: 'macro' },
};
export const KOFIA_CURRENCY = ['marginLoans', 'deposits', 'cma'];

// Korean currency units → divisor to canonical ₩ TRILLIONS. The sources genuinely differ:
// the KOFIA panel prints 백만원 (millions) while the KRX 투자자별 매매동향 flow table prints
// 십억원 (billions) — a 1,000× difference. Detect per field; NEVER hardcode one unit across
// sources (foreign net −2,645 십억원 is −₩2.645T, not −₩2,645M).
export const WON_UNIT_DIV = {
  '백만원': 1e6,   // millions        → ₩T
  '십억원': 1e3,   // billions        → ₩T
  '억원':   1e4,   // hundred-millions→ ₩T
  '조원':   1,     // trillions       → ₩T (already canonical)
};
export function unitDivisor(unit) {
  return Object.prototype.hasOwnProperty.call(WON_UNIT_DIV, String(unit).trim())
    ? WON_UNIT_DIV[String(unit).trim()] : null;
}

// Thousands separators, preserving natural decimals. Passes through non-numbers/"—".
export function withCommas(n) {
  if (n == null || n === '—') return n;
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 6 }) : n;
}

// Business days between a YYYY-MM-DD and today (UTC) — weekend-tolerant so Friday's data
// isn't flagged "stale" on Monday. Manual Korea fields are stale beyond 2 business days.
function bizDaysAgo(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let n = 0;
  while (d < end) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
  return n;
}
export function kofiaStale(asOf, now = new Date()) {
  const bd = bizDaysAgo(asOf, now);
  return bd != null && bd > 2;
}

// MM/DD → YYYY-MM-DD using the CURRENT year; roll back a year if that lands in the future.
// NEVER defaults to today. `now` is injectable for testing.
export function resolveKofiaDate(mmdd, now = new Date()) {
  const m = String(mmdd || '').match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!m) return null;
  const mo = String(+m[1]).padStart(2, '0');
  const da = String(+m[2]).padStart(2, '0');
  const y = now.getUTCFullYear();
  const iso = `${y}-${mo}-${da}`;
  return new Date(iso + 'T00:00:00Z') > now ? `${y - 1}-${mo}-${da}` : iso;
}

// Strip commas, normalize the Unicode minus (U+2212) to ASCII, parse to Number.
function num(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/−/g, '-').replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Currency → canonical ₩T using the DETECTED unit. Returns null on an unrecognized unit
// rather than silently assuming 백만원 — a wrong assumption here is a 1,000× error that
// still looks plausible on screen, which is exactly the failure mode we're guarding.
export function toWonTrillions(rawValue, unit) {
  if (rawValue == null) return null;
  const div = unitDivisor(unit);
  return div == null ? null : rawValue / div;
}

// Magnitude sanity: a converted value more than `factor`× away from its own prior stored
// value is almost always a mis-detected unit (1,000× / 10,000× jumps), not a real move.
// Returns null when there's nothing to compare or the move is plausible.
export function unitSanity(canonNew, canonPrior, factor = 1000) {
  if (canonNew == null || canonPrior == null) return null;
  if (canonNew === 0 || canonPrior === 0) return null;
  const ratio = Math.abs(canonNew) / Math.abs(canonPrior);
  if (ratio >= factor || ratio <= 1 / factor) {
    return `⚠ unit check — ${canonNew.toFixed(4)}₩T vs prior ${canonPrior.toFixed(4)}₩T (${ratio >= factor ? ratio.toFixed(0) + '×' : '1/' + (1 / ratio).toFixed(0) + '×'})`;
  }
  return null;
}

// Human display for a parsed field.
export function kofiaDisplay(f) {
  if (KOFIA_CURRENCY.includes(f.key)) {
    const t = toWonTrillions(f.balance, f.unit);
    const dt = toWonTrillions(f.delta, f.unit);
    if (t == null) return `⚠ unrecognized unit "${f.unit}" — not converted`;
    return `₩${t.toFixed(2)}T${dt != null ? ` · Δ ${dt >= 0 ? '+' : '−'}₩${Math.abs(dt).toFixed(2)}T (${f.pct >= 0 ? '+' : ''}${f.pct}%)` : ''}`;
  }
  if (KOFIA_FLOWS.includes(f.key)) {
    const t = toWonTrillions(f.balance, f.unit);
    return `${f.balance >= 0 ? '+' : ''}${Number(f.balance).toLocaleString('en-US')} ₩bn${t != null ? ` (₩${t >= 0 ? '+' : '−'}${Math.abs(t).toFixed(2)}T)` : ''}`;
  }
  if (f.unit === '%') return `${f.balance}%${f.delta != null ? ` (${f.delta >= 0 ? '+' : ''}${f.delta})` : ''}`;
  return `${f.balance?.toLocaleString('en-US')}${f.delta != null ? ` (${f.delta >= 0 ? '+' : ''}${f.delta})` : ''}`;
}

// Display name per field key (for the stored latest values).
export const KOFIA_NAME_BY_KEY = Object.fromEntries(
  Object.values(KOFIA_LABELS).map(m => [m.key, m.display])
);
KOFIA_NAME_BY_KEY.units7709 = 'CSOP 7709 units';
KOFIA_NAME_BY_KEY.foreignNet = 'Foreign Net (₩bn)';
KOFIA_NAME_BY_KEY.instNet = 'Institutional Net (₩bn)';
KOFIA_NAME_BY_KEY.retailNet = 'Retail Net (₩bn)';
// Flow keys share the 십억원 unit and are daily nets (not balances) — kept separate from
// KOFIA_CURRENCY, whose rows are 백만원 balances carrying delta/pct.
export const KOFIA_FLOWS = ['foreignNet', 'instNet', 'retailNet'];

// Format a STORED latest entry ({ value, unit, asOf, delta, pct }) → one display string.
// Currency → ₩T; yields → %; 7709 → millions of units; KOSPI → points. asOf appended.
export function kofiaStoredLine(key, e) {
  if (!e || e.value == null) return null;
  const dt = e.asOf ? ` · ${e.asOf.slice(5)}${kofiaStale(e.asOf) ? ' ⚠stale' : ''}` : '';
  if (KOFIA_CURRENCY.includes(key)) {
    const t = toWonTrillions(e.value, e.unit);
    const d = e.delta != null ? toWonTrillions(e.delta, e.unit) : null;
    if (t == null) return `⚠ unrecognized unit "${e.unit}"${dt}`;
    return `₩${t.toFixed(2)}T${d != null ? ` ${d >= 0 ? '+' : '−'}₩${Math.abs(d).toFixed(2)}T (${e.pct >= 0 ? '+' : ''}${e.pct}%)` : ''}${dt}`;
  }
  if (key === 'units7709') return `${(e.value / 1e6).toFixed(1)}M${e.delta != null ? ` (${e.delta >= 0 ? '+' : ''}${(e.delta / 1e6).toFixed(1)}M)` : ''}${dt}`;
  if (KOFIA_FLOWS.includes(key)) {
    const t = toWonTrillions(e.value, e.unit);
    return `${e.value >= 0 ? '+' : ''}${Number(e.value).toLocaleString('en-US')} ₩bn${t != null ? ` (₩${t >= 0 ? '+' : '−'}${Math.abs(t).toFixed(2)}T)` : ''}${dt}`;
  }
  if (e.unit === '%') return `${e.value}%${dt}`;
  return `${Number(e.value).toLocaleString('en-US')}${dt}`;
}

// A label line may be bare ("KOSPI지수" — what a plain textarea gets when the KOFIA site's
// rich-text links are flattened on paste), a markdown link ("* [KOSPI지수](url)"), or a
// bullet. Extract the label from brackets if present, else strip a leading bullet.
function labelOf(line) {
  const m = line.match(/\[([^\]]+)\]/);
  return (m ? m[1] : line.replace(/^[*\-•]\s*/, '')).trim();
}

// Concise plain-English read of the Korea gate from the stored latest values — flows
// (de-risking vs flight), leverage (margin loans), and investor cash (deposits).
export function koreaFlowRead(latest) {
  if (!latest) return null;
  const f = latest.foreignNet?.value, i = latest.instNet?.value;
  const ml = latest.marginLoans?.pct, dep = latest.deposits?.pct;
  // Convert with each entry's OWN detected unit rather than a hardcoded divisor — flows are
  // 십억원 while the panel balances are 백만원. (Interpretation incl. 개인/retail: Stage 4.)
  const tOf = k => { const e = latest[k]; const v = toWonTrillions(e?.value, e?.unit);
    return v == null ? `${e?.value ?? '—'} (unit?)` : `₩${Math.abs(v).toFixed(1)}T`; };
  const t = (_v, k) => tOf(k);
  const st = k => kofiaStale(latest[k]?.asOf) ? ` ⚠stale(${latest[k].asOf.slice(5)})` : '';  // per-input
  const parts = [];
  if (f != null && i != null) {
    if (f > 0 && i > 0)      parts.push(`Foreign +${t(f, 'foreignNet')}${st('foreignNet')} & institutions +${t(i, 'instNet')}${st('instNet')} — both net buyers (accumulation, not flight)`);
    else if (f < 0 && i < 0) parts.push(`Foreign −${t(f, 'foreignNet')}${st('foreignNet')} & institutions −${t(i, 'instNet')}${st('instNet')} — both net sellers (broad de-risking)`);
    else                     parts.push(`Foreign ${f >= 0 ? '+' : '−'}${t(f, 'foreignNet')}${st('foreignNet')}, institutions ${i >= 0 ? '+' : '−'}${t(i, 'instNet')}${st('instNet')} — split flows`);
  } else if (f != null)      parts.push(`Foreign ${f >= 0 ? 'net buyers +' : 'net sellers −'}${t(f, 'foreignNet')}${st('foreignNet')}`);
  if (ml != null)  parts.push(`margin loans ${ml >= 0 ? 'up' : 'down'} ${Math.abs(ml)}%${st('marginLoans')} (${ml >= 0 ? 'leverage building' : 'deleveraging'})`);
  if (dep != null) parts.push(`deposits ${dep >= 0 ? 'up' : 'down'} ${Math.abs(dep)}%${st('deposits')} (${dep >= 0 ? 'dry powder building' : 'cash deployed'})`);
  return parts.length ? parts.join('. ') + '.' : null;
}

// The "so what": macro implication of the Korea flows for the book. Foreign flow is the
// KOSPI swing driver (heavy memory — Hynix/Samsung); deposits = dry powder, margin loans =
// leverage. Reads the bias, then a fuel/leverage caveat.
export function koreaFlowImplication(latest) {
  if (!latest) return null;
  const f = latest.foreignNet?.value, i = latest.instNet?.value;
  const ml = latest.marginLoans?.pct, dep = latest.deposits?.pct;
  if (f == null && i == null) return null;

  let bias;
  if (f > 0 && i > 0)       bias = "Risk-ON tone — foreign + institutional accumulation is the bullish tell for KOSPI and the memory complex (Hynix/Samsung), with smart money absorbing retail supply. Reads as a tailwind for the KR semi leaders.";
  else if (f < 0 && i < 0)  bias = "Risk-OFF tone — foreign + institutional distribution; capital leaving KR is a direct headwind for the semi bid. A de-risking regime.";
  else if (f > 0)           bias = "Constructive but unconfirmed — foreigners (the KOSPI swing driver) are net buyers while institutions aren't confirming; a foreign-led bid whose follow-through is the thing to watch.";
  else if (f < 0)           bias = "Cautious tone — foreigners are net sellers, and since foreign flow drives KOSPI, their exit is the dominant tell despite domestic buying.";
  else                      bias = "Mixed flows — no clean directional tell.";

  const cashDeploying = dep != null && dep < 0, leverageUp = ml != null && ml > 0;
  let caveat = "";
  if (cashDeploying && leverageUp) caveat = " Caveat: sideline cash is deploying (deposits ↓) and leverage is building (margin loans ↑) — the move is maturing, so less dry powder and rising fragility if flows reverse.";
  else if (dep != null && dep > 0) caveat = " Dry powder is building (deposits ↑) — buffer and optionality intact for more upside.";
  else if (leverageUp)             caveat = " Leverage is ticking up (margin loans ↑) — watch for crowding.";
  else if (cashDeploying)          caveat = " Cash is deploying off the sidelines (deposits ↓) — fuel being consumed.";
  // Note only the drivers that are actually stale (independent), rather than one headline flag.
  const staleDrivers = ['foreignNet', 'instNet', 'marginLoans', 'deposits']
    .filter(k => latest[k] && kofiaStale(latest[k].asOf))
    .map(k => `${KOFIA_NAME_BY_KEY[k]} ${latest[k].asOf.slice(5)}`);
  const staleNote = staleDrivers.length ? ` ⚠ Stale inputs: ${staleDrivers.join(', ')} — read is dated.` : '';
  return bias + caveat + staleNote;
}

// Parse the whole blob. Line-based: scan for a KNOWN label line, then take the next two
// non-empty lines as "UNIT | MM/DD" and "BALANCE DELTA PCT%". Robust to bare or markdown
// formats. Returns { fields: {key: {...}}, list: [...], anyMismatch, warnings }.
export function parseKofia(blob, now = new Date()) {
  const list = [];
  const warnings = [];
  const lines = String(blob || '').split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const map = KOFIA_LABELS[labelOf(lines[i])];
    if (!map) continue;                 // ignore unmapped rows (주식형펀드 etc.)
    const l2 = lines[i + 1], l3 = lines[i + 2];
    if (!l2 || !l3) continue;

    const parts = l2.split('|');
    const unit = (parts[0] || '').trim();
    const asOf = resolveKofiaDate((parts[1] || '').trim(), now);

    const nums = l3.replace(/−/g, '-').match(/-?[\d,]+(?:\.\d+)?/g) || [];
    const balance = num(nums[0]);
    const delta = num(nums[1]);
    const pct = num(nums[2]);

    const f = { ...map, label: labelOf(lines[i]), unit, asOf, balance, delta, pct };

    // Validation for currency rows: recompute pct = delta / (balance − delta) × 100.
    if (KOFIA_CURRENCY.includes(map.key) && balance != null && delta != null && pct != null) {
      const denom = balance - delta;
      const recomputed = denom !== 0 ? (delta / denom) * 100 : null;
      f.recomputedPct = recomputed != null ? +recomputed.toFixed(2) : null;
      f.mismatch = recomputed != null && Math.abs(recomputed - pct) > 0.05;
    }
    if (asOf == null) warnings.push(`${map.display}: could not parse the date`);
    list.push(f);
    i += 2;                             // consumed the 3-line entry
  }

  // Also recognize the KRX/Naver "투자자별 매매동향" table: pull the 순매수 of ALL THREE actors
  // — 기관 (institutional), 외국인 (foreign), 개인 (retail). Retail matters because it is the
  // absorption counterparty: foreign selling that retail absorbs is a domestic unwind, whereas
  // foreign selling that retail does NOT absorb is flight. Reading foreign in isolation is how
  // the read came out backwards. Value = the LAST number on the row (매도/매수/순매수).
  // Unit here is 십억원 (billions) — NOT the KOFIA panel's 백만원. The table carries no date,
  // so asOf = today's Seoul trading date.
  const krToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
  const ACTORS = [
    [/외국인/, 'foreignNet'],
    [/기\s*관/, 'instNet'],
    [/개\s*인/, 'retailNet'],
  ];
  for (const line of lines) {
    const hit = ACTORS.find(([re]) => re.test(line));
    if (!hit) continue;
    const key = hit[1];
    if (list.some(f => f.key === key)) continue;
    const nums = line.replace(/−/g, '-').match(/-?[\d,]+(?:\.\d+)?/g) || [];
    if (!nums.length) continue;
    const net = num(nums[nums.length - 1]);   // 순매수 = last of 매도/매수/순매수
    if (net == null) continue;
    list.push({ key, display: KOFIA_NAME_BY_KEY[key], role: 'flow', unit: '십억원', asOf: krToday, balance: net, delta: null, pct: null });
  }

  const fields = {};
  for (const f of list) fields[f.key] = f;
  return { fields, list, anyMismatch: list.some(f => f.mismatch), warnings };
}
