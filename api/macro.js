// api/macro.js — macro reads: the FRED/Yahoo series (/api/indicators) and the composed regional
// read (/api/playbook). Public by declaration: no positions, no sizes.
// The routes live in lib/routes/; lib/routes/dispatch.js says why they share one function.
import indicators from '../lib/routes/indicators.js';
import playbook from '../lib/routes/playbook.js';
import { dispatch } from '../lib/routes/dispatch.js';

export default dispatch('macro', { indicators, playbook });
