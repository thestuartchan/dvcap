// src/JournalDrafts.jsx — the journal inbox's drafts, in the console's action strip.
//
// Notes written from chat are matched to IBKR's fills by the daily statement run
// (lib/journalInbox.js). What comes back is a DRAFT: the fill as IBKR reported it beside what the
// note expected, and the note's tag, rationale and levels. Nothing is confirmed automatically.
// Confirm, Edit then confirm, or Dismiss — and a mismatch is amber, never a refusal: a draft that
// disagrees with its note can still be confirmed, because the fill is what happened.
import { useState } from "react";
import { C } from "./theme.js";
import { draftCounts, expectationText, fmtPx, amendRow, NOTE_TAGS, LEVEL_LABEL } from "../lib/journalInbox.js";

const isRuleChange = (d) => d.kind === "amend" || (d.kind === "ambiguous" && !!d.candidates?.[0]?.row);
const GROUPS = [
  { key: "toConfirm", label: "Drafts to confirm", test: (d) => (d.kind === "fill" && d.note) || (d.kind === "ambiguous" && !isRuleChange(d)) },
  { key: "ruleChanges", label: "Rule changes to confirm", test: isRuleChange },
  { key: "unjournaled", label: "Unjournaled fills", test: (d) => d.kind === "fill" && !d.note },
  { key: "withoutFills", label: "Notes without fills", test: (d) => d.kind === "unfilled" },
];

// A note still in the inbox, waiting for tomorrow's run. Shown so one nobody recognises can be
// removed before it becomes a draft.
function PendingNote({ note, onDrop, busy }) {
  return (
    <div style={{ border: "1.5px solid " + C.bdr, background: C.surf, borderRadius: 9, padding: "8px 10px", display: "grid", gap: 5 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <b style={{ fontSize: 13, color: C.text }}>{titleOf({ note })}</b>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase" }}>waiting</span>
        <span style={{ fontSize: 11.5, color: C.muted }}>id {note.id} · received {String(note.received_at || "").replace("T", " ").slice(0, 16)}Z</span>
      </div>
      {note.expected && (note.expected.qty != null || note.expected.price != null) && (
        <div style={{ fontSize: 12, color: C.mid }}>expects {note.expected.qty ?? "?"}{note.expected.price != null ? ` @ ${fmtPx(note.expected.price)}` : ""}</div>
      )}
      {note.why?.reason && (
        <div style={{ fontSize: 12, color: C.amber, fontWeight: 700 }}>Not matched yet — {note.why.reason}</div>
      )}
      <NoteBody note={note} edit={null} setEdit={() => {}} />
      <div><button style={btn()} disabled={busy} onClick={() => onDrop(note)}>Remove from inbox</button></div>
    </div>
  );
}

const btn = (tone) => ({ fontSize: 11.5, fontWeight: 800, padding: "4px 10px", borderRadius: 7, cursor: "pointer",
  border: "1.5px solid " + (tone === "go" ? C.blBdr : C.bdrMd), background: tone === "go" ? C.blue : C.surf, color: tone === "go" ? C.onFill : C.mid });

function titleOf(d) {
  if (d.kind === "amend") return `Rule change · ${d.target?.label || d.supersedes}`;
  if (d.fill) return d.fill.label;
  const i = d.note?.instrument;
  if (!i) return d.note?.id || d.id;
  const legs = (i.legs || []).map(l => `${l.side === "SELL" ? "−" : "+"}${l.strike}${l.right}`).join(" ");
  return `${i.symbol}${legs ? " " + legs : ""}${i.side ? " " + i.side.toLowerCase() : ""}`;
}

function NoteBody({ note, edit, setEdit }) {
  if (!note && !edit) return <div style={{ fontSize: 12, color: C.muted }}>No note — tag and rationale are blank until you add them.</div>;
  const v = edit || note;
  const kind = note?.kind || "fill";
  const levels = Object.entries(v.levels || {});
  return (
    <div style={{ display: "grid", gap: 3, fontSize: 12, color: C.mid }}>
      <div><b style={{ color: C.text }}>{v.tag || "no tag"}</b> · {kind}{note ? ` · noted for ${note.trade_date}` : ""}</div>
      {v.rationale && <div>{v.rationale}</div>}
      {levels.length > 0 && <div>{levels.map(([k, x]) => <span key={k} style={{ marginRight: 12 }}><span style={{ color: C.lbl, fontWeight: 800 }}>{LEVEL_LABEL[k] || k}</span> {x == null ? "(remove)" : x}</span>)}</div>}
      {(v.rules || []).map((r, i) => <div key={i}>↳ {r}</div>)}
      {edit && kind === "amend" && (
        <textarea value={(edit.rules || []).join("\n")} rows={3} style={{ fontSize: 12, padding: 5, marginTop: 5 }} placeholder="rules, one per line — these replace the trade's rules"
          onChange={e => setEdit({ ...edit, rules: e.target.value.split("\n").map(x => x.trim()).filter(Boolean), rulesGiven: true })} />
      )}
      {edit && (
        <div style={{ display: "grid", gap: 5, marginTop: 5 }}>
          <select value={edit.tag || ""} onChange={e => setEdit({ ...edit, tag: e.target.value || null })} style={{ fontSize: 12, padding: 4, width: 160 }}>
            <option value="">no tag</option>
            {NOTE_TAGS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <textarea value={edit.rationale || ""} onChange={e => setEdit({ ...edit, rationale: e.target.value })} rows={2} style={{ fontSize: 12, padding: 5 }} placeholder="rationale" />
          {Object.keys(LEVEL_LABEL).map(k => (
            <input key={k} value={edit.levels?.[k] || ""} placeholder={LEVEL_LABEL[k]} style={{ fontSize: 12, padding: 4 }}
              onChange={e => setEdit({ ...edit, levels: { ...(edit.levels || {}), [k]: e.target.value || undefined } })} />
          ))}
        </div>
      )}
    </div>
  );
}

// OLD AGAINST NEW, FIELD BY FIELD — what confirming a rule change would do to the trade, computed
// with the same function that applies it (amendRow), so the preview cannot disagree with the result.
function AmendDiff({ d, rows, edit }) {
  const row = (rows || []).find(r => r.id === d.supersedes);
  if (!row) return <div style={{ fontSize: 12, color: C.amber, fontWeight: 700 }}>The trade {d.supersedes} is not in this console — confirming will say so.</div>;
  const after = amendRow(row, { ...(d.note || {}), ...(edit || {}) });
  const was = row.journal || {}, now = after.journal || {};
  const keys = [...new Set([...Object.keys(was.levels || {}), ...Object.keys(now.levels || {})])];
  const lines = [
    ["Tag", row.tag || "—", after.tag || "—"],
    ...keys.map(k => [LEVEL_LABEL[k] || k, was.levels?.[k] ?? "—", now.levels?.[k] ?? "— (removed)"]),
    ["Rules", (was.rules || []).join(" · ") || "—", (now.rules || []).join(" · ") || "—"],
    ...(after.thesis !== row.thesis ? [["Thesis", "(as now)", `adds: ${String(d.note?.rationale || edit?.rationale || "").slice(0, 160)}…`]] : []),
  ];
  const cell = { padding: "3px 6px", fontSize: 11.5, verticalAlign: "top", borderTop: "1px solid " + C.bdr };
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead><tr>{["", "Now", "After confirm"].map(h => <th key={h} style={{ ...cell, textAlign: "left", color: C.lbl, fontWeight: 800, borderTop: "none" }}>{h}</th>)}</tr></thead>
      <tbody>
        {lines.map(([k, a, b]) => {
          const changed = String(a) !== String(b);
          return (
            <tr key={k}>
              <td style={{ ...cell, color: C.lbl, fontWeight: 800, whiteSpace: "nowrap" }}>{k}</td>
              <td style={{ ...cell, color: C.muted }}>{a}</td>
              <td style={{ ...cell, color: changed ? C.text : C.muted, fontWeight: changed ? 700 : 400, background: changed ? C.blBg : "transparent" }}>{b}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DraftCard({ d, rows, onConfirm, onDismiss, onChoose, busy }) {
  const [edit, setEdit] = useState(null);
  const [showNote, setShowNote] = useState(false);
  const noteFolded = d.kind === "amend" && (rows || []).some(r => r.id === d.supersedes);
  const exp = d.fill ? expectationText(d) : null;
  const startEdit = () => setEdit({ tag: d.note?.tag || null, rationale: d.note?.rationale || "", levels: { ...(d.note?.levels || {}) }, rules: d.note?.rules || [], rulesGiven: d.note?.rulesGiven });
  const cleaned = () => edit && { ...edit, levels: Object.fromEntries(Object.entries(edit.levels || {}).filter(([, x]) => x)) };
  return (
    <div style={{ border: "1.5px solid " + (exp && !exp.ok ? C.aBdr : C.bdr), background: exp && !exp.ok ? C.aBg : C.surf, borderRadius: 9, padding: "8px 10px", display: "grid", gap: 5 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <b style={{ fontSize: 13, color: C.text }}>{titleOf(d)}</b>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase" }}>{d.kind === "fill" ? (d.fill?.type || "fill") : d.kind}</span>
        {d.fill?.date && <span style={{ fontSize: 11.5, color: C.muted }}>filled {d.fill.date}</span>}
        {d.kind === "unfilled" && <span style={{ fontSize: 11.5, color: C.amber, fontWeight: 700 }}>{d.reason || `no matching fill after ${d.waited} sessions`}</span>}
      </div>
      {exp && <div style={{ fontSize: 12.5, fontWeight: 700, color: exp.ok ? C.green : C.amber }}>{exp.text}</div>}
      {d.kind === "amend" && <AmendDiff d={d} rows={rows} edit={edit} />}
      {/* A rule change's table already says what the note says; the note itself folds away unless
          it is being edited, or there is no table because the trade is not in this console. */}
      {noteFolded && !edit
        ? <button style={{ ...btn(), justifySelf: "start", fontSize: 11 }} onClick={() => setShowNote(x => !x)}>{showNote ? "Hide note" : "Show note"}</button>
        : null}
      {(!noteFolded || showNote || edit) && <NoteBody note={d.note} edit={edit} setEdit={setEdit} />}
      {d.kind === "ambiguous" && d.candidates?.[0]?.row && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 12, color: C.amber, fontWeight: 700 }}>This rule change matches {d.candidates.length} open trades — nothing was drafted. Pick the one it changes.</div>
          {d.candidates.map(c => (
            <div key={c.row.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: C.mid }}>
              <span>{c.row.label} · {c.row.id}</span>
              <button style={btn("go")} disabled={busy} onClick={() => onChoose(d, c.row.id)}>Use this trade</button>
            </div>
          ))}
        </div>
      )}
      {d.kind === "ambiguous" && !d.candidates?.[0]?.row && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 12, color: C.amber, fontWeight: 700 }}>This note matches {d.candidates.length} fills — nothing was drafted. Pick the one it describes.</div>
          {d.candidates.map(c => (
            <div key={c.fill.orderId} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: C.mid }}>
              <span>order {c.fill.orderId} · {c.fill.date} · {c.fill.qty} @ {fmtPx(c.fill.rawPrice)}</span>
              <button style={btn("go")} disabled={busy} onClick={() => onChoose(d, c.fill.orderId)}>Use this fill</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(d.kind === "fill" || d.kind === "amend") && (edit
          ? <button style={btn("go")} disabled={busy} onClick={() => onConfirm(d, cleaned())}>Confirm edited</button>
          : <>
              <button style={btn("go")} disabled={busy} onClick={() => onConfirm(d, {})}>Confirm</button>
              <button style={btn()} disabled={busy} onClick={startEdit}>Edit then confirm</button>
            </>)}
        {edit && <button style={btn()} onClick={() => setEdit(null)}>Cancel edit</button>}
        <button style={btn()} disabled={busy} onClick={() => onDismiss(d)}>Dismiss</button>
      </div>
    </div>
  );
}

export default function JournalDrafts({ journal, rows = [], onConfirm, onDismiss, onChoose, onDrop, busy = false, msg = null }) {
  const [open, setOpen] = useState(null);
  const drafts = journal?.drafts || [];
  const waiting = journal?.pendingNotes || [];
  // The strip stays while a message is showing, so confirming the last draft still says it worked.
  if (!drafts.length && !waiting.length && !msg) return null;
  const n = draftCounts(drafts);
  const shown = open && open !== "waiting" ? drafts.filter(GROUPS.find(g => g.key === open).test) : [];
  return (
    <div style={{ padding: "9px 13px", borderRadius: 10, background: C.blBg, border: "1.5px solid " + C.blBdr, display: "grid", gap: 7 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: C.blue, textTransform: "uppercase", letterSpacing: 0.5 }}>Journal</span>
        {GROUPS.filter(g => n[g.key]).map(g => (
          <span key={g.key} onClick={() => setOpen(open === g.key ? null : g.key)}
                style={{ fontSize: 12.5, fontWeight: 800, cursor: "pointer", color: g.key === "withoutFills" ? C.amber : C.blue, textDecoration: open === g.key ? "underline" : "none" }}>
            {g.label} ({n[g.key]})
          </span>
        ))}
        {journal?.pending > 0 && (
          <span onClick={() => setOpen(open === "waiting" ? null : "waiting")}
                style={{ fontSize: 11.5, color: C.muted, cursor: "pointer", textDecoration: open === "waiting" ? "underline" : "none" }}>
            {journal.pending} note{journal.pending === 1 ? "" : "s"} waiting for a fill
          </span>
        )}
        {msg && <span style={{ fontSize: 11.5, color: msg.err ? C.red : C.green, fontWeight: 700 }}>{msg.text}</span>}
      </div>
      {shown.map(d => <DraftCard key={d.id} d={d} rows={rows} onConfirm={onConfirm} onDismiss={onDismiss} onChoose={onChoose} busy={busy} />)}
      {open === "waiting" && waiting.map(nt => <PendingNote key={nt.id} note={nt} onDrop={onDrop} busy={busy} />)}
    </div>
  );
}
