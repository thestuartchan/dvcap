// lib/southbound.js — HKEX Southbound Stock Connect flow, hand-entered.
//
// WHY MANUAL (flagged per the brief): there is no clean, stable public HKEX API for this. The daily
// aggregate Southbound net is published in HKEX's daily market reports/CSV, and the per-stock SMIC
// (0981.HK) figure lives behind the CCASS "Shareholding in CCASS / Stock Connect" search page —
// both are HTML/CSV surfaces with session tokens that HKEX changes without notice. A scraper would
// silently break, which the brief explicitly rules out. Its sibling (Korea/KOFIA) is manual for the
// same reason, so this follows that pattern. Both figures ARE published every HK trading day.
//
// Single days are noise; the 5- and 20-day windows are the signal. Net flows are additive, so a
// window trend is the running sum of the daily nets over that window.

export const SB_STALE_DAYS = 4; // ~ a HK trading week; flag re-entry past this

export function sbStale(dateIso, nowIso = null) {
  if (!dateIso) return true;
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const age = Math.round((now - Date.parse(dateIso)) / 86400000);
  return !Number.isFinite(age) || age > SB_STALE_DAYS;
}

// Running sum of the last n daily net values for a field, newest first, with a direction.
export function sbWindow(series, field, n) {
  const rows = [...(series || [])]
    .filter(r => r && r.date && Number.isFinite(+r[field]))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, n);
  const sum = rows.reduce((s, r) => s + Number(r[field]), 0);
  return { sum: +sum.toFixed(2), days: rows.length, dir: sum > 0 ? "buy" : sum < 0 ? "sell" : "flat" };
}

export function southboundTrend(series, field = "aggregateNet") {
  const sorted = [...(series || [])].filter(r => r && r.date).sort((a, b) => b.date.localeCompare(a.date));
  return { latest: sorted[0] || null, w5: sbWindow(sorted, field, 5), w20: sbWindow(sorted, field, 20), nObs: sorted.length };
}

// Interpretation. SMIC ≈ a third of NLV and trades as a China-POLICY bet, not a foundry bet;
// mainland Southbound flow is the mechanism that expresses that, so a turn in the flow leads the name.
export function southboundRead(trend) {
  if (!trend || !trend.latest) return { text: "No Southbound data entered yet.", tone: "muted" };
  const b5 = trend.w5, b20 = trend.w20;
  if (b5.dir === "buy" && b20.dir === "buy") {
    return { text: `Mainland accumulating — 5d and 20d both net buy (${b5.sum} / ${b20.sum}). Policy-trade bid intact.`, tone: "green" };
  }
  if (b5.dir !== b20.dir && b5.days >= 3 && b20.dir !== "flat") {
    return { text: `Divergence — 5d ${b5.dir} against a 20d ${b20.dir} (${b5.sum} / ${b20.sum}). Near-term flow is turning; watch for a policy-trade unwind.`, tone: "amber" };
  }
  if (b20.dir === "buy") {
    return { text: `Net accumulation over 20d (${b20.sum}) but 5d ${b5.dir} — steady, not accelerating.`, tone: "muted" };
  }
  return { text: `Mainland net ${b20.dir} over 20d (${b20.sum}) — Southbound is not supporting the position here.`, tone: "amber" };
}
