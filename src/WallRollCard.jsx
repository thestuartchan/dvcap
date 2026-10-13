// src/WallRollCard.jsx — the wall roll on the Gamma tab: where each monthly's call and put walls
// have moved, session to session, and what that implies, in plain English. The read is built and
// tested in lib/wallRoll.js; this only draws it.
import { useMemo } from "react";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { wallRoll } from "../lib/wallRoll.js";

const TONE = { up: C.green, down: C.purple, warn: C.amber, neutral: C.mid };
const NY_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (e) => `${MON[+e.slice(5, 7) - 1]} ${+e.slice(8, 10)}`;

function PathRow({ name, path, k, color }) {
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 800, color: C.lbl, paddingRight: 6, position: "sticky", left: 0, background: C.surf }}>{name}</div>
      {path.map((p, i) => {
        const prev = i ? path[i - 1][k] : null;
        const ch = prev != null && p[k] != null && p[k] !== prev;
        return (
          <div key={p.date} style={{ fontSize: 11.5, fontWeight: ch ? 900 : 600, textAlign: "center", fontVariantNumeric: "tabular-nums",
                                     color: ch ? color : C.mid }}>
            {p[k] == null ? "—" : `${ch ? (p[k] > prev ? "▲" : "▼") : ""}${k === "spot" ? p[k].toFixed(0) : p[k]}`}
          </div>
        );
      })}
    </>
  );
}

export function WallRollCard({ symbol, series }) {
  const roll = useMemo(() => wallRoll(series || [], { today: NY_DAY.format(new Date()), symbol }), [series, symbol]);
  return (
    <Card style={{ marginTop: 14 }}>
      <SLabel>Wall roll — where the walls are moving</SLabel>
      <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 8 }}>
        Each monthly expiry's call wall (the ceiling) and put wall (the hedges), one reading per session.
        The read compares today with about a week ago.
      </div>
      {!roll.available ? (
        <div style={{ fontSize: 12.5, color: C.mid }}>
          No wall history yet. Every capture now logs the walls, and the last 30 days are filled in from the kept
          chains over the next one or two captures.
        </div>
      ) : roll.expiries.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.mid }}>No monthly expiry on the latest board.</div>
      ) : roll.expiries.map(e => (
        <div key={e.expiry} style={{ borderTop: "1px solid " + C.bdr, paddingTop: 10, marginTop: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <b style={{ fontSize: 14, color: C.text }}>{label(e.expiry)}</b>
            <span style={{ fontSize: 9.5, fontWeight: 900, letterSpacing: 0.6, color: C.amber }}>OPEX</span>
            {e.box && (
              <span style={{ fontSize: 12, color: C.mid }}>
                box <b style={{ color: C.purple }}>{e.box.put}</b> – <b style={{ color: C.green }}>{e.box.call}</b> ({e.box.width_pct}% wide)
              </span>
            )}
            <span style={{ fontSize: 11, color: C.muted }}>{e.sessions} session{e.sessions === 1 ? "" : "s"} logged</span>
          </div>
          {e.path.length > 0 && (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", marginTop: 6 }}>
              <div style={{ display: "grid", gridTemplateColumns: `44px repeat(${e.path.length}, minmax(44px, 1fr))`, gap: "2px 4px",
                            minWidth: 44 + e.path.length * 48 }}>
                <div style={{ position: "sticky", left: 0, background: C.surf }} />
                {e.path.map(p => <div key={p.date} style={{ fontSize: 10, fontWeight: 800, color: C.lbl, textAlign: "center" }}>{p.date.slice(5)}</div>)}
                <PathRow name="Call" path={e.path} k="call" color={C.green} />
                <PathRow name="Put" path={e.path} k="put" color={C.purple} />
                <PathRow name="Spot" path={e.path} k="spot" color={C.blue} />
              </div>
            </div>
          )}
          {e.read ? (
            <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.45, color: TONE[e.read.call.tone] || C.mid }}>{e.read.call.text}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.45, color: TONE[e.read.put.tone] || C.mid }}>{e.read.put.text}</div>
              {e.read.box && <div style={{ fontSize: 12.5, fontWeight: 800, color: C.text }}>{e.read.box}</div>}
            </div>
          ) : (
            <div style={{ marginTop: 6, fontSize: 12, color: C.muted }}>{e.reason}</div>
          )}
        </div>
      ))}
      {roll.available && (
        <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 10, lineHeight: 1.5 }}>
          A wall is the expiry's heaviest gamma strike on that side — the cell the heatmap rings. Gamma reprices with
          the price, so a wall that moves with the price may be repricing as much as new contracts; a wall that moves
          against or without the price is new open interest. ▲/▼ mark the sessions a wall stepped.
        </div>
      )}
    </Card>
  );
}
