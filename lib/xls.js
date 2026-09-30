// lib/xls.js — just enough of the legacy Excel (.xls, BIFF8) format to read one table of numbers.
//
// WHY THIS EXISTS. The NY Fed publishes the ACM term premium only as ACMTermPremium.xls — a
// compound-file (OLE2) container holding a BIFF8 workbook — and asking for .csv serves the same
// binary. A spreadsheet library would be a heavy dependency for one column; this reads the
// container, the shared-string table and the three or four cell records a data table is made of,
// and nothing else (no formatting, no formulas beyond their cached numbers, no charts).
//
// readXls(buffer) → { sheets: [{ name, cells: Map<"r,c", value> , maxRow }] }
// Values are numbers or strings. Dates come back as the number Excel stores; excelDate() converts.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const i32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));
const u32 = (b, o) => i32(b, o) >>> 0;
const f64 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true);

// ── THE CONTAINER ────────────────────────────────────────────────────────────
// Header → the sector allocation table (listed in the header and continued in DIFAT sectors) →
// the directory → the "Workbook" stream's sector chain. Streams under the mini-stream cutoff live
// in the mini stream; a workbook large enough to matter never does, but it is handled.
export function readCfbStream(buf, names = ['Workbook', 'Book']) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u32(b, 0) !== 0xe011cfd0 || u32(b, 4) !== 0xe11ab1a1) throw new Error('not an OLE2 compound file');
  const ssz = 1 << u16(b, 30), mssz = 1 << u16(b, 32);
  const nFat = u32(b, 44), dirStart = i32(b, 48), cutoff = u32(b, 56);
  const miniFatStart = i32(b, 60), difatStart = i32(b, 68);
  const off = (s) => 512 + s * ssz;
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) fatSectors.push(i32(b, 76 + i * 4));
  for (let s = difatStart, guard = 0; s >= 0 && fatSectors.length < nFat && guard < 1e5; guard++) {
    const per = ssz / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < nFat; i++) fatSectors.push(i32(b, off(s) + i * 4));
    s = i32(b, off(s) + per * 4);
  }
  const fat = new Int32Array(fatSectors.length * (ssz / 4));
  fatSectors.forEach((s, k) => { for (let i = 0; i < ssz / 4; i++) fat[k * (ssz / 4) + i] = i32(b, off(s) + i * 4); });
  const chain = (start, table = fat) => { const out = []; for (let s = start, g = 0; s >= 0 && g < table.length; g++) { out.push(s); s = table[s]; } return out; };
  const readChain = (start, size) => {
    const out = new Uint8Array(size); let p = 0;
    for (const s of chain(start)) { const n = Math.min(ssz, size - p); if (n <= 0) break; out.set(b.subarray(off(s), off(s) + n), p); p += n; }
    return out;
  };
  // Directory entries, 128 bytes each.
  const dirSecs = chain(dirStart);
  const dir = [];
  for (const s of dirSecs) for (let e = 0; e < ssz / 128; e++) {
    const o = off(s) + e * 128, nameLen = u16(b, o + 64);
    let name = ''; for (let i = 0; i + 1 < nameLen - 1; i += 2) name += String.fromCharCode(u16(b, o + i));
    dir.push({ name, type: b[o + 66], start: i32(b, o + 116), size: u32(b, o + 120) });
  }
  const ent = dir.find(d => d.type === 2 && names.includes(d.name));
  if (!ent) throw new Error('no Workbook stream');
  if (ent.size >= cutoff) return readChain(ent.start, ent.size);
  // Mini stream: its sectors live inside the root entry's stream.
  const root = dir.find(d => d.type === 5);
  const miniStream = readChain(root.start, root.size);
  const mfatBytes = readChain(miniFatStart, chain(miniFatStart).length * ssz);
  const mfat = new Int32Array(mfatBytes.length / 4); for (let i = 0; i < mfat.length; i++) mfat[i] = i32(mfatBytes, i * 4);
  const out = new Uint8Array(ent.size); let p = 0;
  for (const s of chain(ent.start, mfat)) { const n = Math.min(mssz, ent.size - p); if (n <= 0) break; out.set(miniStream.subarray(s * mssz, s * mssz + n), p); p += n; }
  return out;
}

// ── THE WORKBOOK ─────────────────────────────────────────────────────────────
// RK: a packed number (30 bits of an int or the top of a double, optionally ÷100).
function rk(v) {
  const div = v & 1, isInt = v & 2;
  let n;
  if (isInt) n = v >> 2;
  else { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(4, v & 0xfffffffc, true); dv.setUint32(0, 0, true); n = dv.getFloat64(0, true); }
  return div ? n / 100 : n;
}

// The shared-string table is split across an SST record and CONTINUE records; a string's
// characters may cross a record boundary, and each continuation restarts with an encoding flag.
function readSst(parts) {
  const strings = [];
  let pi = 0, p = 8;                          // skip cstTotal, cstUnique
  let cur = parts[0];
  const need = () => { if (p >= cur.length && pi + 1 < parts.length) { cur = parts[++pi]; p = 0; } };
  const total = u32(parts[0], 4);
  for (let k = 0; k < total; k++) {
    need(); if (p >= cur.length) break;
    const cch = u16(cur, p); let flags = cur[p + 2]; p += 3;
    let rt = 0, sz = 0;
    if (flags & 0x08) { rt = u16(cur, p); p += 2; }
    if (flags & 0x04) { sz = u32(cur, p); p += 4; }
    let s = '', left = cch;
    while (left > 0) {
      if (p >= cur.length) { cur = parts[++pi]; p = 0; flags = cur[p]; p += 1; }
      const wide = flags & 1;
      const avail = wide ? Math.floor((cur.length - p) / 2) : cur.length - p;
      const n = Math.min(left, avail);
      for (let i = 0; i < n; i++) s += String.fromCharCode(wide ? u16(cur, p + i * 2) : cur[p + i]);
      p += n * (wide ? 2 : 1); left -= n;
    }
    // Rich-text runs and phonetic data follow; they too may cross a boundary.
    let skip = rt * 4 + sz;
    while (skip > 0) { const n = Math.min(skip, cur.length - p); p += n; skip -= n; if (skip > 0) { cur = parts[++pi]; p = 0; } }
    strings.push(s);
  }
  return strings;
}

function shortString(b, o) {                  // BOUNDSHEET name: cch (1 byte), flags, chars
  const cch = b[o], wide = b[o + 1] & 1; let s = '';
  for (let i = 0; i < cch; i++) s += String.fromCharCode(wide ? u16(b, o + 2 + i * 2) : b[o + 2 + i]);
  return s;
}
function longString(b, o) {                   // LABEL: cch (2 bytes), flags, chars
  const cch = u16(b, o), wide = b[o + 2] & 1; let s = '';
  for (let i = 0; i < cch; i++) s += String.fromCharCode(wide ? u16(b, o + 3 + i * 2) : b[o + 3 + i]);
  return s;
}

export function readXls(buf) {
  const w = readCfbStream(buf);
  const sheets = [];
  let sst = [];
  // Pass 1: globals (sheet list, shared strings).
  for (let p = 0; p + 4 <= w.length;) {
    const type = u16(w, p), len = u16(w, p + 2), d = w.subarray(p + 4, p + 4 + len);
    if (type === 0x0085) sheets.push({ name: shortString(d, 6), pos: u32(d, 0), cells: new Map(), maxRow: -1 });
    else if (type === 0x00fc) {
      const parts = [d]; let q = p + 4 + len;
      while (q + 4 <= w.length && u16(w, q) === 0x003c) { const l = u16(w, q + 2); parts.push(w.subarray(q + 4, q + 4 + l)); q += 4 + l; }
      sst = readSst(parts);
    } else if (type === 0x000a) break;          // end of the globals substream
    p += 4 + len;
  }
  // Pass 2: each sheet's substream, from its BOF to its EOF.
  for (const sh of sheets) {
    const set = (r, c, v) => { sh.cells.set(`${r},${c}`, v); if (r > sh.maxRow) sh.maxRow = r; };
    for (let p = sh.pos; p + 4 <= w.length;) {
      const type = u16(w, p), len = u16(w, p + 2), d = w.subarray(p + 4, p + 4 + len);
      p += 4 + len;
      if (type === 0x000a) break;
      if (type === 0x0203) set(u16(d, 0), u16(d, 2), f64(d, 6));                      // NUMBER
      else if (type === 0x027e) set(u16(d, 0), u16(d, 2), rk(u32(d, 6)));             // RK
      else if (type === 0x00fd) set(u16(d, 0), u16(d, 2), sst[u32(d, 6)] ?? null);    // LABELSST
      else if (type === 0x0204) set(u16(d, 0), u16(d, 2), longString(d, 6));          // LABEL
      else if (type === 0x00bd) {                                                     // MULRK
        const r = u16(d, 0), c0 = u16(d, 2), n = (len - 6) / 6;
        for (let i = 0; i < n; i++) set(r, c0 + i, rk(u32(d, 4 + i * 6 + 2)));
      } else if (type === 0x0006 && !(d[12] === 0xff && d[13] === 0xff)) set(u16(d, 0), u16(d, 2), f64(d, 6)); // FORMULA, numeric result
    }
  }
  return { sheets: sheets.map(({ name, cells, maxRow }) => ({ name, cells, maxRow })) };
}

// Excel's day count (1900 system): day 25569 is 1970-01-01.
export const excelDate = (n) => (Number.isFinite(n) ? new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10) : null);
