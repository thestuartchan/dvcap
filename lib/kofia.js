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
  if (f.key === 'foreignNet' || f.key === 'instNet') return `${f.balance >= 0 ? '+' : ''}${Number(f.balance).toLocaleString('en-US')} ₩bn`;
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
  if (key === 'foreignNet' || key === 'instNet') return `${e.value >= 0 ? '+' : ''}${Number(e.value).toLocaleString('en-US')} ₩bn${dt}`;
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

  // Also recognize the KRX/Naver "투자자별 매매동향" table: pull 외국인/기관 순매수 (the LAST
  // number on the row — 매도 / 매수 / 순매수). Unit 십억원 = ₩bn, stored directly (may be
  // negative = net sell). The table carries no date, so asOf = today's Seoul trading date.
  const krToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
  for (const line of lines) {
    const key = /외국인/.test(line) ? 'foreignNet' : /기관/.test(line) ? 'instNet' : null;
    if (!key || list.some(f => f.key === key)) continue;
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
