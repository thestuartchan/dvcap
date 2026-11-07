// src/pages/OpsPage.jsx — the Ops page: the inputs behind every number and the jobs that fetch
// them. Hand-entry hub first (what needs you), then feed health, cross-checks, job health, the
// hand-kept ledger and ticker coverage. The editors stay App's: `renderEditor(editor)` hands each
// one the state and save path it already has (7 Nov 2026, step 3 part 2).
import { useState } from "react";
import { C } from "../theme.js";
import { SLabel, Card } from "../ui.jsx";
import { CoveragePanel } from "../CoveragePanel.jsx";
import { STATUS } from "../../lib/status.js";
import { FeedHealth, CrossCheckHealth, JobHealth } from "../MarketState.jsx";
import { handEntryPlan } from "../../lib/handEntry.js";
  // one map, shared with the trade console

// ── THE HAND-KEPT LEDGER ─────────────────────────────────────────────────────
// lib/ledger.js builds the list; this renders it. Stale and missing first. Each row: the input,
// when it was last kept, its cadence, what the system DOES when it is late, and where it lives.
const LEDGER_TONE = {
  stale: { tok: STATUS.ELEVATED, word: "stale — not used" }, missing: { tok: STATUS.ELEVATED, word: "missing" },
  due: { tok: STATUS.WATCH, word: "due — still used" }, fresh: { tok: STATUS.BENIGN, word: "fresh" },
  optional: { tok: null, word: "optional — update when a house publishes" },
  retired: { tok: null, word: "retired" }, undated: { tok: null, word: "undated" },
};
// ── THE HAND-ENTRY HUB ───────────────────────────────────────────────────────
// Every hand-kept input in one list, in the order it needs you (lib/handEntry.js), each with the
// SAME editor its own tab uses, opened in place — so keeping them current is one place, not five
// tabs of scrolling. `renderEditor(editor)` is App's: it hands each editor the state and save path
// it already has, and refreshes the store after a save so the row's age updates.
function HandEntryRow({ r, isOpen, onToggle, renderEditor }) {
  const t = LEDGER_TONE[r.state] || LEDGER_TONE.undated;
  const col = t.tok ? t.tok.color : C.muted;
  return (
    <div style={{ borderTop: "1px solid " + C.bdr, padding: "8px 0" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 900, letterSpacing: 0.4, color: col, background: t.tok ? t.tok.bg : "transparent", border: "1px solid " + (t.tok ? t.tok.bdr : C.bdr), borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>{t.word}</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.text, minWidth: 0, overflowWrap: "anywhere" }}>{r.label}</span>
        <span style={{ fontSize: 11.5, color: C.muted }}>
          {r.asOf ? `last ${r.asOf}` : "never entered"}{r.days != null && r.key !== "calendar" && r.key !== "holidays" ? ` · ${r.days}d` : ""}{r.cadence ? ` · ${r.cadence}` : ""}
        </span>
        {r.editable && (
          <button onClick={onToggle} aria-expanded={isOpen}
            style={{ marginLeft: "auto", fontSize: 12, fontWeight: 800, padding: "4px 10px", borderRadius: 6, cursor: "pointer", border: "1.5px solid " + (isOpen ? C.blue : C.bdr), background: isOpen ? C.blBg : C.surf, color: isOpen ? C.blue : C.mid }}>
            {isOpen ? "Close" : "Update ▾"}
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: C.lbl, marginTop: 3, lineHeight: 1.45 }}>
        {r.editable ? r.rule : r.whyNot}
        {(r.sources || (r.source ? [r.source] : [])).map(s => <span key={s.url}> · <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: C.blue, fontWeight: 700 }}>{s.label} ↗</a></span>)}
      </div>
      {r.parts?.length > 1 && (
        <div style={{ marginTop: 4, display: "grid", gap: 2 }}>
          {r.parts.map(p => {
            const pt = LEDGER_TONE[p.state] || LEDGER_TONE.undated;
            return (
              <div key={p.key} style={{ fontSize: 11.5, color: C.muted, display: "flex", gap: 6, alignItems: "baseline" }}>
                <b style={{ color: pt.tok ? pt.tok.color : C.muted, minWidth: 52, fontSize: 10, letterSpacing: 0.4 }}>{p.state.toUpperCase()}</b>
                <span style={{ color: C.mid }}>{p.label}</span>
                <span>{p.asOf ? `last ${p.asOf}` : "never entered"}{p.days != null ? ` · ${p.days}d` : ""}</span>
              </div>
            );
          })}
        </div>
      )}
      {isOpen && <div style={{ marginTop: 8 }}>{renderEditor(r.editor)}</div>}
    </div>
  );
}
function HandEntryHub({ ledger, renderEditor }) {
  const [open, setOpen] = useState(null);
  if (!ledger) return null;
  const plan = handEntryPlan(ledger.rows);
  const row = (r) => <HandEntryRow key={r.key} r={r} isOpen={open === r.key} onToggle={() => setOpen(open === r.key ? null : r.key)} renderEditor={renderEditor} />;
  const tok = plan.counts.overdue > 0 ? STATUS.ELEVATED : plan.counts.due > 0 ? STATUS.WATCH : STATUS.BENIGN;
  return (
    <Card id="hand-entry" style={{ borderLeft: "4px solid " + tok.color, scrollMarginTop: 170 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <SLabel>✍ Needs you — hand-kept inputs</SLabel>
        <span style={{ fontSize: 12.5, color: C.text }}>
          {plan.needsYou.length === 0 ? "all current" : `${plan.counts.overdue} overdue · ${plan.counts.due} due`} · {plan.counts.editable} you can update here
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
        Each row opens the same editor its own tab uses and saves the same way; the age updates after a save. Inputs kept in the source are listed with who keeps them.
      </div>
      <div style={{ marginTop: 6 }}>
        {plan.needsYou.length === 0 && <div style={{ fontSize: 12.5, color: C.green, fontWeight: 700, padding: "8px 0" }}>Nothing overdue or due.</div>}
        {plan.needsYou.map(row)}
      </div>
      {plan.rest.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700, color: C.mid }}>Current, retired and automatic ({plan.rest.length})</summary>
          {plan.rest.map(row)}
        </details>
      )}
    </Card>
  );
}

function HandKeptLedgerPanel({ ledger }) {
  if (!ledger) return null;
  const { rows, counts } = ledger;
  const attention = counts.stale + counts.missing + counts.due;
  const tok = counts.stale + counts.missing > 0 ? STATUS.ELEVATED : counts.due > 0 ? STATUS.WATCH : STATUS.BENIGN;
  const chip = (n, s) => n > 0 ? (
    <span key={s} style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.4, color: (LEDGER_TONE[s].tok || { color: C.muted }).color, background: (LEDGER_TONE[s].tok || { bg: C.bg }).bg, border: "1px solid " + (LEDGER_TONE[s].tok || { bdr: C.bdr }).bdr, borderRadius: 5, padding: "2px 8px" }}>
      {n} {s.toUpperCase()}
    </span>) : null;
  const age = r => r.days == null ? "—" : r.state === "fresh" && r.key === "holidays" ? `${r.days}d left` : r.key === "calendar" ? (r.note || "") : `${r.days}d${r.bizDays != null ? ` · ${r.bizDays} biz` : ""}`;
  return (
    <Card style={{ borderLeft: "4px solid " + tok.color }}>
      <details open={attention > 0}>
        <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <SLabel>✍ Hand-kept ledger</SLabel>
          <span style={{ fontSize: 12.5, color: C.text }}>{rows.length} inputs a person keeps · {attention === 0 ? "all current" : `${attention} need attention`}</span>
          {["stale", "missing", "due"].map(s => chip(counts[s], s))}
          <span style={{ fontSize: 11, color: C.lbl, marginLeft: "auto" }}>as of {ledger.asOf}</span>
        </summary>
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11.5, minWidth: 720 }}>
            <thead>
              <tr style={{ color: C.lbl, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 9.5 }}>
                {["State", "Input", "Last kept", "Age", "Cadence", "When late", "Kept at"].map(h => <th key={h} style={{ textAlign: "left", padding: "4px 8px 6px 0", borderBottom: "1px solid " + C.bdr, fontWeight: 800 }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const t = LEDGER_TONE[r.state] || LEDGER_TONE.undated;
                const col = t.tok ? t.tok.color : C.muted;
                return (
                  <tr key={r.key} style={{ borderBottom: "1px solid " + C.bdr, verticalAlign: "top" }} title={r.note || ""}>
                    <td style={{ padding: "6px 8px 6px 0", whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: 10, fontWeight: 900, letterSpacing: 0.4, color: col, background: t.tok ? t.tok.bg : "transparent", border: "1px solid " + (t.tok ? t.tok.bdr : C.bdr), borderRadius: 4, padding: "1px 6px" }}>{t.word}</span>
                    </td>
                    <td style={{ padding: "6px 8px 6px 0", color: C.text, fontWeight: 700 }}>{r.label}<div style={{ fontSize: 10, color: C.lbl, fontWeight: 600 }}>{r.group}</div></td>
                    <td style={{ padding: "6px 8px 6px 0", color: C.mid, whiteSpace: "nowrap" }}>{r.asOf || "—"}</td>
                    <td style={{ padding: "6px 8px 6px 0", color: col, fontWeight: 800, whiteSpace: "nowrap" }}>{age(r)}</td>
                    <td style={{ padding: "6px 8px 6px 0", color: C.mid }}>{r.cadence || "—"}</td>
                    <td style={{ padding: "6px 8px 6px 0", color: C.mid, maxWidth: 320 }}>{r.rule}</td>
                    <td style={{ padding: "6px 0", color: C.lbl, fontSize: 10.5 }}>{r.where}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

// The page. Everything it shows is already loaded by App; nothing is fetched here except what the
// panels fetch themselves (job health, coverage).
export function OpsPage({ ledger, renderEditor, stateFeed, liveInd, indUpdated, xcHealth, jobHealth, onOpenTicker }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <HandEntryHub ledger={ledger} renderEditor={renderEditor} />
      <FeedHealth feed={stateFeed} indErrors={liveInd?.feedErrors} indUpdated={indUpdated ? indUpdated.toISOString() : null} />
      <CrossCheckHealth xc={xcHealth} />
      <JobHealth st={jobHealth} />
      <HandKeptLedgerPanel ledger={ledger} />
      <CoveragePanel onOpenTicker={onOpenTicker} />
    </div>
  );
}
