/*
 * Unbake engine — recovers the formulas hiding inside a spreadsheet that was
 * exported as plain values, then works out which typed cells are wrong and why.
 *
 * Pure JavaScript, no dependencies. Works in the browser (window.Unbake) and in
 * Node (module.exports).
 *
 * Pipeline
 *   1. Parse CSV, infer numeric columns (currency, thousands separators, %, (neg)).
 *   2. For every numeric column, search for the simplest relation that explains
 *      it exactly (up to the column's printed precision) on most rows:
 *        linear combinations of a feature library  {1, X, X·Y, X÷Y, previous-row(self)}
 *        lookups            target = table[key]
 *        rate lookups       target = X × rate[key]
 *      Search is RANSAC over minimal row subsets (robust to typos), followed by
 *      least squares on the inliers and "snapping" coefficients to the simplest
 *      number that loses no inliers (0.0825, 1.5, 1/3 …).
 *   3. Formulas are accepted as a DAG (no column may depend on itself).
 *   4. Rows that break a formula are fed to a blame solver: for every cell that
 *      the broken formulas touch, solve for the value that would repair them,
 *      reject candidates that break currently-satisfied formulas, and rank the
 *      rest by how many breaks they explain and how much the fix looks like a
 *      human typo (swapped digits, slipped decimal point, …).
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- utilities

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function colLetter(i) {
    let s = ''; i += 1;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  // Excel-style ROUND (half away from zero), robust to binary float noise.
  function roundTo(x, d) {
    if (!isFinite(x)) return x;
    const p = Math.pow(10, d);
    return (Math.sign(x) * Math.round(Math.abs(x) * p * (1 + 1e-12))) / p;
  }

  function fmt(x, d) {
    if (!isFinite(x)) return String(x);
    return roundTo(x, d).toFixed(Math.max(0, Math.min(10, d)));
  }

  // Shortest faithful text for a coefficient: 0.0825, 1.5, 1/3 …
  function numStr(c) {
    if (Number.isInteger(c)) return String(c);
    const short = parseFloat(c.toPrecision(10));
    if (Math.abs(short - c) < 1e-12 * Math.max(1, Math.abs(c))) {
      const s = String(short);
      if (s.replace(/^-?\d*\.?/, '').length <= 8 && !/e/.test(s)) return s;
    }
    for (let q = 2; q <= 12; q++) {
      const n = Math.round(c * q);
      if (Math.abs(n / q - c) < 1e-12 * Math.max(1, Math.abs(c))) return n + '/' + q;
    }
    return String(parseFloat(c.toPrecision(10)));
  }

  function coefComplexity(c) {
    const s = numStr(Math.abs(c));
    if (s === '1' || s === '0') return 0;
    if (/\//.test(s)) return 1.2;
    const dec = (s.split('.')[1] || '').length;
    return 0.3 + dec * 0.35;
  }

  // Simplest number inside [lo, hi]: fewest decimals first, then small fractions.
  function simplest(lo, hi) {
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    if (lo <= 0 && hi >= 0) return 0;
    const mid = (lo + hi) / 2;
    for (let p = 0; p <= 9; p++) {
      const s = Math.pow(10, p);
      const kc = Math.round(mid * s);
      if (kc / s >= lo && kc / s <= hi) return kc / s;
      const k = Math.ceil(lo * s);
      if (k / s <= hi) return k / s;
      if (p === 2) {
        for (const q of [3, 6, 7, 9, 11, 12]) {
          const n = Math.round(mid * q);
          if (n / q >= lo && n / q <= hi) return n / q;
        }
      }
    }
    return mid;
  }

  function stdev(arr) {
    let n = 0, m = 0, s = 0;
    for (const x of arr) { if (!isFinite(x)) continue; n++; const d = x - m; m += d / n; s += d * (x - m); }
    return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
  }

  // Gaussian elimination with partial pivoting. Returns null if singular.
  // k ≤ 3 (the hot path inside RANSAC) uses allocation-light Cramer's rule.
  function solve(A, b) {
    const n = b.length;
    if (n <= 3) return solveSmall(A, b, n);
    const M = A.map((r, i) => r.concat([b[i]]));
    let scale = 0;
    for (const r of A) for (const v of r) scale = Math.max(scale, Math.abs(v));
    if (!(scale > 0) || !isFinite(scale)) return null;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-11 * scale) return null;
      if (piv !== c) { const t = M[piv]; M[piv] = M[c]; M[c] = t; }
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        if (f === 0) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x.every(isFinite) ? x : null;
  }

  function solveSmall(A, b, n) {
    if (n === 1) { const x = b[0] / A[0][0]; return isFinite(x) && A[0][0] !== 0 ? [x] : null; }
    let scale = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) scale = Math.max(scale, Math.abs(A[i][j]));
    if (!(scale > 0) || !isFinite(scale)) return null;
    if (n === 2) {
      const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
      if (Math.abs(det) < 1e-11 * scale * scale) return null;
      return [(b[0] * A[1][1] - A[0][1] * b[1]) / det, (A[0][0] * b[1] - b[0] * A[1][0]) / det];
    }
    const [a, c, e] = A[0], [f, g, h] = A[1], [i, j, k] = A[2];
    const det = a * (g * k - h * j) - c * (f * k - h * i) + e * (f * j - g * i);
    if (Math.abs(det) < 1e-11 * scale * scale * scale) return null;
    const [p, q, r] = b;
    const x = [
      (p * (g * k - h * j) - c * (q * k - h * r) + e * (q * j - g * r)) / det,
      (a * (q * k - h * r) - p * (f * k - h * i) + e * (f * r - q * i)) / det,
      (a * (g * r - q * j) - c * (f * r - q * i) + p * (f * j - g * i)) / det,
    ];
    return x.every(isFinite) ? x : null;
  }

  function leastSquares(vecs, y, rows) {
    const k = vecs.length;
    const A = Array.from({ length: k }, () => new Array(k).fill(0));
    const b = new Array(k).fill(0);
    for (const p of rows) {
      for (let i = 0; i < k; i++) {
        const vi = vecs[i][p];
        b[i] += vi * y[p];
        for (let j = i; j < k; j++) A[i][j] += vi * vecs[j][p];
      }
    }
    for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
    return solve(A, b);
  }

  // ---------------------------------------------------------------- CSV

  function detectDelimiter(text) {
    const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
    let best = ',', bestN = -1;
    for (const d of [',', '\t', ';', '|']) {
      let n = 0, q = false;
      for (const ch of first) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
      if (n > bestN) { bestN = n; best = d; }
    }
    return best;
  }

  function parseCSV(text, delim) {
    text = String(text).replace(/^﻿/, '');
    delim = delim || detectDelimiter(text);
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
        continue;
      }
      if (ch === '"') q = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return { rows: rows.filter((r) => r.some((c) => c.trim() !== '')), delim };
  }

  function toCSV(rows) {
    return rows.map((r) => r.map((c) => {
      const s = c == null ? '' : String(c);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n') + '\n';
  }

  // "$1,234.50" "(12.00)" "7.25%" "-€3" "1.234,56 €" "1 234,56" "USD 12" → {v, decimals, pct}
  // decComma: the column writes decimals with a comma (European style).
  function parseNumber(raw, decComma) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    let neg = false, pct = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
    s = s.replace(/^(USD|EUR|GBP|INR|CHF|CAD|AUD|JPY|SEK|NOK|DKK|PLN)\s*/i, '').replace(/\s*(USD|EUR|GBP|INR|CHF|CAD|AUD|JPY|SEK|NOK|DKK|PLN)$/i, '');
    if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1).trim(); }
    if (/^(R\$|Rs\.?|kr|zł|[$€£¥₹])/.test(s)) s = s.replace(/^(R\$|Rs\.?|kr|zł|[$€£¥₹])/, '').trim();
    if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1).trim(); }
    if (/(kr|zł|[$€£¥₹])$/.test(s)) s = s.replace(/(kr|zł|[$€£¥₹])$/, '').trim();
    if (/[-−]$/.test(s)) { neg = !neg; s = s.slice(0, -1).trim(); } // SAP-style trailing minus
    // spaces / apostrophes as thousands separators: 1 234 567 · 1'234.50
    s = s.replace(/(\d)[\s  '’](?=\d{3}(\D|$))/g, '$1');
    if (decComma) {
      if (/^\d{1,3}(\.\d{3})+(,\d*)?$/.test(s)) s = s.replace(/\./g, '');
      if (/^\d*,\d+$|^\d+,$/.test(s)) s = s.replace(',', '.');
      else if (/,/.test(s)) return null;
    } else if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, '');
    if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    const m = s.match(/^[\d]*\.?(\d*)/);
    let decimals = /[eE]/.test(s) ? 10 : (s.includes('.') ? m[1].length : 0);
    let v = parseFloat(s);
    if (neg) v = -v;
    if (pct) { v = v / 100; decimals += 2; v = parseFloat(v.toPrecision(15)); }
    return { v, decimals: Math.min(decimals, 10), pct };
  }

  // Does this column write decimals with a comma? Decided from unambiguous cells only.
  function usesDecimalComma(raw, delim) {
    if (delim === ',') return false; // a comma-delimited file would have to quote every number
    let comma = 0, dot = 0, euroThousands = 0;
    for (const cell of raw) {
      const t = cell.replace(/[^\d.,]/g, '');
      if (/,\d{1,2}$|,\d{4,}$|\.\d{3},\d/.test(t)) comma++;
      else if (/\.\d{1,2}$|\.\d{4,}$|,\d{3}\.\d/.test(t)) dot++;
      else if (/^\d{1,3}(\.\d{3})+$/.test(t)) euroThousands++;
    }
    return comma > dot || (comma === 0 && dot === 0 && euroThousands > 0);
  }

  // ---------------------------------------------------------------- features

  // A feature is a per-row numeric vector the target may be a multiple of.
  function featureCost(f) {
    return { one: 0.6, col: 1, lag: 1.2, mul: 2.2, div: 3 }[f.type];
  }

  function buildFeature(ctx, f, t) {
    const n = ctx.n, out = new Float64Array(n), C = ctx.cols;
    if (f.type === 'one') out.fill(1);
    else if (f.type === 'col') out.set(C[f.a].input);
    else if (f.type === 'mul') { const a = C[f.a].input, b = C[f.b].input; for (let p = 0; p < n; p++) out[p] = a[p] * b[p]; }
    else if (f.type === 'div') { const a = C[f.a].input, b = C[f.b].input; for (let p = 0; p < n; p++) out[p] = b[p] === 0 ? NaN : a[p] / b[p]; }
    else if (f.type === 'lag') { const a = C[t].input; out[0] = NaN; for (let p = 1; p < n; p++) out[p] = a[p - 1]; }
    return out;
  }

  function featureLibrary(ctx, t, allowed) {
    const cacheKey = t + '|' + allowed.join(',');
    if (ctx.featCache && ctx.featCache.has(cacheKey)) return ctx.featCache.get(cacheKey);
    const feats = [{ type: 'one' }];
    for (const a of allowed) feats.push({ type: 'col', a });
    feats.push({ type: 'lag', a: t });
    for (let i = 0; i < allowed.length; i++) {
      for (let j = i; j < allowed.length; j++) feats.push({ type: 'mul', a: allowed[i], b: allowed[j] });
    }
    for (const a of allowed) for (const b of allowed) if (a !== b) feats.push({ type: 'div', a, b });
    const out = [];
    for (const f of feats) {
      const v = buildFeature(ctx, f, t);
      let bad = 0;
      for (let p = 0; p < v.length; p++) if (!isFinite(v[p])) bad++;
      if (bad > 0.25 * v.length && f.type !== 'lag') continue;
      f.vec = v; f.cost = featureCost(f); f.plain = f.type === 'one' || f.type === 'col' || f.type === 'lag';
      out.push(f);
    }
    // plain features first so cheap combos are tried first
    out.sort((x, y) => (y.plain - x.plain) || (x.cost - y.cost));
    if (ctx.featCache) ctx.featCache.set(cacheKey, out);
    return out;
  }

  // ---------------------------------------------------------------- tolerance

  function tolFor(mode, d, y) {
    return mode === 'round'
      ? 0.5 * Math.pow(10, -d) + 1e-9 * Math.max(1, Math.abs(y))
      : 1e-7 * Math.max(1, Math.abs(y));
  }

  // ---------------------------------------------------------------- linear search

  // sub.rows: search only these rows (one branch of an IF); sub.minFrac: inlier share
  // to accept; sub.noLag: skip previous-row terms.
  function searchLinear(ctx, t, allowed, kList, sub) {
    sub = sub || {};
    const col = ctx.cols[t], y = col.values, d = col.decimals, n = ctx.n;
    const rng = mulberry32(1234 + t * 7919 + (sub.rows ? sub.rows.length * 31 : 0));
    let yValid = [];
    for (let p = 0; p < n; p++) if (isFinite(y[p])) yValid.push(p);
    const sd = stdev(yValid.map((p) => y[p])); // spread of the whole column, even for a branch
    if (sub.rows) { const m = new Set(sub.rows); yValid = yValid.filter((p) => m.has(p)); }
    if (yValid.length < (sub.rows ? 4 : 6)) return [];
    if (!(sd > 0)) return [];
    // Rounding tolerance only means something if it is tiny relative to the spread.
    const allowRound = 0.5 * Math.pow(10, -d) <= 0.02 * sd;
    const looseTol = (yy) => 2 * Math.pow(10, -d) + 3e-3 * Math.abs(yy);

    // screening sample
    const S = yValid.slice();
    for (let i = S.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = S[i]; S[i] = S[j]; S[j] = tmp; }
    S.length = Math.min(S.length, 40);
    S.sort((a, b) => a - b);

    const feats = featureLibrary(ctx, t, allowed);
    const minFrac = sub.minFrac || ctx.opts.minFrac;
    // per-row screening tolerance, and whether each feature is finite on the whole sample
    const looseS = new Float64Array(n);
    for (const p of S) looseS[p] = looseTol(y[p]);
    for (const f of feats) f.finiteOnS = S.every((p) => isFinite(f.vec[p]));

    function evaluate(vecs, coefs, rows, mode) {
      let cnt = 0;
      for (const p of rows) {
        let pred = 0;
        for (let i = 0; i < vecs.length; i++) pred += coefs[i] * vecs[i][p];
        if (Math.abs(pred - y[p]) <= tolFor(mode, d, y[p])) cnt++;
      }
      return cnt;
    }

    function refine(combo, coefs0) {
      const vecs = combo.map((i) => feats[i].vec);
      const valid = yValid.filter((p) => vecs.every((v) => isFinite(v[p])));
      if (valid.length < Math.max(combo.length + (sub.rows ? 2 : 3), 0.5 * yValid.length)) return null;
      const residOK = (c, p, tol) => {
        let pred = 0; for (let i = 0; i < vecs.length; i++) pred += c[i] * vecs[i][p];
        return Math.abs(pred - y[p]) <= tol(y[p]);
      };
      let L = valid.filter((p) => residOK(coefs0, p, looseTol));
      if (L.length < combo.length + 3) return null;
      let c = leastSquares(vecs, y, L) || coefs0;
      L = valid.filter((p) => residOK(c, p, (yy) => 1.5 * Math.pow(10, -d) + 1e-6 * Math.abs(yy)));
      if (L.length >= combo.length + 3) c = leastSquares(vecs, y, L) || c;

      const modes = allowRound ? ['exact', 'round'] : ['exact'];
      const score = (cv) => {
        let best = { mode: 'exact', cnt: -1 };
        for (const m of modes) { const k = evaluate(vecs, cv, valid, m); if (k > best.cnt) best = { mode: m, cnt: k }; }
        return best;
      };
      const raw = score(c);
      let chosen = { coefs: c, ...raw };
      for (const w of [3e-3, 1e-3, 1e-4, 1e-6, 1e-9]) {
        const snapped = c.map((x) => simplest(x - w * Math.max(Math.abs(x), 1e-3), x + w * Math.max(Math.abs(x), 1e-3)));
        const s = score(snapped);
        if (s.cnt >= raw.cnt) { chosen = { coefs: snapped, ...s }; break; }
      }
      if (chosen.coefs.some((x) => x === 0)) return null; // a zero term means a smaller combo exists
      const need = Math.max(combo.length + (sub.rows ? 2 : 3), Math.ceil(minFrac * valid.length));
      if (chosen.cnt < need) return null;
      const complexity = combo.reduce((s, i) => s + feats[i].cost, 0) +
        chosen.coefs.reduce((s, x) => s + coefComplexity(x), 0);
      return {
        terms: combo.map((i, j) => ({ coef: chosen.coefs[j], feat: stripVec(feats[i]) })),
        mode: chosen.mode, inliers: chosen.cnt, evaluable: valid.length,
        complexity: complexity + (chosen.mode === 'round' ? 1.5 : 0),
      };
    }

    const found = [];
    for (const k of kList) {
      const combo = [];
      const tryCombo = () => {
        const cf = combo.map((i) => feats[i]);
        if (k === 1 && cf[0].type === 'one') return;
        if (sub.noLag && cf.some((f) => f.type === 'lag')) return;
        if (cf.every((f) => f.type === 'one' || f.type === 'lag') && !cf.some((f) => f.type === 'lag')) return;
        if (k === 3 && cf.filter((f) => !f.plain).length > 1) return;
        if (k >= 4 && cf.some((f) => !f.plain)) return;
        const vecs = cf.map((f) => f.vec);
        const Sc = cf.every((f) => f.finiteOnS) ? S : S.filter((p) => vecs.every((v) => isFinite(v[p])));
        if (Sc.length < k + (sub.rows ? 2 : 3)) return;
        // screening bar scales with the acceptance bar (a low bar is used to find one
        // regime of an IF); draws are sized to hit a clean subset with ~97% probability
        const low = minFrac < 0.6;
        const need = Math.ceil(Math.min(0.6, minFrac * 0.75) * Sc.length), maxMiss = Sc.length - need;
        const trials = low ? (k === 1 ? 8 : 16) : k === 1 ? 4 : k === 2 ? 6 : 8;
        for (let trial = 0; trial < trials; trial++) {
          const pick = [];
          let guard = 0;
          while (pick.length < k && guard++ < 50) { const r = Sc[Math.floor(rng() * Sc.length)]; if (!pick.includes(r)) pick.push(r); }
          if (pick.length < k) return;
          const A = pick.map((p) => vecs.map((v) => v[p]));
          const c = solve(A, pick.map((p) => y[p]));
          if (!c) continue;
          let miss = 0;
          for (const p of Sc) {
            let pred = 0; for (let i = 0; i < k; i++) pred += c[i] * vecs[i][p];
            if (Math.abs(pred - y[p]) > looseS[p]) { if (++miss > maxMiss) break; }
          }
          if (miss > maxMiss) continue;
          const r = refine(combo.slice(), c);
          if (r) { found.push({ kind: 'linear', ...r }); break; }
        }
      };
      const rec = (start) => {
        if (combo.length === k) { tryCombo(); return; }
        for (let i = start; i < feats.length; i++) {
          if (k >= 3 && !feats[i].plain && combo.some((j) => !feats[j].plain)) continue;
          if (k >= 4 && !feats[i].plain) continue;
          combo.push(i); rec(i + 1); combo.pop();
        }
      };
      rec(0);
      if (found.length > 200) break;
    }
    return found;
  }

  function stripVec(f) { const { vec, ...rest } = f; return rest; }

  // ---------------------------------------------------------------- lookups

  function groupsBy(ctx, keyCol, rows) {
    const g = new Map(), keys = ctx.cols[keyCol].text;
    for (const p of rows) {
      const k = keys[p];
      if (k === '') continue;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(p);
    }
    return g;
  }

  function groupingIsMeaningful(groups, n) {
    if (groups.size < 2 || groups.size > 0.5 * n) return false;
    let covered = 0;
    for (const rows of groups.values()) if (rows.length >= 2) covered += rows.length;
    return covered >= 0.5 * n;
  }

  // target = table[key]
  function searchLookup(ctx, t, cats) {
    const col = ctx.cols[t], y = col.values, d = col.decimals;
    const rows = []; for (let p = 0; p < ctx.n; p++) if (isFinite(y[p])) rows.push(p);
    let best = null;
    for (const c of cats) {
      const groups = groupsBy(ctx, c, rows);
      if (!groupingIsMeaningful(groups, rows.length)) continue;
      const map = new Map(), ambiguous = new Set();
      let inliers = 0, judged = 0;
      for (const [key, ps] of groups) {
        const counts = new Map();
        for (const p of ps) { const k = fmt(y[p], d); counts.set(k, (counts.get(k) || 0) + 1); }
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        map.set(key, parseFloat(sorted[0][0]));
        const clear = ps.length === 1 || (sorted[0][1] >= 2 && (sorted.length === 1 || sorted[0][1] > sorted[1][1]));
        if (!clear) { ps.forEach((p) => ambiguous.add(p)); continue; }
        judged += ps.length; inliers += sorted[0][1];
      }
      if (new Set(map.values()).size < 2) continue;
      if (inliers < Math.ceil(0.85 * rows.length)) continue;
      const cand = { kind: 'lookup', key: c, map, ambiguous, mode: 'exact', inliers, evaluable: judged, complexity: 2 + groups.size * 0.1 };
      if (!best || cand.inliers > best.inliers || (cand.inliers === best.inliers && cand.complexity < best.complexity)) best = cand;
    }
    return best;
  }

  // target = X × rate[key]
  function searchRateLookup(ctx, t, allowed, cats) {
    const col = ctx.cols[t], y = col.values, d = col.decimals;
    const sd = stdev(Array.from(y));
    const mode = 0.5 * Math.pow(10, -d) <= 0.02 * sd ? 'round' : 'exact';
    let best = null;
    for (const c of cats) for (const x of allowed) {
      const X = ctx.cols[x].input;
      const rows = []; for (let p = 0; p < ctx.n; p++) if (isFinite(y[p]) && isFinite(X[p])) rows.push(p);
      if (rows.length < 6) continue;
      const groups = groupsBy(ctx, c, rows);
      if (!groupingIsMeaningful(groups, rows.length)) continue;
      const map = new Map(), ambiguous = new Set();
      let inliers = 0, judged = 0;
      for (const [key, ps] of groups) {
        const cands = new Set();
        for (const p of ps) {
          if (X[p] === 0) continue;
          const tol = tolFor(mode, d, y[p]);
          cands.add(simplest((y[p] - tol) / X[p], (y[p] + tol) / X[p]));
          if (cands.size > 24) break;
        }
        if (!cands.size) cands.add(0);
        let bestRate = 0, bestCnt = -1;
        for (const r of cands) {
          let cnt = 0;
          for (const p of ps) if (Math.abs(X[p] * r - y[p]) <= tolFor(mode, d, y[p])) cnt++;
          if (cnt > bestCnt || (cnt === bestCnt && coefComplexity(r) < coefComplexity(bestRate))) { bestCnt = cnt; bestRate = r; }
        }
        map.set(key, bestRate);
        const clear = ps.length === 1 || (bestCnt >= 2 && bestCnt > ps.length / 2);
        if (!clear) { ps.forEach((p) => ambiguous.add(p)); continue; }
        judged += ps.length; inliers += bestCnt;
      }
      if (new Set(map.values()).size < 2) continue;
      if (inliers < Math.ceil(0.85 * rows.length)) continue;
      const cand = { kind: 'rate', key: c, x, map, ambiguous, mode, inliers, evaluable: judged, complexity: 3 + groups.size * 0.1 };
      if (!best || cand.inliers > best.inliers || (cand.inliers === best.inliers && cand.complexity < best.complexity)) best = cand;
    }
    return best;
  }

  // ---------------------------------------------------------------- piecewise (IF) formulas

  // A threshold that reads like a human wrote it: the coarsest round number that
  // separates the two groups. "X > c" puts rows with X = c in the lower group,
  // "X >= c" in the upper one; whichever allows the rounder c wins.
  function niceThreshold(lo, hi) {
    const steps = [1e6, 5e5, 1e5, 5e4, 1e4, 5000, 1000, 500, 100, 50, 25, 10, 5, 1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.005, 0.001];
    const clean = (x) => parseFloat(x.toPrecision(12));
    for (let rank = 0; rank < steps.length; rank++) {
      const step = steps[rank];
      const a = clean(Math.ceil(lo / step - 1e-9) * step);
      if (a >= lo && a < hi) return { c: a, op: '>', rank };
      const b = clean(Math.floor(hi / step + 1e-9) * step);
      if (b > lo && b <= hi) return { c: b, op: '>=', rank };
    }
    return { c: lo, op: '>', rank: steps.length };
  }

  function condHolds(op, x, c) { return op === '>' ? x > c : x >= c; }

  // target = IF(X op c, A, B), where A and B are each a constant or a 1–2 term formula.
  // Strategy: find a formula that fits a sizable share of rows (one regime), split the
  // rows it misses from the rows it fits by a threshold on some column, then fit the
  // other regime on its side only.
  function searchPiecewise(ctx, t, allowed) {
    const col = ctx.cols[t], y = col.values, d = col.decimals, n = ctx.n;
    const valid = []; for (let p = 0; p < n; p++) if (isFinite(y[p])) valid.push(p);
    // a two-valued column (a flag or a flat fee) is easy to split by coincidence: demand more rows
    const twoValued = new Set(valid.map((p) => fmt(y[p], d))).size <= 2;
    if (valid.length < (twoValued ? 20 : 10) || !allowed.length) return null;
    const sd = stdev(valid.map((p) => y[p]));
    if (!(sd > 0)) return null;
    const roundOK = 0.5 * Math.pow(10, -d) <= 0.02 * sd;
    const get = (c, p) => ctx.cols[c].input[p];
    const ok = (f, p) => {
      const pred = f.kind === 'const' ? f.value : predict(f, p, get);
      return isFinite(pred) && Math.abs(pred - y[p]) <= tolFor(f.mode === 'round' && roundOK ? 'round' : 'exact', d, y[p]);
    };
    const constFit = (rows) => {
      const counts = new Map();
      for (const p of rows) { const k = fmt(y[p], d); counts.set(k, (counts.get(k) || 0) + 1); }
      let best = null;
      for (const [k, cnt] of counts) if (!best || cnt > best.inliers) best = { kind: 'const', value: parseFloat(k), mode: 'exact', inliers: cnt, complexity: 0.5 + coefComplexity(parseFloat(k)) };
      return best;
    };
    const slack = Math.max(1, Math.floor(0.05 * valid.length));

    let firsts = searchLinear(ctx, t, allowed, [1, 2], { minFrac: 0.3, noLag: true });
    const cf = constFit(valid);
    if (cf && cf.inliers >= Math.max(3, 0.25 * valid.length)) firsts.push(cf);
    firsts = firsts.sort((a, b) => b.inliers - a.inliers || a.complexity - b.complexity).slice(0, 6);

    let best = null;
    for (const f1 of firsts) {
      const inI = new Map(valid.map((p) => [p, ok(f1, p)]));
      const nI = [...inI.values()].filter(Boolean).length, nO = valid.length - nI;
      if (nI < 3 || nO < 3) continue;
      // best threshold per column: fewest rows on the wrong side
      const splits = [];
      for (const x of allowed) {
        const X = ctx.cols[x].input;
        const rows = valid.filter((p) => isFinite(X[p])).sort((a, b) => X[a] - X[b]);
        if (rows.length < valid.length - slack) continue;
        let iBelow = 0, oBelow = 0;
        const totI = rows.filter((p) => inI.get(p)).length, totO = rows.length - totI;
        for (let i = 0; i < rows.length - 1; i++) {
          if (inI.get(rows[i])) iBelow++; else oBelow++;
          const lo = X[rows[i]], hi = X[rows[i + 1]];
          if (lo === hi) continue;
          const errUp = oBelow + (totI - iBelow);   // f1 below the threshold, other regime above
          const errDown = iBelow + (totO - oBelow); // other regime below, f1 above
          if (errUp <= slack) splits.push({ x, lo, hi, err: errUp, otherAbove: true });
          if (errDown <= slack) splits.push({ x, lo, hi, err: errDown, otherAbove: false });
        }
      }
      splits.sort((a, b) => a.err - b.err);
      for (const sp of splits.slice(0, 3)) {
        const { c, op, rank } = niceThreshold(sp.lo, sp.hi);
        const X = ctx.cols[sp.x].input;
        const side = valid.filter((p) => condHolds(op, X[p], c) === sp.otherAbove);
        if (side.length < (twoValued ? 4 : 3) || valid.length - side.length < (twoValued ? 4 : 3)) continue;
        let seconds = searchLinear(ctx, t, allowed, [1, 2], { rows: side, minFrac: 0.8, noLag: true });
        const c2 = constFit(side);
        if (c2 && c2.inliers >= Math.ceil(0.8 * side.length)) seconds.push(c2);
        for (const f2 of seconds) {
          const then = sp.otherAbove ? f2 : f1, els = sp.otherAbove ? f1 : f2;
          const cand = {
            kind: 'if', x: sp.x, c, op, then, else: els,
            mode: then.mode === 'round' || els.mode === 'round' ? 'round' : 'exact',
          };
          let inliers = 0;
          for (const p of valid) if (ok(condHolds(op, X[p], c) ? then : els, p)) inliers++;
          if (inliers < Math.ceil(ctx.opts.minFrac * valid.length)) continue;
          cand.inliers = inliers; cand.evaluable = valid.length;
          // a rounder threshold is more plausible (20000 beats 24500 when both fit)
          cand.complexity = 2 + (f1.complexity || 0) + (f2.complexity || 0) + 0.15 * rank;
          if (!best || inliers > best.inliers || (inliers === best.inliers && cand.complexity < best.complexity)) best = cand;
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- formula API

  function formulaInputs(f) {
    if (f.kind === 'const') return [];
    if (f.kind === 'if') return [...new Set([f.x, ...formulaInputs(f.then), ...formulaInputs(f.else)])];
    if (f.kind === 'linear') {
      const s = new Set();
      for (const { feat } of f.terms) {
        if (feat.type === 'col') s.add(feat.a);
        if (feat.type === 'mul' || feat.type === 'div') { s.add(feat.a); s.add(feat.b); }
      }
      return [...s];
    }
    if (f.kind === 'rate') return [f.x];
    return [];
  }

  function hasLag(f) { return f.kind === 'linear' && f.terms.some((t) => t.feat.type === 'lag'); }

  // get(col, pos) must return the numeric value of a cell (blank → 0), keyOf(col,pos) the text.
  function predict(f, p, get, keyOf) {
    if (f.kind === 'const') return f.value;
    if (f.kind === 'if') return predict(condHolds(f.op, get(f.x, p), f.c) ? f.then : f.else, p, get, keyOf);
    if (f.kind === 'lookup') { const v = f.map.get(keyOf(f.key, p)); return v === undefined ? NaN : v; }
    if (f.kind === 'rate') { const r = f.map.get(keyOf(f.key, p)); return r === undefined ? NaN : get(f.x, p) * r; }
    let s = 0;
    for (const { coef, feat } of f.terms) {
      let v;
      switch (feat.type) {
        case 'one': v = 1; break;
        case 'col': v = get(feat.a, p); break;
        case 'mul': v = get(feat.a, p) * get(feat.b, p); break;
        case 'div': v = get(feat.a, p) / get(feat.b, p); break;
        case 'lag': v = p > 0 ? get(f.target, p - 1) : NaN; break;
      }
      s += coef * v;
    }
    return s;
  }

  function finalValue(f, pred, d) { return f.mode === 'round' || f.kind !== 'linear' ? roundTo(pred, d) : pred; }

  // Write constants last and lead with a positive term: "0.07 × Sales − 600", not "−600 + 0.07 × Sales".
  function displayOrder(terms) {
    const out = terms.filter((t) => t.feat.type !== 'one').concat(terms.filter((t) => t.feat.type === 'one'));
    const firstPos = out.findIndex((t) => t.coef > 0);
    if (firstPos > 0) out.unshift(out.splice(firstPos, 1)[0]);
    return out;
  }

  function prettyTokens(f, cols) {
    const name = (c) => ({ t: 'col', c, s: cols[c].name });
    const toks = [];
    if (f.kind === 'lookup') return [{ t: 'fn', s: 'lookup' }, { t: 'op', s: '(' }, name(f.key), { t: 'op', s: ')' }];
    if (f.kind === 'rate') {
      const inner = [name(f.x), { t: 'op', s: ' × ' }, { t: 'fn', s: 'rate' }, { t: 'op', s: '(' }, name(f.key), { t: 'op', s: ')' }];
      return f.mode === 'round' ? [{ t: 'fn', s: 'round' }, { t: 'op', s: '(' }, ...inner, { t: 'op', s: ', ' + cols[f.target].decimals + ')' }] : inner;
    }
    if (f.kind === 'if') {
      const branch = (b) => (b.kind === 'const' ? [{ t: 'num', s: numStr(b.value) }] : prettyTokens(Object.assign({}, b, { mode: 'exact' }), cols));
      const inner = [{ t: 'fn', s: 'if' }, { t: 'op', s: '(' }, name(f.x), { t: 'op', s: f.op === '>' ? ' > ' : ' ≥ ' }, { t: 'num', s: numStr(f.c) },
        { t: 'op', s: ', ' }, ...branch(f.then), { t: 'op', s: ', ' }, ...branch(f.else), { t: 'op', s: ')' }];
      return f.mode === 'round' ? [{ t: 'fn', s: 'round' }, { t: 'op', s: '(' }, ...inner, { t: 'op', s: ', ' + cols[f.target].decimals + ')' }] : inner;
    }
    displayOrder(f.terms).forEach(({ coef, feat }, i) => {
      const neg = coef < 0, mag = Math.abs(coef);
      if (i > 0) toks.push({ t: 'op', s: neg ? ' − ' : ' + ' });
      else if (neg) toks.push({ t: 'op', s: '−' });
      if (feat.type === 'one') { toks.push({ t: 'num', s: numStr(mag) }); return; }
      if (mag !== 1) toks.push({ t: 'num', s: numStr(mag) }, { t: 'op', s: ' × ' });
      if (feat.type === 'col') toks.push(name(feat.a));
      else if (feat.type === 'lag') toks.push({ t: 'col', c: feat.a, s: cols[feat.a].name, prev: true });
      else if (feat.type === 'mul') toks.push(name(feat.a), { t: 'op', s: ' × ' }, name(feat.b));
      else if (feat.type === 'div') toks.push(name(feat.a), { t: 'op', s: ' ÷ ' }, name(feat.b));
    });
    if (f.mode === 'round') return [{ t: 'fn', s: 'round' }, { t: 'op', s: '(' }, ...toks, { t: 'op', s: ', ' + cols[f.target].decimals + ')' }];
    return toks;
  }

  function excelFormula(f, p, ctx) {
    const ref = (c, q) => ctx.cols[c].letter + ctx.rowNum[q];
    const d = ctx.cols[f.target].decimals;
    const sw = (key) => 'SWITCH(' + ref(f.key, p) + ',' +
      [...f.map.entries()].map(([k, v]) => '"' + k.replace(/"/g, '""') + '",' + numStr(v)).join(',') + ')';
    if (f.kind === 'lookup') return '=' + sw();
    if (f.kind === 'rate') return '=' + (f.mode === 'round' ? 'ROUND(' + ref(f.x, p) + '*' + sw() + ',' + d + ')' : ref(f.x, p) + '*' + sw());
    if (f.kind === 'if') {
      const branch = (b) => (b.kind === 'const' ? numStr(b.value) : excelFormula(Object.assign({}, b, { mode: 'exact', target: f.target }), p, ctx).slice(1));
      const body = 'IF(' + ref(f.x, p) + f.op + numStr(f.c) + ',' + branch(f.then) + ',' + branch(f.else) + ')';
      return '=' + (f.mode === 'round' ? 'ROUND(' + body + ',' + d + ')' : body);
    }
    let s = '';
    displayOrder(f.terms).forEach(({ coef, feat }, i) => {
      const neg = coef < 0, mag = Math.abs(coef);
      s += i === 0 ? (neg ? '-' : '') : (neg ? '-' : '+');
      let c = numStr(mag); if (c.includes('/')) c = '(' + c + ')';
      let body;
      switch (feat.type) {
        case 'one': s += c; return;
        case 'col': body = ref(feat.a, p); break;
        case 'mul': body = ref(feat.a, p) + '*' + ref(feat.b, p); break;
        case 'div': body = ref(feat.a, p) + '/' + ref(feat.b, p); break;
        case 'lag': body = ref(feat.a, p - 1); break;
      }
      s += (mag === 1 ? '' : c + '*') + body;
    });
    return '=' + (f.mode === 'round' ? 'ROUND(' + s + ',' + d + ')' : s);
  }

  // ---------------------------------------------------------------- typo diagnosis

  function diagnose(typed, correct, d) {
    if (!isFinite(typed) || !isFinite(correct)) return { kind: 'mismatch', score: 0, label: 'value doesn’t fit the pattern' };
    const delta = typed - correct;
    if (Math.abs(delta) <= 0.5 * Math.pow(10, -d)) return { kind: 'same', score: 0, label: 'matches' };
    if (Math.abs(typed + correct) <= 0.5 * Math.pow(10, -d) && correct !== 0) return { kind: 'sign', score: 0.9, label: 'sign flipped' };
    const ds = (x) => Math.abs(roundTo(x, d)).toFixed(d).replace('.', '').replace(/^0+(?=\d)/, '');
    const a = ds(typed), b = ds(correct);
    if (correct !== 0) {
      const r = typed / correct;
      for (const k of [1, 2, 3]) {
        if (Math.abs(r - Math.pow(10, k)) < 1e-6 * Math.pow(10, k)) return { kind: 'decimal', score: 0.85, label: 'decimal point slipped (×' + Math.pow(10, k) + ')' };
        if (Math.abs(r - Math.pow(10, -k)) < 1e-6 * Math.pow(10, -k)) return { kind: 'decimal', score: 0.85, label: 'decimal point slipped (÷' + Math.pow(10, k) + ')' };
      }
    }
    if (a.length === b.length) {
      const diff = [];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
      if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) {
        return { kind: 'swap', score: 0.95, label: 'two digits swapped (' + b.slice(diff[0], diff[0] + 2) + ' typed as ' + a.slice(diff[0], diff[0] + 2) + ')' };
      }
      if (diff.length === 1) return { kind: 'digit', score: 0.8, label: 'one digit mistyped (' + b[diff[0]] + ' typed as ' + a[diff[0]] + ')' };
    }
    const delOne = (long, short) => { for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true; return false; };
    if (a.length + 1 === b.length && delOne(b, a)) return { kind: 'dropped', score: 0.75, label: 'a digit was dropped' };
    if (a.length === b.length + 1 && delOne(a, b)) return { kind: 'extra', score: 0.75, label: 'an extra digit was typed' };
    const rel = Math.abs(delta) / Math.max(Math.abs(correct), 1e-9);
    if (rel < 0.005) return { kind: 'drift', score: 0.25, label: 'slightly off (' + (delta > 0 ? '+' : '−') + fmt(Math.abs(delta), d) + '), possibly stale or rounded by hand' };
    return { kind: 'mismatch', score: 0.05, label: 'off by ' + (delta > 0 ? '+' : '−') + fmt(Math.abs(delta), d) };
  }

  // ---------------------------------------------------------------- analysis

  const SUMMARY_RE = /^\s*(grand\s+)?(sub\s*-?\s*)?totals?\s*:?\s*$/i;

  function analyze(text, opts) {
    opts = Object.assign({ minFrac: 0.8 }, opts || {});
    const t0 = Date.now();
    const { rows, delim } = parseCSV(text);
    if (rows.length < 2) throw new Error('Unbake needs a header row plus some data rows.');
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => r.concat(new Array(width - r.length).fill(''));
    const seen = new Map();
    const header = pad(rows[0]).map((h, i) => {
      let name = h.trim() || 'Column ' + colLetter(i);
      if (seen.has(name)) { seen.set(name, seen.get(name) + 1); name += ' (' + seen.get(name) + ')'; } else seen.set(name, 1);
      return name;
    });
    const body = rows.slice(1).map(pad);
    const dataIdx = [], summaryIdx = [];
    body.forEach((r, i) => (r.some((c) => SUMMARY_RE.test(c)) ? summaryIdx : dataIdx).push(i));
    const n = dataIdx.length;
    if (n < 6) throw new Error('Unbake needs at least 6 data rows to tell a formula from a coincidence (found ' + n + ').');

    const cols = header.map((name, ci) => {
      const raw = dataIdx.map((ri) => body[ri][ci].trim());
      const decComma = usesDecimalComma(raw, delim);
      const parsed = raw.map((r) => parseNumber(r, decComma));
      const nonEmpty = raw.filter((s) => s !== '').length;
      const ok = parsed.filter(Boolean).length;
      const col = { name, index: ci, letter: colLetter(ci), raw };
      if (nonEmpty > 0 && ok >= 3 && ok >= 0.9 * nonEmpty) {
        col.type = 'number';
        col.values = Float64Array.from(parsed, (p) => (p ? p.v : NaN));
        col.input = Float64Array.from(parsed, (p, i) => (p ? p.v : raw[i] === '' ? 0 : NaN));
        col.blank = raw.map((s) => s === '');
        col.decimals = Math.max(0, ...parsed.filter(Boolean).map((p) => p.decimals));
        col.pct = parsed.filter((p) => p && p.pct).length > ok / 2;
        col.distinct = new Set(parsed.filter(Boolean).map((p) => p.v)).size;
        col.decComma = decComma;
      } else {
        col.type = 'text';
        col.text = raw;
      }
      return col;
    });

    const rowNum = dataIdx.map((ri) => ri + 2); // spreadsheet row of each data position
    const ctx = { cols, n, opts, rowNum, featCache: new Map() };
    const numeric = cols.filter((c) => c.type === 'number').map((c) => c.index);
    const texts = cols.filter((c) => c.type === 'text').map((c) => c.index);

    // ---- formula discovery
    const byTarget = new Map();
    const dependsOn = (s, t, seenSet = new Set()) => {
      const f = byTarget.get(s);
      if (!f || seenSet.has(s)) return false;
      seenSet.add(s);
      return formulaInputs(f).some((i) => i === t || dependsOn(i, t, seenSet));
    };
    // Occam within noise: among candidates that explain (nearly) as many rows as the
    // best one, keep the simplest. A typo can cost the true formula a row or two.
    const fit = (t, allowed, cats, piecewise) => {
      // two-valued columns are only explained by a lookup or a threshold rule
      let cands = cols[t].distinct >= 3 ? searchLinear(ctx, t, allowed, [1, 2, 3]) : [];
      cands.push(searchLookup(ctx, t, cats), searchRateLookup(ctx, t, allowed, cats));
      cands = cands.filter(Boolean);
      if (!cands.length && cols[t].distinct >= 3) cands = searchLinear(ctx, t, allowed, [4]);
      if (!cands.length && piecewise && allowed.length <= 25) { const pw = searchPiecewise(ctx, t, allowed); if (pw) cands = [pw]; }
      if (!cands.length) return null;
      const top = Math.max(...cands.map((c) => c.inliers));
      const slack = Math.max(1, Math.ceil(0.03 * n));
      return cands.filter((c) => c.inliers >= top - slack).sort((a, b) => a.complexity - b.complexity || b.inliers - a.inliers)[0];
    };

    const candidates = numeric.filter((t) => cols[t].distinct >= 2);
    const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    let step = 0;
    const tick = (t) => progress(Math.min(0.97, ++step / (candidates.length * 1.6 + 1)), cols[t].name);
    // Phase 1: spreadsheets compute rightwards — explain each column from columns to its left.
    for (const t of candidates) {
      tick(t);
      const f = fit(t, numeric.filter((c) => c < t), texts.filter((c) => c < t), true);
      if (f) byTarget.set(t, Object.assign(f, { target: t }));
    }
    // Phase 2: anything still unexplained may use any column that doesn't depend on it.
    // (IF rules are only searched left-to-right in phase 1; doing it here doubles the cost.)
    for (const t of candidates) {
      if (byTarget.has(t)) continue;
      tick(t);
      const allowed = numeric.filter((c) => c !== t && !dependsOn(c, t));
      const f = fit(t, allowed, texts);
      if (f) byTarget.set(t, Object.assign(f, { target: t }));
    }

    // topological order
    const order = [];
    const visit = (t, stack = new Set()) => {
      if (order.includes(t) || !byTarget.has(t) || stack.has(t)) return;
      stack.add(t);
      formulaInputs(byTarget.get(t)).forEach((i) => visit(i, stack));
      order.push(t);
    };
    [...byTarget.keys()].sort((a, b) => a - b).forEach((t) => visit(t));
    const formulas = order.map((t, id) => {
      const f = byTarget.get(t);
      f.id = id; f.inputs = formulaInputs(f); f.lag = hasLag(f);
      f.ambiguous = f.ambiguous || new Set();
      f.tokens = prettyTokens(f, cols);
      return f;
    });
    formulas.forEach((f) => { cols[f.target].formula = f.id; });

    // ---- anomaly detection + blame
    const work = new Map(numeric.map((c) => [c, Float64Array.from(cols[c].values)]));
    const blankW = new Map(numeric.map((c) => [c, cols[c].blank.slice()]));
    const getIn = (c, p) => (blankW.get(c)[p] ? 0 : work.get(c)[p]);
    const keyOf = (c, p) => cols[c].text[p];
    const status = (f, p) => {
      if (f.ambiguous.has(p)) return null;
      const y = work.get(f.target)[p];
      if (blankW.get(f.target)[p] || !isFinite(y)) return null;
      const pred = predict(f, p, getIn, keyOf);
      if (!isFinite(pred)) return null;
      const d = cols[f.target].decimals;
      const tol = f.kind === 'linear' ? tolFor(f.mode, d, y) : tolFor('round', d, y);
      return Math.abs(pred - y) <= tol;
    };
    const touching = (c, p) => {
      const out = [];
      for (const f of formulas) {
        if (f.target === c) { out.push([f, p]); if (f.lag && p + 1 < n) out.push([f, p + 1]); }
        if (f.inputs.includes(c)) out.push([f, p]);
      }
      return out;
    };
    const key = (f, p) => f.id + ':' + p;
    const state = new Map();
    for (const f of formulas) {
      let ok = 0, ev = 0;
      for (let p = 0; p < n; p++) { const s = status(f, p); state.set(key(f, p), s); if (s !== null) { ev++; if (s) ok++; } }
      f.evaluable = ev; f.inliers = ok;
      f.anomalies = [];
      for (let p = 0; p < n; p++) if (state.get(key(f, p)) === false) f.anomalies.push(p);
    }

    const solveCell = (c, p, inst) => {
      const [f, q] = inst;
      const d = cols[c].decimals;
      if (f.target === c && q === p) return roundTo(predict(f, q, getIn, keyOf), d);
      const arr = work.get(c), bl = blankW.get(c), orig = arr[p], origBlank = bl[p];
      const g = (v) => { arr[p] = v; bl[p] = false; const r = predict(f, q, getIn, keyOf) - work.get(f.target)[q]; arr[p] = orig; bl[p] = origBlank; return r; };
      let v0 = origBlank || !isFinite(orig) ? 0 : orig, v1 = v0 + Math.max(1, Math.abs(v0)) * 0.37;
      let g0 = g(v0), g1 = g(v1);
      for (let it = 0; it < 40 && isFinite(g1) && Math.abs(g1) > 1e-10; it++) {
        if (g1 === g0) return null;
        const v2 = v1 - (g1 * (v1 - v0)) / (g1 - g0);
        v0 = v1; g0 = g1; v1 = v2; g1 = g(v1);
      }
      return isFinite(v1) ? roundTo(v1, d) : null;
    };

    const corrections = [];
    let broken = new Set();
    for (const [k, s] of state) if (s === false) broken.add(k);
    for (let guard = 0; broken.size && guard < 1000; guard++) {
      // every cell touched by a broken formula, with every broken formula it touches
      const cellSet = new Map();
      for (const bk of broken) {
        const [fid, ps] = bk.split(':'); const f = formulas[+fid], p = +ps;
        const cells = [[f.target, p]];
        f.inputs.forEach((c) => cells.push([c, p]));
        if (f.lag && p > 0) cells.push([f.target, p - 1]);
        for (const [c, q] of cells) {
          if (cols[c].type !== 'number') continue;
          const k = c + ':' + q;
          if (!cellSet.has(k)) cellSet.set(k, [c, q, []]);
          cellSet.get(k)[2].push([f, p]);
        }
      }
      const ranked = [];
      for (const [c, q, insts] of cellSet.values()) {
        // a cell may be solvable from several broken formulas; try each value it implies
        const tried = new Set();
        let bestHere = null;
        for (const inst of insts) {
          const v = solveCell(c, q, inst);
          if (v === null || tried.has(v)) continue;
          tried.add(v);
          const arr = work.get(c), bl = blankW.get(c), orig = arr[q], origBlank = bl[q];
          if (!origBlank && Math.abs(v - orig) < 1e-12) continue;
          arr[q] = v; bl[q] = false;
          let fixed = 0, newly = 0;
          const fixedList = [];
          for (const [f, r] of touching(c, q)) {
            const k = key(f, r), before = state.get(k), after = status(f, r);
            if (before === false && after === true) { fixed++; fixedList.push(f.id); }
            if (before === true && after === false) newly++;
          }
          arr[q] = orig; bl[q] = origBlank;
          if (!fixed || newly) continue;
          const typed = origBlank ? 0 : orig;
          const diag = diagnose(typed, v, cols[c].decimals);
          const score = fixed + 0.9 * diag.score;
          if (!bestHere || score > bestHere.score) bestHere = { c, q, v, typed, diag, score, fixed, fixedList, wasBlank: origBlank };
        }
        if (bestHere) ranked.push(bestHere);
      }
      ranked.sort((a, b) => b.score - a.score);
      const best = ranked[0];
      // other single-cell fixes that explain the same breaks about as well
      const alternatives = best ? ranked.slice(1).filter((r) => r.fixed === best.fixed &&
        r.fixedList.every((id) => best.fixedList.includes(id)) && Math.abs(r.q - best.q) <= 1)
        .slice(0, 2).map((r) => ({ col: r.c, pos: r.q, row: rowNum[r.q], suggested: r.v, diagnosis: r.diag })) : [];
      if (!best) break;
      work.get(best.c)[best.q] = best.v; blankW.get(best.c)[best.q] = false;
      for (const [f, r] of touching(best.c, best.q)) {
        const k = key(f, r), s = status(f, r);
        state.set(k, s);
        if (s === false) broken.add(k); else broken.delete(k);
      }
      corrections.push({
        col: best.c, pos: best.q, row: rowNum[best.q], typed: best.wasBlank ? null : best.typed,
        suggested: best.v, diagnosis: best.diag, fixes: [...new Set(best.fixedList)], fixCount: best.fixedList.length, alternatives,
        rootCause: best.fixedList.length > 1 || cols[best.c].formula === undefined,
      });
    }
    const unexplained = [...broken].map((bk) => {
      const [fid, ps] = bk.split(':'); const f = formulas[+fid], p = +ps;
      return { formula: f.id, col: f.target, pos: p, row: rowNum[p], typed: work.get(f.target)[p], expected: finalValue(f, predict(f, p, getIn, keyOf), cols[f.target].decimals) };
    });
    corrections.sort((a, b) => a.pos - b.pos || a.col - b.col);

    // ---- text functional dependencies (City → State …)
    const fds = [];
    for (const a of texts) for (const b of texts) {
      if (a === b) continue;
      const all = []; for (let p = 0; p < n; p++) if (cols[b].text[p] !== '') all.push(p);
      const g = groupsBy(ctx, a, all);
      if (!groupingIsMeaningful(g, all.length)) continue;
      const bVals = new Set(all.map((p) => cols[b].text[p]));
      if (bVals.size < 2 || bVals.size >= g.size + 1 && bVals.size > g.size) continue;
      let ok = 0; const violations = [], map = new Map();
      for (const [k, ps] of g) {
        const counts = new Map(); ps.forEach((p) => counts.set(cols[b].text[p], (counts.get(cols[b].text[p]) || 0) + 1));
        const s = [...counts.entries()].sort((x, y) => y[1] - x[1]);
        map.set(k, s[0][0]);
        ok += s[0][1];
        if (s.length > 1 && s[0][1] > s[1][1]) ps.forEach((p) => { if (cols[b].text[p] !== s[0][0]) violations.push({ pos: p, row: rowNum[p], typed: cols[b].text[p], expected: s[0][0] }); });
      }
      if (ok < 0.9 * all.length) continue;
      // skip the reverse direction of a perfect 1:1 mapping
      if (bVals.size === g.size && fds.some((x) => x.from === b && x.to === a)) continue;
      fds.push({ from: a, to: b, groups: g.size, violations, map });
    }

    // ---- summary rows (Total lines)
    const summaries = [];
    for (const ri of summaryIdx) {
      const prevSummary = summaryIdx.filter((s) => s < ri).pop();
      for (const c of numeric) {
        const pv = parseNumber(body[ri][c], cols[c].decComma);
        if (!pv) continue;
        const posIn = (lo) => dataIdx.map((di, p) => [di, p]).filter(([di]) => di < ri && di > lo).map(([, p]) => p);
        const tryRange = (ps) => {
          if (!ps.length) return null;
          let s = 0; for (const p of ps) s += getIn(c, p);
          const sOrig = ps.reduce((acc, p) => acc + cols[c].input[p], 0);
          return { ps, s, sOrig };
        };
        const ranges = [];
        if (prevSummary !== undefined) ranges.push(tryRange(posIn(prevSummary)));
        ranges.push(tryRange(posIn(-1)));
        const tol = 0.5 * Math.pow(10, -cols[c].decimals) + 1e-9 * Math.abs(pv.v);
        let found = null;
        for (const r of ranges) {
          if (!r) continue;
          if (Math.abs(r.sOrig - pv.v) <= tol) { found = { ok: true, r }; break; }
        }
        const r = found ? found.r : ranges.filter(Boolean).pop();
        if (!r) continue;
        const ok = !!found;
        const lo = rowNum[r.ps[0]], hi = rowNum[r.ps[r.ps.length - 1]];
        summaries.push({
          rowIndex: ri, row: ri + 2, col: c, ok, typed: pv.v, sum: r.sOrig,
          excel: '=SUM(' + cols[c].letter + lo + ':' + cols[c].letter + hi + ')',
          // after applying corrections, does the total line up?
          fixedSum: r.s,
        });
      }
    }

    const cellCount = n * width;
    return hydrate({
      header, body, delim, dataIdx, summaryIdx, rowNum, n,
      cols: cols.map((c) => {
        const out = { name: c.name, index: c.index, letter: c.letter, type: c.type, raw: c.raw };
        if (c.type === 'number') Object.assign(out, { values: Array.from(c.values), blank: c.blank, decimals: c.decimals, pct: c.pct, decComma: c.decComma, formula: c.formula });
        else out.text = c.text;
        return out;
      }),
      formulas,
      corrections, unexplained, fds, summaries,
      stats: { cells: cellCount, ms: Date.now() - t0, numeric: numeric.length, text: texts.length },
    });
  }

  // Results cross a Web Worker boundary as plain data; this re-attaches the helpers.
  function hydrate(result) {
    const ctx = { cols: result.cols, rowNum: result.rowNum };
    for (const f of result.formulas) f.excelAt = (p) => excelFormula(f, p, ctx);
    return result;
  }
  function dehydrate(result) {
    for (const f of result.formulas) delete f.excelAt;
    return result;
  }

  // ---------------------------------------------------------------- live recompute

  // Given a result and a set of numeric input overrides {col: {pos: value}},
  // recompute every derived cell from its formula (topological + row order).
  function recompute(result, overrides) {
    const vals = new Map();
    for (const c of result.cols) if (c.type === 'number') {
      const arr = c.values.map((v, p) => (c.blank[p] ? 0 : v));
      vals.set(c.index, arr);
    }
    for (const [c, m] of Object.entries(overrides || {})) for (const [p, v] of Object.entries(m)) vals.get(+c)[+p] = v;
    const get = (c, p) => vals.get(c)[p];
    const keyOf = (c, p) => result.cols[c].text[p];
    for (const f of result.formulas) {
      const d = result.cols[f.target].decimals;
      const arr = vals.get(f.target);
      for (let p = 0; p < result.n; p++) {
        if (f.lag && p === 0) continue; // opening value stays as typed
        const pred = predict(f, p, get, keyOf);
        if (isFinite(pred)) arr[p] = finalValue(f, pred, d);
      }
    }
    return vals;
  }

  // CSV whose derived cells are live spreadsheet formulas again.
  function livingCSV(result, opts) {
    opts = opts || {};
    const ctxLike = { cols: result.cols, rowNum: result.rowNum };
    const rows = [result.header.slice()];
    const posOf = new Map(result.dataIdx.map((ri, p) => [ri, p]));
    const fixes = new Map();
    if (opts.applyCorrections !== false) for (const c of result.corrections) {
      if (result.cols[c.col].formula === undefined) fixes.set(c.col + ':' + c.pos, c.suggested);
    }
    result.body.forEach((r, ri) => {
      const out = r.slice();
      if (posOf.has(ri)) {
        const p = posOf.get(ri);
        for (const c of result.cols) {
          if (c.type !== 'number' || c.blank[p]) continue;
          const f = c.formula !== undefined ? result.formulas.find((x) => x.target === c.index) : null;
          if (f && !(f.lag && p === 0)) out[c.index] = excelFormula(f, p, ctxLike);
          else {
            const k = c.index + ':' + p;
            out[c.index] = numStr(fixes.has(k) ? fixes.get(k) : c.values[p]);
          }
        }
      } else {
        for (const s of result.summaries) if (s.rowIndex === ri && s.ok) out[s.col] = s.excel;
      }
      rows.push(out);
    });
    return toCSV(rows);
  }

  const api = { analyze, hydrate, dehydrate, recompute, livingCSV, parseCSV, parseNumber, toCSV, diagnose, roundTo, fmt, numStr, colLetter, predict, mulberry32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Unbake = api;
})(typeof window !== 'undefined' ? window : globalThis);
