// src/pages/nav.js — the dashboard's pages, in nav order.
//
// ONE ROW OF PAGES (7 Nov 2026). The nav used to be four groups (Markets / Tickers / Book / Plan)
// with a second row of tabs under each, and Data health off to the side behind a status dot. Two
// clicks to reach most views, and the groups mixed things you read every morning with research you
// open once a week. Now each page is one job, in the order a day runs:
//
//   Today → Markets → Gamma → Ticker → Book → Risk & Plan → Research → Ops
//
// A page with one view has no second row; a page with several (Markets, Risk & Plan, Research)
// shows its views underneath. Every view keeps its id, so the Go bar (lib/goCommands.js), the error
// boundary and any saved link still land where they did. Rules & Alerts joins between Risk & Plan
// and Research when the alert module is one place (build step 5).
//
// `dot: true` marks the page whose pill carries the data-health dot (green / amber / red).
export const PAGES = Object.freeze([
  { id: "today",    label: "Today",       title: "Daily Overview: the day's read across regions", tabs: [
    { id: "global",    label: "🌏 Daily Overview" },
  ] },
  { id: "markets",  label: "Markets",     title: "The measured state, its drivers, ratios and the calendar", tabs: [
    { id: "state",     label: "🧭 State"    },
    { id: "drivers",   label: "📈 Drivers"  },
    { id: "ratios",    label: "⚖️ Ratios"   },
    { id: "calendar",  label: "📅 Calendar" },
  ] },
  { id: "gamma",    label: "Gamma",       title: "Dealer gamma by underlying", tabs: [
    { id: "gex",       label: "🌀 Gamma" },
  ] },
  { id: "ticker",   label: "Ticker",      title: "One name: its page", tabs: [
    { id: "ticker",    label: "🔎 Ticker" },
  ] },
  { id: "book",     label: "Book",        title: "The console: positions, fills, cards", tabs: [
    { id: "console",   label: "🎚️ Console" },
  ] },
  { id: "risk",     label: "Risk & Plan", title: "Posture by regime, hedges and income", tabs: [
    { id: "plan",      label: "🎯 Plan"   },
    { id: "insurance", label: "🛡️ Hedges" },
    { id: "income",    label: "💰 Income" },
  ] },
  { id: "research", label: "Research",    title: "Smart Money (13F) and the paper trial", tabs: [
    { id: "street",    label: "🏦 Smart Money" },
    { id: "mls",       label: "🧪 Paper trial" },
  ] },
  { id: "ops",      label: "Ops",         title: "Data health and job health", dot: true, tabs: [
    { id: "health",    label: "🩺 Data health" },
  ] },
]);

// Every view, flat — what the error boundary and the Go bar look up by id.
export const VIEWS = Object.freeze(PAGES.flatMap(p => p.tabs));

// The page a view sits on. Derived from the open view, never stored beside it: two sources of truth
// for "where am I" is how a nav ends up highlighting one thing while showing another.
export const pageOf = (viewId) => PAGES.find(p => p.tabs.some(t => t.id === viewId)) || PAGES[0];
