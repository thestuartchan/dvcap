// src/pages/ranking.js — regime ranking for the Hedges and Income lists.
// ── AN UNMAPPED REGIME RANKS NOTHING ─────────────────────────────────────────
// Every ranking site on the Posture, Insurance and Income tabs fell back to the STAGFLATION column
// when the regime id was not in its table, so a regime the tables did not know rendered as
// stagflation with no notice. A missing key now leaves the list in its declared order and the
// site says it is unranked. (The id is one of four in practice; this is what happens when it is not.)
export const INS_RANK_KEY = { stag: "stagRank", def: "defRank", ref: "refRank", inf: "infRank" };
export const INCOME_RANK_KEY = { stag: "rank", def: "defRank", ref: "refRank", inf: "infRank" };
export const rankKeyFor = (table, id) => table[id] ?? null;
export const byRank = (key) => (a, b) => key ? ((a[key] ?? 99) - (b[key] ?? 99)) : 0;
