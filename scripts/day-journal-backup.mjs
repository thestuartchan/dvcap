#!/usr/bin/env node
// scripts/day-journal-backup.mjs — the day-trading journal's Google Drive backup, as files.
//
//   node scripts/day-journal-backup.mjs <db-dir> <out-dir> [--weeks=2026-W40,2026-W41]
//
// <db-dir>   the journal's database as ArtifactData `list` saved it with out_dir:
//            weeks/<week>.json, marks/<id>.json, rules/<id>.json, meta/sync.json
// <out-dir>  receives:
//   notes.json            the hand-entered part — copy-trade marks and rule sets — plus meta/sync.
//                         Small, and the one thing no sync can rebuild, so it is backed up whole every run.
//   journal-YYYY-MM.json  one per calendar month: that month's week documents. A week belongs to the
//                         month of its Thursday (the ISO rule), so every week is in exactly one file.
//   manifest.json         per file: Drive title, sha256, bytes, weeks — what the routine checks an
//                         upload against after downloading it back.
// --weeks    only the months holding these weeks (the ones a sync just wrote), plus notes.json.
//            Without it, every month: the full baseline.
//
// The files hold the user's trades: never print them, commit them or post them anywhere public.
// Only names, sizes and hashes are printed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const [dbDir, outDir] = args.filter(a => !a.startsWith('--'));
if (!dbDir || !outDir) {
  console.error('usage: day-journal-backup.mjs <db-dir> <out-dir> [--weeks=2026-W40,2026-W41]');
  process.exit(2);
}
const readDir = (sub) => {
  const dir = path.join(dbDir, sub);
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(f => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]));
};

// "2026-W41" → "2026-10": the month of that ISO week's Thursday.
export function monthOfWeek(week) {
  const [y, n] = String(week).split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const thu = new Date(jan4);
  thu.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (n - 1) * 7 + 3);
  return thu.toISOString().slice(0, 7);
}

const weeks = readDir('weeks'), marks = readDir('marks'), rules = readDir('rules'), meta = readDir('meta');
if (!Object.keys(weeks).length) { console.error('no weeks found — refusing to write an empty backup'); process.exit(1); }
const only = flag('weeks') ? new Set(flag('weeks').split(',').map(monthOfWeek)) : null;
const at = new Date().toISOString();
const head = { kind: 'dvcap-day-journal-backup', v: 1, exportedAt: at, artifact: 'https://claude.ai/artifact/DrGeeSKdFLn9aqY9SHLMeb' };

const files = { 'notes.json': { ...head, part: 'notes', meta: meta.sync ?? null, marks, rules } };
const byMonth = {};
for (const [w, doc] of Object.entries(weeks)) (byMonth[monthOfWeek(w)] ||= {})[w] = doc;
for (const [m, ws] of Object.entries(byMonth).sort()) {
  if (only && !only.has(m)) continue;
  files[`journal-${m}.json`] = { ...head, part: m, weeks: ws };
}

fs.mkdirSync(outDir, { recursive: true });
const manifest = {};
for (const [name, body] of Object.entries(files)) {
  // Compact, one trade per line: short lines can be read back and pasted into the upload call
  // exactly, and a month reads in Drive's preview. Whitespace between tokens: still the same JSON.
  const text = JSON.stringify(body).replace(/\},\{"avgIn"/g, '},\n{"avgIn"');
  fs.writeFileSync(path.join(outDir, name), text);
  manifest[name] = { title: `dvcap day journal · ${name}`, sha256: crypto.createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text), weeks: body.weeks ? Object.keys(body.weeks) : [] };
  console.log(`${name}  ${manifest[name].bytes} bytes  ${manifest[name].weeks.length ? manifest[name].weeks.join(',') : `${Object.keys(marks).length} marks, ${Object.keys(rules).length} rules`}`);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
