// src/pages/editors.jsx — the hand-kept input editors that more than one page opens: the yen
// intervention flag, the Fed path card, the USFR SEC-yield form, the ISM entry and the recession
// panel overrides. Drivers shows
// them in place; Ops opens the same component from its hand-entry list, with the same save path.
import { useState, useEffect } from "react";
import { C } from "../theme.js";
import { SLabel, Card, Btn, StaleChip, HandKept } from "../ui.jsx";
import { kofiaStale } from "../../lib/kofia.js";
import { interventionAnnotation } from "../../lib/fx.js";
import { STATUS } from "../../lib/status.js";
import { pathReading, ladder, CAVEATS as FED_PATH_CAVEATS } from "../../lib/fedpath.js";
import { businessDaysSince } from "../../lib/bondDays.js";
import { ISSUER_PAGE } from "../../lib/cashyield.js";
import { parseSecYieldPaste, parseYieldValue } from "../../lib/fundYield.js";
import { dubaiEt } from "../../lib/timeFmt.js";
import { mergeIsm } from "../../lib/ismFeed.js";
import { RECESSION_SOURCES, recessionSrcKey } from "../../lib/regimeEngine.js";

// ─── FED PATH — market-implied (P6.2) ─────────────────────────────────────────
// The Fed Language card is the QUALITATIVE read; this is the quantitative one beside it.
// There is no free feed for 30-day fed funds futures (ZQ): IBKR has no stateless auth and its
// futures data is ~20-min delayed, so this is a daily hand entry — same pattern as KOFIA.
// ZQ is quoted as 100 − the implied average fed funds rate for the contract month.
// F3 — coordinated FX intervention flag.
//
// The yen flag now also sets itself (lib/interventionAuto.js): SUSPECTED from a fast, yen-specific
// USD/JPY fall near its 60-day high, CONFIRMED or DENIED from the Ministry of Finance's own data.
// Not from a wide daily move — the rule is calibrated on the 2026 operations and fires on nothing
// else in six months. This manual toggle stays for what the scan cannot see (a smaller operation,
// another currency) and for confirming on the day; a stored flag wins over the automatic one.
//
//
// Reads and writes the live store rather than the deployed bundle, so the flag takes effect
// on save instead of waiting for a redeploy. That matters for a switch whose whole purpose is
// to annotate a move that is happening right now.
export function InterventionToggle({ jpyChangePct, dxyChangePct, onChange, auto = null }) {
  const [iv, setIv] = useState(null);
  const [since, setSince] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch("/api/manual-entry").then(r => r.json()).then(j => {
      setIv(j.intervention || null);
      if (j.intervention?.since) setSince(j.intervention.since);
      if (j.intervention?.note) setNote(j.intervention.note);
      onChange?.(j.intervention || null);
    }).catch(() => {});
  }, []);

  const active = !!iv?.active;
  // Preview the annotation the dashboard will show, computed from the same function the
  // server uses — so what you see before saving is what gets rendered after.
  const preview = interventionAnnotation({
    active: true, since: since || new Date().toISOString().slice(0, 10), note: note || null,
    jpyChangePct, dxyChangePct,
  });

  async function toggle(next) {
    setSaving(true); setMsg(null);
    try {
      const body = next
        ? { intervention: { active: true, since: since || new Date().toISOString().slice(0, 10), note: note || null } }
        : { intervention: { active: false } };
      const r = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        const fresh = await fetch("/api/manual-entry").then(x => x.json()).catch(() => null);
        setIv(fresh?.intervention || null);
        onChange?.(fresh?.intervention || null);
        setMsg({ ok: true, text: next ? "Intervention flag ON — FX row annotated" : "Flag cleared" });
      } else setMsg({ ok: false, text: j.error || "save failed" });
    } catch (e) { setMsg({ ok: false, text: String(e.message) }); }
    setSaving(false);
  }

  const tok = active ? STATUS.WATCH : null;
  return (
    <Card style={active ? { background: tok.bg, border: "1.5px solid " + tok.bdr } : undefined}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>⚑ FX intervention flag</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>manual override — the automatic flag is below</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
        <button
          onClick={() => toggle(!active)} disabled={saving}
          style={{
            background: active ? tok.color : C.onFill, color: active ? C.onFill : C.mid,
            border: "1.5px solid " + (active ? tok.color : C.bdrMd), borderRadius: 8,
            padding: "6px 14px", fontSize: 12.5, fontWeight: 800,
            cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1,
          }}>
          {saving ? "Saving…" : active ? "● ACTIVE — click to clear" : "○ Off — click to activate"}
        </button>
        {active && iv?.since && (
          <span style={{ fontSize: 11.5, color: tok.color, fontWeight: 700 }}>since {iv.since}</span>
        )}
      </div>

      {auto && <div style={{ marginTop: 8 }}><InterventionAutoBlock auto={auto} /></div>}

      {/* C5 — prompt when USD/JPY moves >2% in a session and the automatic scan has not flagged it. */}
      {!active && !auto?.active && jpyChangePct != null && Math.abs(jpyChangePct) > 2 && (
        <div style={{ marginTop: 8, padding: "8px 11px", background: STATUS.WATCH.bg, border: "1.5px solid " + STATUS.WATCH.bdr, borderRadius: 8, fontSize: 12, color: STATUS.WATCH.color, fontWeight: 700, lineHeight: 1.5 }}>
          ⚑ USD/JPY moved {jpyChangePct >= 0 ? "+" : ""}{jpyChangePct.toFixed(2)}% this session (&gt;2%) — check for intervention before trusting the yen leg. The Jul 30–31 joint US–Japan action (~¥8.45tn day one, the largest single-day intervention on record) is exactly the kind of move this flag exists to catch.
        </div>
      )}

      {!active && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <input value={since} onChange={e => setSince(e.target.value)} placeholder="since (YYYY-MM-DD)"
            style={{ flex: "1 1 130px", minWidth: 0, padding: "6px 9px", fontSize: 12, border: "1px solid " + C.bdrMd, borderRadius: 6 }} />
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="note (optional)"
            style={{ flex: "2 1 180px", minWidth: 0, padding: "6px 9px", fontSize: 12, border: "1px solid " + C.bdrMd, borderRadius: 6 }} />
        </div>
      )}

      {/* The arithmetic, shown whether the flag is on or off — it is what the operator is
          judging against, and it is useful before deciding to set the flag. */}
      {preview.attribution && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.55 }}>
          {preview.attribution.sameDirection
            ? `Today: ${preview.attribution.note}.`
            : `Today: ${preview.attribution.note}.`}
        </div>
      )}
      {active && (
        <div style={{ fontSize: 11.5, color: tok.color, fontWeight: 600, marginTop: 6, lineHeight: 1.55 }}>
          {iv.note ? `Note: ${iv.note}` : "Annotating the FX row on Global Playbook."}
        </div>
      )}
      {!active && iv?.clearedAt && (
        <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 6 }}>
          Last window cleared {String(iv.clearedAt).slice(0, 10)}{iv.previousSince ? ` (ran from ${iv.previousSince})` : ""}
        </div>
      )}
      {msg && (
        <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 6, color: msg.ok ? C.green : C.red }}>{msg.text}</div>
      )}
    </Card>
  );
}

// C2 — business days elapsed since an ISO date. A hand-entered ZQ settle goes stale fast:
// past 3 business days the derived hike/cut count must not read as current, so it is suppressed.
// ZQ settles on the exchange calendar (CME is open on Columbus and Veterans Day).
function bizDaysSince(isoDate, now = new Date()) {
  return businessDaysSince(isoDate, { now, calendar: "exchange" }) ?? 0;
}

export function FedPathCard({ effr, feed = null, onSaved = null }) {
  const [data, setData] = useState(null);
  const [price, setPrice] = useState("");
  const [contract, setContract] = useState("Dec-2026");
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { fetch("/api/manual-entry").then(r => r.json()).then(j => setData(j.fedPath || null)).catch(() => {}); }, []);

  const px = Number(String(price).replace(/,/g, ""));
  const preview = Number.isFinite(px) && px > 90 && px < 101 ? +(100 - px).toFixed(4) : null;
  const previewMoves = (preview != null && effr != null) ? +((preview - effr) / 0.25).toFixed(2) : null;

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ fedPath: { price: px, contract, effr: effr ?? null, date: new Date().toISOString().slice(0, 10) } }),
      });
      const j = await r.json();
      if (r.ok) { setData(d => ({ ...(d || {}), latest: j.fedPath })); setPrice(""); setMsg({ ok: true, text: `Saved — implied ${j.fedPath?.impliedRate}%` }); onSaved?.(); }
      else setMsg({ ok: false, text: j.error || "save failed" });
    } catch (e) { setMsg({ ok: false, text: String(e.message) }); }
    setSaving(false);
  }

  // ── FED, WITH THE HAND ENTRY AS THE OVERRIDE ──
  // The ZQ strip comes from api/indicators.js (Yahoo, last daily close). The typed settle still
  // wins for its own date — a settle is a better number than a delayed close — but a feed row
  // dated later than the last entry is the current one, and the daily hand entry is no longer
  // the only way this card stays alive.
  const feedRow = (() => {
    const c = feed?.ok ? (feed.contracts || []).find(x => x.ok && x.label === contract) : null;
    if (!c) return null;
    return { date: c.date, contract: c.label, price: c.price, impliedRate: c.impliedRate, effr: feed.effr ?? null, movesPriced: c.movesPriced ?? null, source: "feed" };
  })();
  const manualRow = data?.latest ? { ...data.latest, source: "entry" } : null;
  const L = (manualRow && feedRow) ? (manualRow.date >= feedRow.date ? manualRow : feedRow) : (manualRow || feedRow);
  // C2 — suppress the derived hike/cut count once the entry is >3 business days old.
  const staleBiz = L?.date ? bizDaysSince(L.date) : 0;
  const suppressDerived = staleBiz > 3;
  // The divergence between this and the qualitative Fed read IS the story when they disagree.
  const diverges = !suppressDerived && L?.movesPriced != null && Math.abs(L.movesPriced) >= 1;
  return (
    <Card>{/* I.2 — informational: no status badge, so no accent bar. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>📈 Market-implied Fed path</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>ZQ 30-day fed funds futures · {feed?.ok ? "fed from the CBOT strip, hand entry overrides for its own date" : "manual entry (feed unavailable)"}</span>
      </div>
      {L ? (
        <>
          <div style={{ fontSize: 20, fontWeight: 900, color: C.text }}>
            {L.impliedRate}% <span style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>implied · {L.contract || "—"}</span>
          </div>
          <div style={{ fontSize: 12.5, color: suppressDerived ? C.amber : diverges ? C.amber : C.mid, fontWeight: (suppressDerived || diverges) ? 800 : 600, marginTop: 2 }}>
            {suppressDerived
              ? `derived hike/cut count suppressed — ${L.source === "feed" ? "last close" : "entry"} ${staleBiz} business days old`
              : L.movesPriced == null ? "no EFFR to compare against"
              : `${Math.abs(L.movesPriced).toFixed(1)} × 25bp ${L.movesPriced >= 0 ? "HIKES" : "CUTS"} priced vs EFFR ${L.effr}%`}
          </div>
          {/* ── WHAT 1.3 HIKES ACTUALLY MEANS ──
              The card showed three correct numbers and explained none of them. "1.3 × 25bp HIKES"
              is not a thing that can happen — the Fed moves in quarter points, so a fractional
              count is a probability wearing the clothes of a forecast. Said in words, with the two
              whole moves it sits between shown underneath so the arithmetic can be checked rather
              than taken on trust. */}
          {(() => {
            // The same gate the count above uses: a stale entry must not gain an explanation it
            // has not earned.
            if (suppressDerived) return null;
            const r = pathReading(L.impliedRate, L.effr, { contract: L.contract || null });
            if (!r) return null;
            const rungs = ladder(L.effr, { steps: Math.max(2, r.upper + 1) });
            return (
              <div style={{ marginTop: 6, padding: "7px 10px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 7 }}>
                <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5 }}>{r.sentence}</div>
                <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 4 }}>
                  {rungs.map(x => `${x.moves} = ${x.rate.toFixed(2)}%`).join("  ·  ")}
                  {"  ·  priced "}<b style={{ color: C.mid }}>{L.impliedRate}%</b>
                </div>
              </div>
            );
          })()}
          {feed?.ok && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6, fontSize: 10.5, color: C.mid }} title={`${feed.source} · EFFR ${feed.effr ?? "—"} (${feed.effrSource || "no EFFR"})`}>
              {(feed.contracts || []).filter(c => c.ok).map(c => (
                <button key={c.code} onClick={() => setContract(c.label)}
                  style={{ cursor: "pointer", background: c.label === contract ? C.blue : C.surf, color: c.label === contract ? C.onFill : C.mid, border: "1.5px solid " + (c.label === contract ? C.blue : C.bdr), borderRadius: 999, padding: "2px 9px", fontSize: 10.5, fontWeight: 700 }}>
                  {c.label.slice(0, 3)} {c.impliedRate.toFixed(2)}%
                </button>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 2 }}>
            ZQ {L.price} (100 − price = implied rate) · {L.source === "feed" ? `last close ${L.date} · feed` : `entered ${L.date}`}
            {kofiaStale(L.date) ? <StaleChip>re-enter</StaleChip> : null}
          </div>
          {/* The three things the number does NOT say, stated once so the card cannot imply them.
              The month-average point is the one that changes a reading: a hike landing mid-December
              counts for half of December, so the count is a FLOOR on where the rate ends up. */}
          <details style={{ marginTop: 5 }}>
            <summary style={{ fontSize: 10.5, color: C.lbl, cursor: "pointer", fontWeight: 700 }}>▼ what this number does not say</summary>
            <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11, color: C.mid, lineHeight: 1.55 }}>
              {FED_PATH_CAVEATS.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </details>
        </>
      ) : (
        <div style={{ fontSize: 12.5, color: C.muted }}>No entry yet — add today's ZQ settle below.</div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginTop: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>ZQ price</div>
          <input value={price} onChange={e => setPrice(e.target.value)} placeholder="96.160"
            style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 110 }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Contract</div>
          <input value={contract} onChange={e => setContract(e.target.value)} placeholder="Dec-2026"
            style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 110 }} />
        </div>
        {preview != null && (
          <div style={{ fontSize: 12, color: C.mid, fontWeight: 700, paddingBottom: 6 }}>
            → {preview}%{previewMoves != null ? ` · ${Math.abs(previewMoves).toFixed(1)}×25bp ${previewMoves >= 0 ? "hikes" : "cuts"}` : ""}
          </div>
        )}
        <Btn onClick={save} disabled={saving || preview == null} color={C.blue} bgColor={C.blBg} label={saving ? "⏳ Saving…" : "💾 Save"} />
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
    </Card>
  );
}

// Aug-22 Part B — cash-yield vs a bank term deposit on a LIKE-FOR-LIKE basis. Three adjustments make
// the comparison valid: compounding (SEC 30-day is annualised-simple → an APY column), withholding
// (0% VERIFIED on USFR per the Jul 30 2026 distribution; SGOV UNVERIFIED until one is observed), and
// liquidity (a locked deposit defeats a bucket held for deployment). Bank rate + WHT + size are manual.
// ── THE USFR SEC-YIELD ENTRY ── one form, used by the Cash card and the Data health hand-entry hub.
// The figure cannot be fetched (the issuer answers 403 to scripts), so this makes it a paste: the
// issuer link, the exact field, and the fund's own as-of date. `onSaved` receives the store's
// secYields after a successful save.
export function UsfrSecYieldForm({ liveInd, onSaved = null }) {
  const [form, setForm] = useState({ paste: "", value: "", asOf: "" });
  const [saveMsg, setSaveMsg] = useState(null);
  const setEntered = (v) => { if (onSaved) onSaved(v); };
  return (
    <div style={{ marginTop: 6, padding: "7px 9px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 7 }}>
      <div style={{ fontSize: 10.5, color: C.lbl, fontWeight: 700, marginBottom: 4 }}>
        Update USFR — <a href={ISSUER_PAGE.USFR.url} target="_blank" rel="noreferrer" style={{ color: C.blue }}>
          {ISSUER_PAGE.USFR.label}</a>, copy &ldquo;{ISSUER_PAGE.USFR.field}&rdquo; and its as-of date
      </div>
      {/* PASTE THE WHOLE THING. Retyping two numbers you are looking at is where the wrong
          digit comes from, and the only reason this field exists is that the figure cannot be
          fetched — so the hand path should be as close to a copy as it can be. Select the line
          on the issuer page and drop it here; the two fields below fill in and stay editable. */}
      <input value={form.paste}
        onChange={e => {
          const text = e.target.value;
          const p = parseSecYieldPaste(text);
          setForm(f => ({ ...f, paste: text,
            value: p.value != null ? String(p.value) : f.value,
            asOf: p.asOf || f.asOf }));
          // TWO PERCENTAGES IN ONE PASTE IS AMBIGUOUS. "SEC 30-Day Yield" sits beside "12m
          // Trailing Yield" on both pages, and taking the first silently is how the wrong one
          // gets saved. It still fills — and it says which it took.
          // Anchored on the "30-day SEC yield" label, so a paste of the whole header block
          // takes the right figure rather than the first one — WisdomTree prints the
          // DISTRIBUTION yield first, 14bp away and entirely plausible. Only an UNANCHORED
          // paste with several figures needs a warning; an anchored one already knows.
          setSaveMsg(!p.anchored && p.ambiguous
            ? { ok: false, text: `That paste had ${p.ambiguous.length} percentages (${p.ambiguous.join("%, ")}%) and no "30-day SEC yield" label to anchor on — took ${p.value}%. Check it is the SEC yield, not the distribution or trailing one.` }
            : p.anchored && p.ambiguous
            ? { ok: true, text: `Took ${p.value}% from beside the "30-day SEC yield" label (the paste held ${p.ambiguous.length} figures).` }
            : null);
        }}
        placeholder="paste the line from the issuer page, or fill the fields below"
        style={{ width: "100%", boxSizing: "border-box", fontSize: 12, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, marginBottom: 5 }} />
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} placeholder="3.71%"
          style={{ fontSize: 13, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 78 }} />
        {/* A NATIVE DATE INPUT, so the as-of is picked from a calendar rather than typed in a
            format the reader has to remember. `max` is today: the issuer's figure is dated to a
            business day already past, and a future one is a typo the server refuses anyway. */}
        <input type="date" value={form.asOf} max={new Date().toISOString().slice(0, 10)}
          onChange={e => setForm(f => ({ ...f, asOf: e.target.value }))}
          style={{ fontSize: 13, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6 }} />
        <button onClick={async () => {
          setSaveMsg(null);
          // Parsed here too, so the typed path and the pasted path accept the same things —
          // a form that takes "3.68%" only when pasted is a form with two rules.
          const value = parseYieldValue(form.value);
          if (value == null) { setSaveMsg({ ok: false, text: `"${form.value}" is not a yield — a number, with or without the % sign` }); return; }
          try {
            const r = await fetch("/api/manual-entry", { method: "POST", credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ secYield: { ticker: "USFR", value, asOf: form.asOf,
                                                 dtb3AtAsOf: liveInd?.tbill3m ?? null } }) });
            const j = await r.json();
            if (!r.ok) { setSaveMsg({ ok: false, text: j?.error || `HTTP ${r.status}` }); return; }
            setEntered(j?.secYields || null);
            setForm({ paste: "", value: "", asOf: "" });
            setSaveMsg({ ok: true, text: `Saved — USFR ${j?.secYields?.USFR?.value}% as of ${j?.secYields?.USFR?.asOf}` });
          } catch (e) { setSaveMsg({ ok: false, text: String(e?.message || e) }); }
        }} style={{ fontSize: 12, fontWeight: 700, padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                    border: "1.5px solid " + C.bdr, background: C.surf, color: C.mid }}>Save</button>
      </div>
      {saveMsg ? <div style={{ fontSize: 11, marginTop: 4, fontWeight: 700, color: saveMsg.ok ? C.green : C.amber }}>{saveMsg.text}</div> : null}
    </div>
  );
}

// ── THE ISM ENTRY ────────────────────────────────────────────────────────────
// One print a month, from the release, into data/manual_entry.json by the same route as the Fed
// path. The growth leg ages it from the release date and drops it after thirty-five days, so a
// missed month reads as a missing input rather than as last month's economy.
export function IsmEntryPanel({ entry, feed = null, onChange }) {
  const lastMonth = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  const [period, setPeriod] = useState(lastMonth);
  const [pmi, setPmi] = useState("");
  const [orders, setOrders] = useState("");
  const [services, setServices] = useState("");
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  // The month shown is the feed merged with the hand entry (lib/ismFeed.js mergeIsm); saving still writes the hand entry.
  const L = mergeIsm(feed?.ok ? feed : null, entry).latest;
  const auto = !!feed?.ok && L?.source === "prnewswire";
  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ ism: { period, manufacturing: pmi, newOrders: orders === "" ? null : orders, services: services === "" ? null : services, asOf } }),
      });
      const j = await r.json();
      if (r.ok) {
        const fresh = await fetch("/api/manual-entry").then(x => x.json()).catch(() => null);
        if (fresh?.ism) onChange(fresh.ism); else onChange({ latest: j.ism, series: [...(entry?.series || []), j.ism] });
        setPmi(""); setOrders(""); setServices(""); setOpen(false);
        setMsg({ ok: true, text: `Saved ISM ${j.ism?.manufacturing} for ${j.ism?.period}` });
      } else setMsg({ ok: false, text: j.error || "save failed" });
    } catch (e) { setMsg({ ok: false, text: String(e.message) }); }
    setSaving(false);
  }
  const inp = (v, set, ph, w = 64) => (
    <input value={v} onChange={e => set(e.target.value)} placeholder={ph} inputMode="decimal"
      style={{ width: w, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} />
  );
  return (
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {auto ? <span style={{ fontSize: 10.5, fontWeight: 800, color: C.green, textTransform: "uppercase", letterSpacing: 0.4 }}>auto · ISM via PR Newswire</span>
              : <HandKept asOf={L?.asOf || null} cadenceDays={35} what="from the ISM release, first business day of the month" />}
        {L ? <span style={{ fontSize: 11.5, color: C.mid }}>ISM {L.manufacturing}{L.newOrders != null ? ` · new orders ${L.newOrders}` : ""}{L.services != null ? ` · services ${L.services}` : ""} · {L.period}{L.asOf ? ` · released ${L.asOf}` : ""}{L.source === "hand" || L.source === "hand+prnewswire" ? " · typed" : ""}</span>
           : <span style={{ fontSize: 11.5, color: C.amber }}>no ISM reading{feed && !feed.ok ? ` — PR Newswire feed: ${feed.error || "no answer"}` : ""}</span>}
        <button onClick={() => setOpen(o => !o)}
          style={{ cursor: "pointer", background: C.surf, color: C.mid, border: "1.5px solid " + C.bdr, borderRadius: 999, padding: "3px 10px", fontSize: 11, fontWeight: 700 }}>
          {open ? "close" : auto ? "override a month" : "enter this month"}
        </button>
        {msg && <span style={{ fontSize: 11.5, color: msg.ok ? C.green : C.amber, fontWeight: 700 }}>{msg.text}</span>}
      </div>
      {open && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11.5, color: C.muted }}>
          <span>month</span><input type="month" value={period} onChange={e => setPeriod(e.target.value)} style={{ padding: "4px 6px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12, background: C.surf, color: C.text }} />
          <span>PMI</span>{inp(pmi, setPmi, "48.7")}
          <span>new orders</span>{inp(orders, setOrders, "47.1")}
          <span>services</span>{inp(services, setServices, "52.0")}
          <span>released</span><input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} style={{ padding: "4px 6px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12, background: C.surf, color: C.text }} />
          <button onClick={save} disabled={saving || pmi === ""}
            style={{ cursor: "pointer", background: C.blue, color: C.onFill, border: "none", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 800, opacity: (saving || pmi === "") ? 0.5 : 1 }}>
            {saving ? "saving…" : "save"}
          </button>
        </div>
      )}
    </div>
  );
}

// The automatic state, as a block: what the scan found, what the MoF has published.
const fmtMofDay = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" });
export function InterventionAutoBlock({ auto, compact = false }) {
  if (!auto) return null;
  const l = auto.latest, st = l?.confirmation?.status;
  const tok = !auto.active ? { color: C.muted, bg: C.inset, bdr: C.bdr } : st === "confirmed" ? STATUS.ELEVATED : STATUS.WATCH;
  const grade = !l ? null : st === "confirmed" ? "CONFIRMED" : st === "denied" ? "DENIED" : "SUSPECTED";
  const recentMonths = (auto.mof?.monthly || []).slice(0, 3);
  return (
    <div style={{ padding: "8px 11px", background: tok.bg, border: "1px solid " + tok.bdr, borderRadius: 8, fontSize: 11.5, lineHeight: 1.55 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" }}>
        <b style={{ color: tok.color }}>⚑ Yen intervention · automatic</b>
        <span style={{ color: auto.active ? tok.color : C.muted, fontWeight: 700 }}>
          {auto.active ? `${grade} ${l.firedOn}` : l ? `last signature ${l.firedOn} (${grade.toLowerCase()}), no longer live` : "no signature in the last month"}
        </span>
      </div>
      {l && (auto.active || !compact) && (
        <div style={{ color: C.mid, marginTop: 2 }}>
          USD/JPY {l.movePct}% in {l.windowMin} min from {l.from} ({l.fromHighPct}% off its 60-day high){l.dxyPct != null ? `; DXY ${l.dxyPct}%, the yen moved ${l.yenOverDxy ?? "far more"}× as far` : ""}. {l.confirmation?.why}.
        </div>
      )}
      {!compact && auto.mof && (
        <div style={{ color: C.muted, marginTop: 3 }}>
          MoF: {auto.mof.days.length ? `daily data through ${auto.mof.coveredThrough} — ${auto.mof.days.slice(-4).map(d => `${fmtMofDay(d.date)} ¥${(d.amount100mYen / 1e4).toFixed(2)}tn`).join(", ")}` : `no operations in the daily data through ${auto.mof.coveredThrough}`}
          {recentMonths.length ? ` · monthly: ${recentMonths.map(m => `${fmtMofDay(m.from)}–${fmtMofDay(m.to)} ¥${m.totalBillionYen ? `${(m.totalBillionYen / 1000).toFixed(1)}tn` : "0"}`).join(", ")}` : ""}
        </div>
      )}
      {!compact && (
        <div style={{ color: C.lbl, fontSize: 10.5, marginTop: 3 }}>
          Suspected when USD/JPY falls ≥1.0% in an hour (or ≥1.5% in three), ≥2× DXY's move, within 3% of its 60-day high; confirmed or denied from the MoF's daily CSV and monthly totals.
          {auto.sources?.scan?.at ? ` Scan ${dubaiEt(auto.sources.scan.at)}.` : auto.sources?.scan?.error ? ` Scan failed: ${auto.sources.scan.error}.` : ""}
          {auto.sources?.mof?.error ? ` MoF fetch failed: ${auto.sources.mof.error} — events stay SUSPECTED.` : ""}
        </div>
      )}
    </div>
  );
}

// Task 1b — manual-entry panel for the recession sources, on the same POST-to-/api/manual-entry
// pattern as the KOFIA / fed-path / intervention panels. Source dropdown → probability → as-of →
// notes → save; a save writes an override keyed by recessionSrcKey that outranks the live feed and
// the static default, and Clear removes it. Always rendered; an unauthenticated save 401s and the
// error is shown inline (no client-side gate — the cookie check lives on the server).
export function RecessionEntryPanel({ overrides, onSaved }) {
  const options = RECESSION_SOURCES.map((r) => ({
    key: recessionSrcKey(r),
    label: r.name + (r.year === 2027 ? " · End-2027" : ""),
  }));
  const [sel, setSel] = useState(options[0].key);
  const [prob, setProb] = useState("");
  const [asOf, setAsOf] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const current = overrides?.[sel] || null;
  // Prefill from the existing override when the operator switches source, so an edit starts from
  // what is stored rather than blank. Deliberately keyed on `sel` only — retyping should not be
  // clobbered by a background refresh of `overrides`.
  useEffect(() => {
    setProb(current?.probability != null ? String(current.probability) : "");
    setAsOf(current?.asOf || "");
    setNotes(current?.notes || "");
    setMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  async function save(clear = false) {
    if (!clear && !/\d/.test(prob)) { setMsg({ ok: false, text: "enter a probability (a number, e.g. 22 or ~18%)" }); return; }
    if (!clear && asOf.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(asOf.trim())) { setMsg({ ok: false, text: "as-of must be YYYY-MM-DD" }); return; }
    setSaving(true); setMsg(null);
    try {
      const body = clear
        ? { recession: { name: sel, clear: true } }
        : { recession: { name: sel, probability: prob.trim(), asOf: asOf.trim() || null, notes: notes.trim() || null } };
      const r = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        const fresh = await fetch("/api/manual-entry").then((x) => x.json()).catch(() => null);
        onSaved?.(fresh?.recession || {});
        setMsg({ ok: true, text: clear ? "Override cleared — feed/static value restored" : `Saved — ${sel} now ${/%/.test(prob) ? prob : prob + "%"}` });
        if (clear) { setProb(""); setAsOf(""); setNotes(""); }
      } else setMsg({ ok: false, text: j.error || "save failed" });
    } catch (e) { setMsg({ ok: false, text: String(e.message) }); }
    setSaving(false);
  }

  const inp = { padding: "6px 9px", fontSize: 12, border: "1px solid " + C.bdrMd, borderRadius: 6, background: C.surf, color: C.text };
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <SLabel>✍️ Manual recession-source entry</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>overrides the feed &amp; static value · commits to the store</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ ...inp, flex: "1 1 210px", minWidth: 0 }}>
          {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <input value={prob} onChange={(e) => setProb(e.target.value)} placeholder="probability (e.g. 22 or ~18%)"
          style={{ ...inp, flex: "1 1 150px", minWidth: 0 }} />
        <input value={asOf} onChange={(e) => setAsOf(e.target.value)} placeholder="as-of (YYYY-MM-DD)"
          style={{ ...inp, flex: "1 1 130px", minWidth: 0 }} />
      </div>
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="notes (optional)"
        style={{ ...inp, width: "100%", marginTop: 8, boxSizing: "border-box" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => save(false)} disabled={saving}
          style={{ background: C.blue, color: C.onFill, border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 12.5, fontWeight: 800, cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save override"}
        </button>
        {current && (
          <button onClick={() => save(true)} disabled={saving}
            style={{ background: C.surf, color: C.mid, border: "1.5px solid " + C.bdrMd, borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: saving ? "wait" : "pointer" }}>
            Clear override
          </button>
        )}
        {current && (
          <span style={{ fontSize: 11, color: C.blue, fontWeight: 700 }}>
            active: {current.probability}{current.asOf ? ` · ${current.asOf}` : ""}
          </span>
        )}
      </div>
      {msg && <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 8, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
    </Card>
  );
}
