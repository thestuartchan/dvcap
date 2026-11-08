// api/inputs.js — hand-kept inputs and the session: the manual-entry store (/api/manual-entry),
// the Korea flow paste (/api/korea-save) and the dashboard login (/api/login). Each route keeps
// its own gate: login is public (it issues the cookie); the other two require it.
// The routes live in lib/routes/; lib/routes/dispatch.js says why they share one function.
import manualEntry from '../lib/routes/manual-entry.js';
import koreaSave from '../lib/routes/korea-save.js';
import login from '../lib/routes/login.js';
import { dispatch } from '../lib/routes/dispatch.js';

export default dispatch('inputs', { 'manual-entry': manualEntry, 'korea-save': koreaSave, login });
