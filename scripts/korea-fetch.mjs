#!/usr/bin/env node
// scripts/korea-fetch.mjs — read KOFIA and the KRX investor-flow widget, merge into
// data/korea_kofia.json. Run by .github/workflows/korea-fetch.yml, which commits the file.
//
// Replaces the daily paste for everything except the CSOP 7709 units (CSOP refuses automated
// requests). The paste stays as the fallback, through the same merge (lib/koreaStore.js). The
// fetch itself, its checks, and the lastFetch stamp live in lib/koreaFetch.js, shared with the
// panel's Fetch now button.
//
// The file is written on every run, because lastFetch changes even when no reading does — the
// panel's "last fetched" line is how anyone can tell a quiet day from a run that never happened.
// A source that fails is recorded there too, and the exit code is non-zero so the workflow goes red.
//
//   node scripts/korea-fetch.mjs            fetch, merge, write
//   node scripts/korea-fetch.mjs --dry      fetch and report, write nothing
import { readFileSync, writeFileSync } from 'node:fs';
import { normaliseStore } from '../lib/koreaStore.js';
import { fetchKoreaInto } from '../lib/koreaFetch.js';

const PATH = 'data/korea_kofia.json';
const DRY = process.argv.includes('--dry');
const by = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? 'manual run' : 'schedule';

const store = normaliseStore(JSON.parse(readFileSync(PATH, 'utf8')));
const { changed, failed, report } = await fetchKoreaInto(store, { by });
for (const line of report) console.log(line);
console.log(changed ? 'readings changed' : 'no new readings');
if (DRY) console.log('dry run — not written');
else writeFileSync(PATH, JSON.stringify(store, null, 2) + '\n');
process.exit(failed ? 1 : 0);
