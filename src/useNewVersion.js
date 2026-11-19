// src/useNewVersion.js — has a newer build shipped since this tab loaded?
//
// The app is one long-lived tab. Without this, a tab opened before a deploy keeps the old code with
// nothing on screen to say so, and a feature that just shipped is simply not there (19 Nov: the
// level tape, live on the server, invisible in a tab from the evening before). public/version.json
// is stamped per build (scripts/write-version.mjs); the first read is this tab's build, and any
// later read naming a different commit means a reload is due.
import { useEffect, useState } from "react";

const EVERY_MS = 10 * 60000;

async function shaNow() {
  try {
    const r = await fetch("/version.json", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json())?.sha || null;
  } catch { return null; }
}

export function useNewVersion() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let mine = null, alive = true;
    const check = async () => {
      const now = await shaNow();
      if (!alive || !now) return;
      if (!mine) { mine = now; return; }
      if (now !== mine) setStale(true);
    };
    check();
    const t = setInterval(check, EVERY_MS);
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  return stale;
}
