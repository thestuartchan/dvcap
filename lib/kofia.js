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

// Currency → ₩T. 백만원 (millions) ÷ 1e6; 억원 (100M) ÷ 1e4.
export function toWonTrillions(rawValue, unit) {
  if (rawValue == null) return null;
  const div = unit === '억원' ? 1e4 : 1e6; // default 백만원
  return rawValue / div;
}

// Human display for a parsed field.
export function kofiaDisplay(f) {
  if (KOFIA_CURRENCY.includes(f.key)) {
    const t = toWonTrillions(f.balance, f.unit);
    const dt = toWonTrillions(f.delta, f.unit);
    return `₩${t.toFixed(2)}T${f.delta != null ? ` · Δ ${dt >= 0 ? '+' : '−'}₩${Math.abs(dt).toFixed(2)}T (${f.pct >= 0 ? '+' : ''}${f.pct}%)` : ''}`;
  }
  if (f.unit === '%') return `${f.balance}%${f.delta != null ? ` (${f.delta >= 0 ? '+' : ''}${f.delta})` : ''}`;
  return `${f.balance?.toLocaleString('en-US')}${f.delta != null ? ` (${f.delta >= 0 ? '+' : ''}${f.delta})` : ''}`;
}

// Display name per field key (for the stored latest values).
export const KOFIA_NAME_BY_KEY = Object.fromEntries(
  Object.values(KOFIA_LABELS).map(m => [m.key, m.display])
);
KOFIA_NAME_BY_KEY.units7709 = 'CSOP 7709 units';

// Format a STORED latest entry ({ value, unit, asOf, delta, pct }) → one display string.
// Currency → ₩T; yields → %; 7709 → millions of units; KOSPI → points. asOf appended.
export function kofiaStoredLine(key, e) {
  if (!e || e.value == null) return null;
  const dt = e.asOf ? ` · ${e.asOf.slice(5)}` : '';
  if (KOFIA_CURRENCY.includes(key)) {
    const t = toWonTrillions(e.value, e.unit);
    const d = e.delta != null ? toWonTrillions(e.delta, e.unit) : null;
    return `₩${t.toFixed(2)}T${d != null ? ` ${d >= 0 ? '+' : '−'}₩${Math.abs(d).toFixed(2)}T (${e.pct >= 0 ? '+' : ''}${e.pct}%)` : ''}${dt}`;
  }
  if (key === 'units7709') return `${(e.value / 1e6).toFixed(1)}M${e.delta != null ? ` (${e.delta >= 0 ? '+' : ''}${(e.delta / 1e6).toFixed(1)}M)` : ''}${dt}`;
  if (e.unit === '%') return `${e.value}%${dt}`;
  return `${Number(e.value).toLocaleString('en-US')}${dt}`;
}

// Parse the whole blob. Returns { fields: {key: {...}}, list: [...], anyMismatch, warnings }.
export function parseKofia(blob, now = new Date()) {
  const list = [];
  const warnings = [];
  const chunks = String(blob || '').split(/(?=\*\s*\[)/).map(c => c.trim()).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;
    const labelM = lines[0].match(/\[([^\]]+)\]/);
    if (!labelM) continue;
    const label = labelM[1].trim();
    const map = KOFIA_LABELS[label];
    if (!map) continue; // ignore unmapped rows

    const l2 = lines[1].split('|');
    const unit = (l2[0] || '').trim();
    const asOf = resolveKofiaDate((l2[1] || '').trim(), now);

    const nums = lines[2].replace(/−/g, '-').match(/-?[\d,]+(?:\.\d+)?/g) || [];
    const balance = num(nums[0]);
    const delta = num(nums[1]);
    const pct = num(nums[2]);

    const f = { ...map, label, unit, asOf, balance, delta, pct };

    // Validation for currency rows: recompute pct = delta / (balance − delta) × 100.
    if (KOFIA_CURRENCY.includes(map.key) && balance != null && delta != null && pct != null) {
      const denom = balance - delta;
      const recomputed = denom !== 0 ? (delta / denom) * 100 : null;
      f.recomputedPct = recomputed != null ? +recomputed.toFixed(2) : null;
      f.mismatch = recomputed != null && Math.abs(recomputed - pct) > 0.05;
    }
    if (asOf == null) warnings.push(`${map.display}: could not parse the date`);
    list.push(f);
  }

  const fields = {};
  for (const f of list) fields[f.key] = f;
  const anyMismatch = list.some(f => f.mismatch);
  return { fields, list, anyMismatch, warnings };
}
