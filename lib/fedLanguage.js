// lib/fedLanguage.js — the FOMC statement stance, kept by hand after each meeting or minutes.
//
// Moved out of src/App.jsx so the server side (the regime-log cron, lib/marketState.js's policy
// layer) reads the same stance the dashboard shows. The display vocabulary (FED_LANGUAGE_STATES:
// labels and colours) stays with the UI.
// ─── FED LANGUAGE STATUS ──────────────────────────────────────────────────────
// Manually-updated status card (no live fetch). Update the STATUS fields below
// after each FOMC meeting / significant Fed communication. The six STATES
// definitions are stable and only change on explicit request (active_tightening added 2026-09-27).
export const FED_LANGUAGE_STATUS = {
  status: "active_tightening", // current state — update manually (the state was added on request 2026-09-27)
  lastUpdated: "2026-09-27",
  lastEvent: "September FOMC (decision Sep 16) — HIKED 25bp, unanimous · new SEP",
  decision: "HIKED 25bp to 3.75–4.00% — the first move after five holds",
  vote: "12–0",
  dissents: "None — unanimous. The three July dissents (Hammack, Kashkari, Logan) were FOR this hike, and nobody dissented against it",
  dissentNote: "A unanimous hike after a 9–3 hold: the July hawks carried the committee rather than splitting it",
  guidance: "NONE in the statement — still no forward guidance (\"Today's policy action will support a timelier return to the Committee's 2 percent goal … The Committee will deliver price stability\"). The September SEP median puts the funds rate at 4.1 at end-2026 (one more 25bp hike) and 4.1 at end-2027, up from 3.8 and 3.6 in June; longer run 3.2. Median core PCE 3.4% for 2026 and 2.5% for 2027; unemployment 4.1%; GDP 2.3%.",
  summary: "Tightening resumed. A unanimous 25bp hike on Sep 16 took the target range to 3.75–4.00%. The statement reads strength, not risk: activity \"expanding at a solid pace\", domestic spending \"resilient\", productivity \"strong\", capital investment \"robust\", job gains keeping pace with the workforce — and \"inflation remains elevated\". The dots moved up a full step: the 2026 median rose from 3.8 to 4.1 and 2027 from 3.6 to 4.1, so the committee's own path has one more hike this year and no cut next year. October 27–28 is live.",
  bias: "Tightening, data-dependent — one more hike in the dots; October live",
  nextEvent: "September minutes (three weeks after, ≈Oct 7) · FOMC Oct 27–28 (decision Oct 28, no SEP) · Dec 8–9 (SEP)",
  source: "federalreserve.gov — FOMC statement of 2026-09-16 and the September 2026 Summary of Economic Projections (Table 1)",
};
