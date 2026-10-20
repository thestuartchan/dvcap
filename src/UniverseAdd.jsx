// src/UniverseAdd.jsx — "Add to" buttons for one symbol: the earnings watch, the supplier map, the
// pre-read watchlist. Shown on the ticker page and in Data health › Ticker coverage.
//
// A button appears only where the list could take the symbol (lib/universeAdded.js canAdd); the
// route checks it again against the list's own source before it writes data/universe_added.json.
// A name the code's own lists already hold is shown as on the list, with no remove — only names
// added here can be taken off here. The site redeploys on the commit, so a change is on the list
// about a minute later; until then the button says so.
import { useState } from "react";
import { C } from "./theme.js";
import { ADD_LISTS, ADD_LABEL, canAdd, onList, addedIn } from "../lib/universeAdded.js";

const pill = (on) => ({ padding: "3px 9px", fontSize: 11.5, fontWeight: 700, borderRadius: 6, cursor: on ? "pointer" : "default",
  border: "1px solid " + (on ? C.blue : C.bdr), background: on ? C.blBg : "transparent", color: on ? C.blue : C.muted });

export function UniverseAdd({ sym, name = null }) {
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState({});      // list → 'added' | 'removed'
  const [msg, setMsg] = useState(null);
  if (!sym) return null;
  const can = canAdd(sym), on = onList(sym), mine = addedIn(sym);
  const lists = ADD_LISTS.filter(l => can[l] || on[l]);
  if (!lists.length) return null;

  const change = async (list, op) => {
    setBusy(list); setMsg(null);
    try {
      const r = await fetch("/api/manual-entry", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ universe: { op, list, sym, name } }) });
      const j = await r.json().catch(() => null);
      const u = j?.universe;
      if (!r.ok || !u?.ok) { setMsg({ ok: false, text: u?.error || j?.error || `the route answered ${r.status}` }); return; }
      setDone(d => ({ ...d, [list]: op === "add" ? "added" : "removed" }));
      setMsg({ ok: true, text: !u.changed ? `${sym} was already ${op === "add" ? "on" : "off"} the ${ADD_LABEL[list].toLowerCase()}.`
        : `${op === "add" ? "Added" : "Removed"} — on the ${ADD_LABEL[list].toLowerCase()} after the site redeploys (about a minute).`
          + (u.readNow === true ? " Its filings are being read now." : u.readNow === false ? " Its filings are read on Sunday's refresh." : "") });
    } catch (e) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally { setBusy(null); }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: C.lbl }}>Add to</span>
        {lists.map(l => {
          const state = done[l] || (mine[l] ? "added" : on[l] ? "listed" : null);
          if (state === "listed") return <span key={l} style={pill(false)} title="On the list kept in the code">✓ {ADD_LABEL[l]}</span>;
          if (state === "added") return (
            <button key={l} onClick={() => change(l, "remove")} disabled={busy === l} style={pill(true)} title={`Added from the dashboard — remove ${sym} from the ${ADD_LABEL[l].toLowerCase()}`}>
              ✓ {ADD_LABEL[l]} · remove
            </button>
          );
          return (
            <button key={l} onClick={() => change(l, "add")} disabled={busy === l} style={pill(true)}>
              {busy === l ? "…" : "+"} {ADD_LABEL[l]}
            </button>
          );
        })}
      </div>
      {msg && <div style={{ fontSize: 11.5, marginTop: 4, color: msg.ok ? C.green : C.amber }}>{msg.text}</div>}
    </div>
  );
}
