// src/SupplyChainCard.jsx — the ticker page's supplier / customer map, the terminal's SPLC.
//
// Every link is read from a company's own annual report on SEC EDGAR (scripts/supplychain-build.mjs
// writes data/supplychain.json; the rules are lib/supplyChain.js). The JSON is bundled with the
// page: no request, no function. Suppliers sit on the left, customers on the right, competitors
// below; a company's name re-centres the map on it, and its quote mark opens the sentence the link
// was read from and the filing it is in.
//
// `held` is an optional set of tickers the Console holds, computed by the caller in this browser
// from rows it already loaded. It only tints a chip; it is never stored or sent.
import { useMemo, useState } from "react";
import { C } from "./theme.js";
import { SLabel } from "./ui.jsx";
import { dubaiEtStamp } from "../lib/timeFmt.js";
import { mapFor, SC_UNIVERSE } from "../lib/supplyChain.js";
import SC from "../data/supplychain.json";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const day = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const Why = ({ children }) => <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{children}</div>;
const linkBtn = { background: "none", border: "none", padding: 0, color: C.blue, fontWeight: 700, fontSize: 12, cursor: "pointer" };

function Tag({ children, tone = "muted" }) {
  const col = { muted: [C.mid, C.inset, C.bdr], held: [C.green, C.gBg, C.gBdr], anon: [C.amber, C.aBg, C.aBdr] }[tone];
  return <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: col[0], background: col[1], border: "1px solid " + col[2], borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>{children}</span>;
}

// One company on the map. The name re-centres (when it has a ticker); “ ” opens the evidence.
function Node({ row, side, open, onOpen, onCentre, held }) {
  const w = 1 + Math.round(row.weight || 1);
  const edge = side === "left" ? { borderRight: `${w}px solid ${C.bdrMd}` } : side === "right" ? { borderLeft: `${w}px solid ${C.bdrMd}` } : {};
  const isHeld = !!(held && row.ticker && held.has(row.ticker));
  const filers = new Set(row.sources.map(s => s.filer)).size;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "6px 8px", borderRadius: 8, minWidth: 0,
      background: open ? C.blBg : C.inset, border: `1px ${row.named ? "solid" : "dashed"} ${isHeld ? C.gBdr : open ? C.blBdr : C.bdr}`, ...edge }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
        {row.ticker ? (
          <button onClick={() => onCentre(row.ticker)} title={`Centre the map on ${row.label}`}
            style={{ ...linkBtn, fontSize: 12.5, fontWeight: 800, color: C.text, textAlign: "left", overflowWrap: "anywhere", minWidth: 0 }}>{row.label}</button>
        ) : <span style={{ fontSize: 12.5, fontWeight: 700, fontStyle: "italic", color: C.mid, overflowWrap: "anywhere", minWidth: 0 }}>{row.label}</span>}
        <button onClick={onOpen} aria-expanded={open} aria-label={`The filing sentence for ${row.label}`} title="The sentence and the filing"
          style={{ ...linkBtn, marginLeft: "auto", fontSize: 15, lineHeight: 1, padding: "0 2px" }}>“”</button>
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
        {row.named ? <Tag>named</Tag> : <Tag tone="anon">anonymised</Tag>}
        {row.share != null && <span style={{ fontSize: 11, fontWeight: 800, fontFamily: MONO, color: C.text }}>{row.share}% of rev.</span>}
        {filers > 1 && <Tag>both filings</Tag>}
        {isHeld && <Tag tone="held">held</Tag>}
      </div>
    </div>
  );
}

function Column({ title, rows, side, ...rest }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", color: C.lbl, textAlign: side === "left" ? "right" : "left" }}>{side === "left" ? `${title} →` : `→ ${title}`}</div>
      {rows.length ? rows.map(r => <Node key={r.label} {...rest} row={r} side={side} open={rest.openKey === `${title}|${r.label}`} onOpen={() => rest.onOpen(`${title}|${r.label}`)} />)
        : <div style={{ fontSize: 11.5, color: C.muted, textAlign: side === "left" ? "right" : "left" }}>none read</div>}
    </div>
  );
}

// The evidence for one link: each filing that states it, its sentence, and the filing itself.
function Evidence({ row }) {
  return (
    <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: C.inset, border: "1px solid " + C.blBdr }}>
      {row.sources.map((s, i) => (
        <div key={i} style={{ marginTop: i ? 10 : 0 }}>
          <div style={{ fontSize: 11.5, color: C.mid, fontWeight: 700 }}>
            {s.filer}’s {s.filing?.form || "filing"}{s.filing?.date ? `, filed ${day(s.filing.date)}` : ""}
            {s.share != null && <span style={{ color: C.text }}> · states {s.share}% of revenue</span>}
          </div>
          <blockquote style={{ margin: "4px 0 0", padding: "2px 0 2px 10px", borderLeft: "3px solid " + C.blBdr, fontSize: 12.5, lineHeight: 1.5, color: C.text, overflowWrap: "anywhere" }}>
            “{s.quote}”
          </blockquote>
          {s.filing?.url && <a href={s.filing.url} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 4, fontSize: 12, fontWeight: 700, color: C.blue }}>Open the {s.filing.form} on EDGAR ↗</a>}
        </div>
      ))}
    </div>
  );
}

export function SupplyChainCard({ symbol, held = null }) {
  const [centre, setCentre] = useState(symbol);
  const [openKey, setOpenKey] = useState(null);
  const m = useMemo(() => mapFor(SC, centre), [centre]);
  const recentre = (t) => { setCentre(t); setOpenKey(null); };
  const toggle = (k) => setOpenKey(o => (o === k ? null : k));
  const all = [...m.suppliers.map(r => ["Suppliers", r]), ...m.customers.map(r => ["Customers", r]), ...m.competitors.map(r => ["Competitors", r])];
  const opened = all.find(([t, r]) => `${t}|${r.label}` === openKey)?.[1] || null;
  const shared = { openKey, onOpen: toggle, onCentre: recentre, held };
  const f = m.filer?.filing;

  return (
    <div data-slot="supply-chain">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel style={{ marginBottom: 4 }}>Suppliers and customers</SLabel>
        {centre !== symbol && <button onClick={() => recentre(symbol)} style={{ ...linkBtn, marginLeft: "auto" }}>← back to {symbol}</button>}
      </div>
      <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
        <b style={{ fontFamily: MONO, color: C.text }}>{m.label}</b>
        {m.label !== m.centre && <span style={{ fontFamily: MONO }}> ({m.centre})</span>}
        {f ? <> · from its {f.form} filed {day(f.date)} and the filings of the other {SC_UNIVERSE.length - 1} companies read · <a href={f.url} target="_blank" rel="noreferrer" style={{ color: C.blue, fontWeight: 700 }}>{f.form} ↗</a></>
          : <> · its own reports aren’t read here; any links below come from other companies’ filings</>}
      </div>

      {m.empty ? (
        <Why>
          {m.empty === "read" ? <>No supplier, customer or competitor links were extracted for {m.label} from its {f?.form || "annual report"}. The rules keep only sentences that state a relationship plainly, so this is not evidence that there are none.</>
            : m.empty === "missing" ? <>{m.label}’s annual report couldn’t be read on the last build ({m.missing}), and no other filing read names it.</>
            : <>{m.label} isn’t one of the {SC_UNIVERSE.length} companies whose annual reports are read, and none of their filings names it. No links.</>}
        </Why>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 30px minmax(0,1fr)", gap: 8, alignItems: "stretch" }}>
            <Column title="Suppliers" rows={m.suppliers} side="left" {...shared} />
            <div aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, background: C.blBg, border: "1px solid " + C.blBdr }}>
              <span style={{ writingMode: "vertical-rl", fontFamily: MONO, fontWeight: 900, fontSize: 12, color: C.blue, letterSpacing: 1 }}>{m.centre}</span>
            </div>
            <Column title="Customers" rows={m.customers} side="right" {...shared} />
          </div>
          {opened && (m.suppliers.includes(opened) || m.customers.includes(opened)) && <Evidence row={opened} />}

          <div style={{ marginTop: 12, fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", color: C.lbl }}>Competitors</div>
          {m.competitors.length ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 6, marginTop: 6 }}>
              {m.competitors.map(r => <Node key={r.label} row={r} side="none" open={openKey === `Competitors|${r.label}`} onOpen={() => toggle(`Competitors|${r.label}`)} onCentre={recentre} held={held} />)}
            </div>
          ) : <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>none read</div>}
          {opened && m.competitors.includes(opened) && <Evidence row={opened} />}
        </>
      )}

      <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 10, lineHeight: 1.5 }}>
        Each company’s latest 10-K or 20-F on SEC EDGAR, read raw; a link is kept only when its sentence states it. Named: the filing names the company. Anonymised: the filing gives a share and no name, and it stays unnamed. A % is shown only where the filing states it. Thicker edge: a stated share, or both companies’ filings. Built {dubaiEtStamp(SC._generated)}.
      </div>
    </div>
  );
}
