// lib/overviewRegions.js — which region's read heads the Daily Overview, and each region's own stamp.
//
// In "All" the headline (the stance card, scenario board, tripwires, the read) came from whichever
// region was first in the selection, which was Asia: a US-hours reader got the Asia close's
// stance. US leads now (Stu, 18 Oct 2026), then Europe, then Asia, whichever of them has loaded.
// The three regions are fetched separately and can succeed or fail separately, so each carries
// its own fetch time and its own error instead of one shared stamp that the last fetch overwrote.

export const LEAD_ORDER = Object.freeze(['us', 'eu', 'asia']);

// The region whose payload heads the page: the first of LEAD_ORDER that is selected and loaded.
// Null when nothing selected has loaded.
export function leadRegion(regions = [], byRegion = {}) {
  const on = new Set(regions);
  return LEAD_ORDER.find(r => on.has(r) && byRegion?.[r]) || regions.find(r => byRegion?.[r]) || null;
}

// One row per selected region, in lead order: when it was fetched, whether that copy is old,
// and what went wrong if the last fetch failed.
export function regionStamps(regions = [], { updatedBy = {}, errorBy = {}, byRegion = {}, now = new Date(), staleHours = 12 } = {}) {
  const on = new Set(regions);
  return LEAD_ORDER.filter(r => on.has(r)).map(r => {
    const at = updatedBy?.[r] ? new Date(updatedBy[r]) : null;
    const ok = at && !Number.isNaN(at.getTime());
    const ageH = ok ? (now.getTime() - at.getTime()) / 3.6e6 : null;
    return { region: r, at: ok ? at : null, old: ageH != null && ageH > staleHours, error: errorBy?.[r] || null, loaded: !!byRegion?.[r] };
  });
}
