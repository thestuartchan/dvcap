// src/jobHealth.js — the scheduler's job states (/api/regime-log?tick=status, lib/cronRouter.js
// statusView), fetched once for the Data health tab's panel (MarketState.jsx JobHealth) and the
// header's health pill, refreshed every five minutes. Its own module: a component file that also
// exports hooks breaks fast refresh.
import { useState, useEffect } from "react";

export function useJobHealth() {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch("/api/regime-log?tick=status", { credentials: "include" }).then(r => r.json())
      .then(j => { if (live) setSt(Array.isArray(j?.jobs) ? j : { error: j?.error || "not loaded" }); })
      .catch(e => { if (live) setSt({ error: String(e?.message || e) }); });
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return st;
}
// The header pill's words for the job state: null when every job is fine.
export function jobHealthNote(st) {
  const s = st?.summary;
  if (!s) return null;
  const bad = s.failed + s.missed;
  return bad ? `${bad} scheduled job${bad === 1 ? "" : "s"} ${s.failed && s.missed ? "failed or missed" : s.failed ? "failed" : "missed"}` : null;
}
