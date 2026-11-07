// src/pages/regions.js — the three regions the Daily Overview reads, in session order. Its own module
// because App (which regions are toggled on) and the Today page both need it, and a component
// module that also exports a constant cannot hot-reload.
export const PB_REGIONS = [
  { id: "asia", label: "🌏 Asia" },
  { id: "eu",   label: "🇪🇺 Europe" },
  { id: "us",   label: "🇺🇸 US" },
];
