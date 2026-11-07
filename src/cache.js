// src/cache.js — the browser's copy of a payload, read and written without ever throwing. A private
// window or a full quota stores nothing; none of what is cached is load-bearing.
export function cacheLoad(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; }
  catch (_) { return fallback; }
}
export function cacheSave(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* storage refused — a private window stores nothing, and none of this is load-bearing */ }
}
