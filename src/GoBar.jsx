// src/GoBar.jsx — the Go bar: type a function or a ticker and press Enter (lib/goCommands.js).
// Opens from the GO key in the nav, "/" anywhere outside a text field, or Ctrl/Cmd+K.
import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "./theme.js";
import { suggestGo, parseGo, pushRecent } from "../lib/goCommands.js";

const RECENT_KEY = "go_recent_v1";
const readRecent = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(v) ? v.slice(0, 5) : []; } catch { return []; } };
const saveRecent = (v) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(v)); } catch { /* private window: recent is only a convenience */ } };

// The green key a terminal keyboard puts beside Enter — also the bar's own button in the nav.
export function GoKey({ small = false }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-block", background: C.green, color: C.onFill, fontWeight: 900,
      fontSize: small ? 10 : 11, letterSpacing: 0.5, padding: small ? "1px 5px" : "2px 6px", borderRadius: 4, lineHeight: 1.3 }}>GO</span>
  );
}

// Mounted only while open (App.jsx), so every opening starts from an empty line and a fresh read
// of the recent list.
export function GoBar({ onClose, onRun }) {
  const [line, setLine] = useState("");
  const [sel, setSel] = useState(0);
  const [recent, setRecent] = useState(readRecent);
  const inputRef = useRef(null);
  const list = useMemo(() => suggestGo(line, { recent }), [line, recent]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const run = (item) => {
    if (!item || item.soon) return;
    const canon = item.symbol ? `${item.symbol} ${item.code}` : item.code;
    const next = pushRecent(recent, canon);
    setRecent(next); saveRecent(next);
    onRun(item);
    onClose();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(i => Math.min(i + 1, list.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); run(parseGo(line) || list[sel]); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Go to a view" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(8, 12, 18, 0.45)", display: "flex", justifyContent: "center", alignItems: "flex-start",
               paddingTop: "max(10vh, calc(env(safe-area-inset-top, 0px) + 16px))", paddingLeft: "max(12px, env(safe-area-inset-left, 0px))", paddingRight: "max(12px, env(safe-area-inset-right, 0px))" }}>
      <div style={{ width: "100%", maxWidth: 560, background: C.surf, border: "1.5px solid " + C.bdrMd, borderRadius: 12, boxShadow: "0 24px 60px -20px rgba(0,0,0,0.45)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid " + C.bdr }}>
          <span style={{ color: C.muted, fontWeight: 900 }}>›</span>
          <input ref={inputRef} id="go-bar-input" value={line} onChange={(e) => { setLine(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder="ECO, PORT, NVDA, QQQ GEX…" aria-label="Function or ticker" autoComplete="off" autoCapitalize="characters" spellCheck={false}
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: C.text, fontSize: 17, fontWeight: 700,
                     fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", textTransform: "uppercase", letterSpacing: 0.5 }} />
          <button onClick={() => run(parseGo(line) || list[sel])} aria-label="Go" style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}><GoKey /></button>
        </div>
        <div role="listbox" aria-label="Suggestions" style={{ maxHeight: "50vh", overflowY: "auto", padding: "6px 0" }}>
          {list.length === 0 && <div style={{ padding: "10px 16px", color: C.muted, fontSize: 13 }}>Nothing matches. Try a code like ECO or a ticker with GEX.</div>}
          {list.map((r, i) => (
            <div key={r.id} role="option" aria-selected={i === sel} aria-disabled={!!r.soon}
              onMouseEnter={() => setSel(i)} onClick={() => run(r)}
              style={{ display: "grid", gridTemplateColumns: "64px minmax(0, 1fr) auto", alignItems: "center", gap: 10, padding: "7px 16px",
                       background: i === sel ? C.blBg : "transparent", cursor: r.soon ? "default" : "pointer", opacity: r.soon ? 0.55 : 1 }}>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, fontWeight: 800, color: C.amber }}>{r.code}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
              <span style={{ fontSize: 11, color: C.muted, fontWeight: 700, whiteSpace: "nowrap" }}>{r.soon ? "coming next" : r.recent ? "recent" : r.group}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", padding: "8px 16px", borderTop: "1px solid " + C.bdr, fontSize: 11, color: C.muted }}>
          <span>↑↓ choose</span><span>Enter go</span><span>Esc close</span><span>Open with / or Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}
