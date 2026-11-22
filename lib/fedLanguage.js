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
  status: "hawkish_hold", // current state — update manually (moved from active_tightening on 2026-11-01: the Oct 28 hold is the pause the tightening state's watch list named)
  lastUpdated: "2026-11-22",
  lastEvent: "October FOMC minutes (released Nov 18) — almost all participants see further hikes as likely appropriate",
  decision: "HELD at 3.75–4.00% — the pause after the Sep 16 hike",
  vote: "10–2",
  dissents: "Cook and Hammack — both preferred to RAISE the target range by 25bp. Nobody dissented for a cut",
  dissentNote: "Both dissents hawkish: after a unanimous hike, the pause itself was contested from the hawkish side",
  guidance: "NEW wording, still no path: \"The accumulation of more information will help the Committee determine the policy stance appropriate to ensure a timely return of inflation to the Committee's 2 percent goal.\" It replaces September's \"Today's policy action will support a timelier return\" — a wait-and-see line, not a signal either way. No SEP at this meeting; the September median (4.1 at end-2026, one more 25bp hike; 4.1 at end-2027; longer run 3.2) stands until December.",
  summary: "Paused, hawkishly — and the minutes lean further that way. The committee held at 3.75–4.00% on Oct 28, 10–2, with Cook and Hammack voting to hike again. The October minutes (released Nov 18): \"most participants\" backed the hold to gather information on AI-related investment demand, financing conditions and the September hike's transmission, and \"a few\" called it a close call; \"some participants\" favoured a 25bp increase; \"almost all participants\" judged that further action to raise the range, \"broadly consistent with the September Summary of Economic Projections\", would likely be appropriate; \"a couple\" said more than 25bp could warrant consideration at the next meeting if inflation data were unfavourable. Some noted market pricing of tightening in December and next year matched their own path. December 8–9 (with a new SEP) is live for a hike.",
  bias: "Hawkish hold — almost all see more hikes ahead; a couple floated 50bp if inflation disappoints; December (SEP) live",
  nextEvent: "FOMC Dec 8–9 (SEP)",
  source: "federalreserve.gov — FOMC statement of 2026-10-28 (press release monetary20261028a), the September 2026 Summary of Economic Projections (Table 1), the minutes of the September 15–16 meeting (released 2026-10-07) and the minutes of the October 27–28 meeting (fomcminutes20261028, released 2026-11-18)",
};
