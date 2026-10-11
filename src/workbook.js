/*
 * Unbake workbook helpers. Everything that needs SheetJS lives here, and SheetJS is
 * passed in (the browser lazy-loads it; tests require it from vendor/).
 *
 *   sheetTable(XLSX, ws)              worksheet → CSV for the engine + where each line came from
 *   auditSheet(XLSX, ws, table)       find typed-over and inconsistent formulas still in the file
 *   compareFormula(f, p, colAudit)    does Unbake's recovered formula match the file's own?
 *   buildExport(XLSX, R, opts)        .xlsx with live formulas, highlights, comments, report sheets
 */
(function (global) {
  'use strict';

  const csvCell = (c) => { const s = c == null ? '' : String(c); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

  // ------------------------------------------------------------------ reading

  function sheetTable(XLSX, ws) {
    if (!ws || !ws['!ref']) return null;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const lines = [], sheetRows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        cells.push(cell ? String(cell.w != null ? cell.w : XLSX.utils.format_cell(cell)) : '');
      }
      if (cells.some((x) => x.trim() !== '')) { lines.push(cells); sheetRows.push(r); }
    }
    if (!lines.length) return null;
    return {
      csv: lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n',
      sheetRows, startCol: range.s.c, size: lines.length * (range.e.c - range.s.c + 1),
    };
  }

  // Relative form of a formula so "=B2*C2" in D2 and "=B3*C3" in D3 compare equal.
  // r, c: the cell's own 0-based row/column. String literals are left untouched.
  const REF = /(^|[^A-Za-z0-9_.!$⟨])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g;
  function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
  function colLetters(i) { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  function toRelative(formula, r, c) {
    const parts = String(formula).replace(/^=/, '').split(/("(?:[^"]|"")*")/);
    return parts.map((part, i) => {
      if (i % 2) return part; // inside quotes
      return part.toUpperCase().replace(/\s+/g, '').replace(REF, (m, pre, ca, col, ra, row) => {
        const cs = ca ? 'C' + colIndex(col) : 'C[' + (colIndex(col) - c) + ']';
        const rs = ra ? 'R' + (+row - 1) : 'R[' + (+row - 1 - r) + ']';
        return pre + '⟨' + rs + cs + '⟩';
      });
    }).join('');
  }

  function fromRelative(pattern, r, c) {
    return '=' + pattern.replace(/⟨R(\[(-?\d+)\]|(\d+))C(\[(-?\d+)\]|(\d+))⟩/g, (m, _a, rr, ra, _b, cr, ca) => {
      const row = ra !== undefined ? '$' + (+ra + 1) : String(r + +rr + 1);
      const col = ca !== undefined ? '$' + colLetters(+ca) : colLetters(c + +cr);
      return col + row;
    });
  }

  const AGGREGATE = /\b(SUM|SUMIF|SUMIFS|SUBTOTAL|AVERAGE|AVERAGEIF|COUNT|COUNTA|COUNTIF|MIN|MAX|PRODUCT)\s*\([^)]*:/i;

  // For every column where most data cells hold a formula, find the dominant formula
  // and the cells that deviate: plain numbers typed over it ("hardcoded") and cells
  // holding a different formula ("inconsistent"). bodyIndex = row among the engine's
  // body rows (header excluded, totals rows included); col = engine column.
  function auditSheet(XLSX, ws, table) {
    const out = { columns: [], issues: [], formulaCells: 0 };
    if (!table) return out;
    const width = XLSX.utils.decode_range(ws['!ref']).e.c - table.startCol + 1;
    for (let j = 0; j < width; j++) {
      const c = table.startCol + j;
      const entries = [];
      for (let i = 1; i < table.sheetRows.length; i++) {
        const r = table.sheetRows[i];
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        if (cell.f) {
          out.formulaCells++;
          if (AGGREGATE.test(cell.f)) continue; // totals rows legitimately differ
          entries.push({ bodyIndex: i - 1, r, kind: 'formula', formula: '=' + cell.f, pattern: toRelative(cell.f, r, c), value: cell.v });
        } else if (cell.t === 'n') entries.push({ bodyIndex: i - 1, r, kind: 'value', value: cell.v });
      }
      const formulas = entries.filter((e) => e.kind === 'formula');
      if (formulas.length < 3 || formulas.length < 0.5 * entries.length) continue;
      const counts = new Map();
      for (const e of formulas) counts.set(e.pattern, (counts.get(e.pattern) || 0) + 1);
      const [pattern, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const first = formulas.find((e) => e.pattern === pattern);
      out.columns.push({ col: j, pattern, count, formulaCount: formulas.length, cells: entries.length, example: first.formula, exampleRow: first.r + 1 });
      if (count < 0.6 * formulas.length) continue; // no clear convention to deviate from
      for (const e of entries) {
        if (e.kind === 'formula' && e.pattern === pattern) continue;
        out.issues.push({
          kind: e.kind === 'value' ? 'hardcoded' : 'inconsistent',
          col: j, bodyIndex: e.bodyIndex, sheetRow: e.r + 1, value: e.value,
          formula: e.formula || null, expected: fromRelative(pattern, e.r, c),
        });
      }
    }
    return out;
  }

  // Compare Unbake's recovered formula (engine coordinates) with the file's own.
  function compareFormula(f, p, R, colAudit) {
    if (!colAudit) return null;
    const mine = f.excelAt(p);
    const same = toRelative(mine, R.rowNum[p] - 1, f.target) === colAudit.pattern;
    return { same, fileFormula: colAudit.example, fileRow: colAudit.exampleRow, count: colAudit.count, cells: colAudit.cells };
  }

  // ------------------------------------------------------------------ export

  function numberFormat(col) {
    const raw = col.raw.filter(Boolean);
    const most = (re) => raw.filter((s) => re.test(s)).length > raw.length / 2;
    const d = col.decimals;
    if (col.pct) { const pd = Math.max(0, d - 2); return '0' + (pd ? '.' + '0'.repeat(pd) : '') + '%'; }
    const sep = raw.some((s) => (col.decComma ? /\d[.\s ]\d{3}/ : /\d,\d{3}/).test(s));
    let base = (sep ? '#,##0' : '0') + (d ? '.' + '0'.repeat(Math.min(d, 10)) : '');
    if (most(/^[-(]?\$/)) base = '"$"' + base;
    else if (most(/^[-(]?£/)) base = '"£"' + base;
    else if (most(/^[-(]?€/) || most(/€\s*\)?$/)) base = base + ' "€"';
    return base;
  }

  function prettyText(f) { return f.tokens.map((t) => (t.t === 'col' ? (t.prev ? 'previous ' + t.s : t.s) : t.s)).join(''); }

  function sheetName(s) { return (String(s || 'Data').replace(/[\[\]:*?\/\\]/g, ' ').trim() || 'Data').slice(0, 31); }

  // opts: { name, live (Map col→values), overrides ({col:{pos:value}}), rowLabel(p), audit }
  function buildExport(XLSX, R, opts) {
    const U = opts.engine;
    const fmt = (c, v) => U.fmt(v, R.cols[c].decimals);
    const enc = (r, c) => XLSX.utils.encode_cell({ r, c });
    const styles = {}; // per sheet: { A1: 'header' | 'derived' | 'suspect' | 'fixed' }
    const dataName = sheetName(opts.name);
    const formats = R.cols.map((c) => (c.type === 'number' ? numberFormat(c) : null));
    const correction = new Map(R.corrections.map((c) => [c.pos + ':' + c.col, c]));
    const unexplained = new Map(R.unexplained.map((u) => [u.pos + ':' + u.col, u]));
    const posOf = new Map(R.dataIdx.map((ri, p) => [ri, p]));

    // --- data sheet: repaired, formulas restored
    const ws = {}, st = (styles[dataName] = {});
    R.header.forEach((h, c) => { ws[enc(0, c)] = { t: 's', v: h }; st[enc(0, c)] = 'header'; });
    R.body.forEach((row, ri) => {
      const r = ri + 1;
      const p = posOf.get(ri);
      R.cols.forEach((col, c) => {
        const ref = enc(r, c);
        if (col.type === 'text') { if (row[c] !== '') ws[ref] = { t: 's', v: row[c] }; return; }
        if (p === undefined) { // totals row
          const s = R.summaries.find((x) => x.rowIndex === ri && x.col === c);
          if (s && s.ok) { ws[ref] = { t: 'n', v: opts.live.get(c).reduce((a, x) => a + x, 0), f: s.excel.slice(1), z: formats[c] }; st[ref] = 'derived'; }
          else if (row[c] !== '') { const pv = U.parseNumber(row[c], col.decComma); ws[ref] = pv ? { t: 'n', v: pv.v, z: formats[c] } : { t: 's', v: row[c] }; }
          return;
        }
        const f = col.formula !== undefined ? R.formulas[col.formula] : null;
        const k = p + ':' + c, fix = correction.get(k), odd = unexplained.get(k);
        if (f && !(f.lag && p === 0)) {
          ws[ref] = { t: 'n', v: opts.live.get(c)[p], f: f.excelAt(p).slice(1), z: formats[c] };
          st[ref] = 'derived';
          if (fix || odd) {
            st[ref] = 'suspect';
            const typed = fix ? fix.typed : odd.typed;
            ws[ref].c = [{ a: 'Unbake', t: 'Exported value was ' + (typed === null ? '(blank)' : fmt(c, typed)) + '. The recovered formula gives ' + fmt(c, opts.live.get(c)[p]) + (fix ? ' (' + fix.diagnosis.label + ').' : '.') }];
          }
          return;
        }
        if (col.blank[p] && !(opts.overrides[c] && opts.overrides[c][p] !== undefined)) return;
        const v = opts.overrides[c] && opts.overrides[c][p] !== undefined ? opts.overrides[c][p] : col.values[p];
        ws[ref] = { t: 'n', v, z: formats[c] };
        if (fix) {
          st[ref] = 'fixed';
          ws[ref].c = [{ a: 'Unbake', t: 'Typed as ' + (fix.typed === null ? '(blank)' : fmt(c, fix.typed)) + ', corrected to ' + fmt(c, fix.suggested) + ': ' + fix.diagnosis.label + '. Check this against the source.' }];
        }
      });
    });
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R.body.length, c: R.cols.length - 1 } });
    ws['!cols'] = R.cols.map((c, j) => ({ wch: Math.min(40, Math.max(10, R.header[j].length + 2, ...c.raw.slice(0, 200).map((s) => s.length + 2))) }));

    // --- suspect cells sheet
    const label = opts.rowLabel || ((p) => R.rowNum[p]);
    const sus = [['Row in your file', 'Column', 'Cell in this workbook', 'Typed', 'Suggested', 'Why', 'Repairs']];
    const links = [];
    const cellOf = (c, p) => R.cols[c].letter + R.rowNum[p];
    // what the file's own formulas say about a cell, if anything (merged into one line)
    const fileNote = new Map();
    const dataPos = new Map(R.dataIdx.map((ri, p) => [ri, p]));
    const auditIssues = ((opts.audit && opts.audit.issues) || []).map((iss) => Object.assign({ p: dataPos.get(iss.bodyIndex) }, iss));
    for (const iss of auditIssues) if (iss.p !== undefined) fileNote.set(iss.p + ':' + iss.col, iss);
    const noteText = (iss) => (iss.kind === 'hardcoded'
      ? 'In the file, a typed number replaced the formula ' + iss.expected
      : 'In the file, ' + iss.formula + ' differs from the column\u2019s ' + iss.expected);
    const used = new Set();
    const why = (text, p, c) => {
      const iss = fileNote.get(p + ':' + c);
      if (!iss) return text;
      used.add(iss);
      return text + '. ' + noteText(iss);
    };
    for (const c of R.corrections) {
      links.push(sus.length);
      sus.push([label(c.pos), R.cols[c.col].name, cellOf(c.col, c.pos), c.typed === null ? '' : c.typed, c.suggested,
        why(c.diagnosis.label[0].toUpperCase() + c.diagnosis.label.slice(1), c.pos, c.col),
        c.fixes.map((id) => R.cols[R.formulas[id].target].name).join(', ') + (c.fixCount > 1 ? ' (root cause)' : '')]);
    }
    for (const u of R.unexplained) {
      links.push(sus.length);
      sus.push([label(u.pos), R.cols[u.col].name, cellOf(u.col, u.pos), u.typed, u.expected, why('No single cell fix explains this; possibly a manual override', u.pos, u.col), '']);
    }
    for (const iss of auditIssues) {
      if (used.has(iss)) continue;
      if (iss.p !== undefined) links.push(sus.length);
      sus.push([iss.sheetRow, R.cols[iss.col] ? R.cols[iss.col].name : '', iss.p !== undefined ? cellOf(iss.col, iss.p) : '',
        iss.kind === 'hardcoded' ? iss.value : iss.formula, iss.expected, noteText(iss), '']);
    }
    if (sus.length === 1) sus.push(['', 'No suspect cells', '', '', '', '', '']);
    const ws2 = XLSX.utils.aoa_to_sheet(sus);
    const st2 = (styles['Suspect cells'] = {});
    for (let c = 0; c < 7; c++) st2[enc(0, c)] = 'header';
    for (const r of links) {
      const ref = enc(r, 2);
      ws2[ref].l = { Target: "#'" + dataName.replace(/'/g, "''") + "'!" + sus[r][2], Tooltip: 'Go to the cell' };
      st2[enc(r, 3)] = 'suspect'; st2[enc(r, 4)] = 'fixed';
    }
    ws2['!cols'] = [{ wch: 15 }, { wch: 16 }, { wch: 19 }, { wch: 14 }, { wch: 14 }, { wch: 70 }, { wch: 30 }];

    // --- formulas sheet
    const fr = [['Column', 'Recovered rule', 'Spreadsheet formula (first row)', 'Rows that match', 'Table']];
    for (const f of R.formulas) {
      const p0 = f.lag ? 1 : 0;
      const table = f.kind === 'lookup' || f.kind === 'rate'
        ? [...f.map.entries()].map(([k, v]) => k + ' = ' + (f.kind === 'rate' ? +(v * 100).toPrecision(6) + '%' : U.numStr(v))).join('; ') : '';
      fr.push([R.cols[f.target].name, prettyText(f), f.excelAt(p0), f.inliers + ' of ' + f.evaluable, table]);
    }
    for (const s of R.summaries) if (s.ok) fr.push([R.cols[s.col].name + ' (row ' + s.row + ')', 'Total of the rows above', s.excel, '', '']);
    const ws3 = XLSX.utils.aoa_to_sheet(fr);
    const st3 = (styles.Formulas = {});
    for (let c = 0; c < 5; c++) st3[enc(0, c)] = 'header';
    ws3['!cols'] = [{ wch: 18 }, { wch: 60 }, { wch: 50 }, { wch: 16 }, { wch: 60 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, dataName);
    XLSX.utils.book_append_sheet(wb, ws2, 'Suspect cells');
    XLSX.utils.book_append_sheet(wb, ws3, 'Formulas');
    const raw = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });
    return applyStyles(XLSX, new Uint8Array(raw), [styles[dataName], st2, st3]);
  }

  // SheetJS Community Edition writes no fills or fonts, so add them to the package:
  // extra fonts/fills/xfs in styles.xml, then point each marked cell's s="" at a copy of
  // its current xf (keeping its number format) with the fill and font applied.
  function applyStyles(XLSX, u8, perSheet) {
    const zip = XLSX.CFB.read(u8, { type: 'array' });
    const entry = (path) => zip.FileIndex[zip.FullPaths.findIndex((x) => x.endsWith('/' + path))];
    const read = (path) => new TextDecoder().decode(entry(path).content);
    const write = (path, text) => { const e = entry(path); e.content = new TextEncoder().encode(text); e.size = e.content.length; };

    let styles = read('xl/styles.xml');
    const KIND = {
      header: { fill: 'FFEEEBE3', font: 'bold' },
      derived: { fill: 'FFEAF0FD', font: null },
      suspect: { fill: 'FFFDE2DE', font: 'boldRed' },
      fixed: { fill: 'FFE3F3E8', font: 'bold' },
    };
    const fonts = styles.match(/<fonts count="(\d+)">([\s\S]*?)<\/fonts>/);
    const baseFont = fonts[2].match(/<font>[\s\S]*?<\/font>/)[0];
    const fontId = { bold: +fonts[1], boldRed: +fonts[1] + 1 };
    styles = styles.replace(fonts[0], '<fonts count="' + (+fonts[1] + 2) + '">' + fonts[2] +
      baseFont.replace('<font>', '<font><b/>') + baseFont.replace('<font>', '<font><b/>').replace(/<color [^>]*\/>/, '<color rgb="FFB42318"/>') + '</fonts>');
    const fills = styles.match(/<fills count="(\d+)">([\s\S]*?)<\/fills>/);
    const fillId = {};
    let extra = '';
    Object.keys(KIND).forEach((k, i) => { fillId[k] = +fills[1] + i; extra += '<fill><patternFill patternType="solid"><fgColor rgb="' + KIND[k].fill + '"/><bgColor indexed="64"/></patternFill></fill>'; });
    styles = styles.replace(fills[0], '<fills count="' + (+fills[1] + Object.keys(KIND).length) + '">' + fills[2] + extra + '</fills>');
    const xfs = styles.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
    const xfList = xfs[2].match(/<xf [^>]*?(\/>|>[\s\S]*?<\/xf>)/g);
    const added = [], memo = new Map();
    const xfFor = (base, kind) => {
      const key = base + '|' + kind;
      if (memo.has(key)) return memo.get(key);
      let xf = (xfList[base] || xfList[0]).replace(/ fillId="\d+"/, ' fillId="' + fillId[kind] + '"') ;
      xf = xf.replace('<xf ', '<xf applyFill="1" ');
      if (KIND[kind].font) xf = xf.replace(/ fontId="\d+"/, ' fontId="' + fontId[KIND[kind].font] + '"').replace('<xf ', '<xf applyFont="1" ');
      const id = xfList.length + added.length;
      added.push(xf); memo.set(key, id);
      return id;
    };
    perSheet.forEach((marks, i) => {
      const path = 'xl/worksheets/sheet' + (i + 1) + '.xml';
      const xml = read(path).replace(/<c r="([A-Z]+\d+)"([^>]*?)(\/?)>/g, (m, ref, attrs, selfClose) => {
        const kind = marks[ref];
        if (!kind) return m;
        const sm = attrs.match(/ s="(\d+)"/);
        const id = xfFor(sm ? +sm[1] : 0, kind);
        return '<c r="' + ref + '"' + (sm ? attrs.replace(/ s="\d+"/, ' s="' + id + '"') : attrs + ' s="' + id + '"') + selfClose + '>';
      });
      write(path, xml);
    });
    styles = styles.replace(xfs[0], '<cellXfs count="' + (xfList.length + added.length) + '">' + xfs[2] + added.join('') + '</cellXfs>');
    write('xl/styles.xml', styles);
    return new Uint8Array(XLSX.CFB.write(zip, { type: 'array', fileType: 'zip', compression: true }));
  }

  const api = { sheetTable, auditSheet, compareFormula, toRelative, fromRelative, buildExport, numberFormat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.UnbakeWorkbook = api;
})(typeof window !== 'undefined' ? window : globalThis);
