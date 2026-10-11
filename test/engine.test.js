const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/engine.js');
const S = require('../src/samples.js');

const pretty = (r, f) => f.tokens.map((t) => (t.t === 'col' ? (t.prev ? 'previous ' + t.s : t.s) : t.s)).join('');
const formulaFor = (r, name) => r.formulas.find((f) => r.cols[f.target].name === name);

test('parseNumber understands spreadsheet formatting', () => {
  assert.deepStrictEqual(U.parseNumber('$1,234.50'), { v: 1234.5, decimals: 2, pct: false });
  assert.strictEqual(U.parseNumber('(12.00)').v, -12);
  assert.strictEqual(U.parseNumber('7.25%').v, 0.0725);
  assert.strictEqual(U.parseNumber('7.25%').decimals, 4);
  assert.strictEqual(U.parseNumber('-$3').v, -3);
  assert.strictEqual(U.parseNumber('abc'), null);
  assert.strictEqual(U.parseNumber('2026-03-01'), null);
});

test('parseCSV handles quotes, embedded commas and semicolons', () => {
  assert.deepStrictEqual(U.parseCSV('a,b\n"x, y","he said ""hi"""\n').rows, [['a', 'b'], ['x, y', 'he said "hi"']]);
  assert.deepStrictEqual(U.parseCSV('a;b\n1;2\n').rows, [['a', 'b'], ['1', '2']]);
});

test('diagnose recognises human typos', () => {
  assert.strictEqual(U.diagnose(21, 12, 0).kind, 'swap');
  assert.strictEqual(U.diagnose(2870.4, 287.04, 2).kind, 'decimal');
  assert.strictEqual(U.diagnose(55.18, 575.18, 2).kind, 'dropped');
  assert.strictEqual(U.diagnose(80.7, 86.7, 2).kind, 'digit');
  assert.strictEqual(U.diagnose(-5, 5, 0).kind, 'sign');
});

for (const sample of S.all()) {
  test(`sample "${sample.title}": recovers every planted formula and every planted typo, nothing else`, () => {
    const r = U.analyze(sample.csv);
    for (const name of Object.keys(sample.truth.formulas)) {
      assert.ok(formulaFor(r, name), `expected a formula for ${name}`);
    }
    const found = r.corrections.map((c) => `${r.cols[c.col].name}@${c.row}=${c.suggested}`).sort();
    const planted = sample.truth.corrections.map((c) => `${c.col}@${c.row}=${c.suggested}`).sort();
    assert.deepStrictEqual(found, planted);
    assert.strictEqual(r.unexplained.length, 0);
    for (const c of sample.truth.corrections) {
      const got = r.corrections.find((x) => r.cols[x.col].name === c.col && x.row === c.row);
      assert.strictEqual(got.diagnosis.kind, c.kind, `diagnosis for ${c.col}@${c.row}`);
    }
  });
}

test('invoice: exact structure of recovered formulas', () => {
  const r = U.analyze(S.all()[0].csv);
  assert.strictEqual(pretty(r, formulaFor(r, 'Subtotal')), 'Qty × Unit Price');
  assert.strictEqual(pretty(r, formulaFor(r, 'Discount')), 'round(Subtotal × Disc %, 2)');
  assert.strictEqual(pretty(r, formulaFor(r, 'Net')), 'Subtotal − Discount');
  assert.strictEqual(pretty(r, formulaFor(r, 'Total')), 'Net + Tax');
  const tax = formulaFor(r, 'Tax');
  assert.strictEqual(tax.kind, 'rate');
  assert.strictEqual(r.cols[tax.key].name, 'State');
  assert.deepStrictEqual(Object.fromEntries(tax.map), S.all()[0].truth.rates);
  const price = formulaFor(r, 'Unit Price');
  assert.deepStrictEqual(Object.fromEntries(price.map), S.all()[0].truth.prices);
});

test('ledger: running balance and the Total line', () => {
  const r = U.analyze(S.all()[1].csv);
  assert.strictEqual(pretty(r, formulaFor(r, 'Balance')), 'Deposit − Withdrawal + previous Balance');
  assert.ok(r.summaries.length === 2 && r.summaries.every((s) => s.ok && /^=SUM\(/.test(s.excel)));
});

test('payroll: overtime at time-and-a-half is recovered with exact coefficients', () => {
  const r = U.analyze(S.all()[2].csv);
  assert.strictEqual(pretty(r, formulaFor(r, 'Gross')), 'round(Hours × Rate + 1.5 × OT Hours × Rate, 2)');
  assert.strictEqual(pretty(r, formulaFor(r, 'Net')), 'Gross − Tax − Benefits');
});

test('no false discoveries on independent random columns', () => {
  const R = U.mulberry32(99);
  for (let trial = 0; trial < 5; trial++) {
    const lines = ['A,B,C,D,E,Label'];
    for (let i = 0; i < 60; i++) {
      lines.push([1 + Math.floor(R() * 20), (R() * 100).toFixed(2), (R() * 1000).toFixed(2), Math.floor(R() * 500), (R() * 10).toFixed(3), ['x', 'y', 'z'][Math.floor(R() * 3)]].join(','));
    }
    const r = U.analyze(lines.join('\n'));
    assert.strictEqual(r.formulas.length, 0, 'found: ' + r.formulas.map((f) => pretty(r, f)).join('; '));
    assert.strictEqual(r.corrections.length, 0);
  }
});

test('fuzz: random hidden formulas are recovered from rounded values', () => {
  const R = U.mulberry32(5);
  const coefs = [2, 0.15, 1.25, 3, 0.0825, 12];
  for (let trial = 0; trial < 12; trial++) {
    const a = coefs[Math.floor(R() * coefs.length)], b = coefs[Math.floor(R() * coefs.length)];
    const shape = trial % 3;
    const lines = ['X,Y,Z,Out'];
    for (let i = 0; i < 40; i++) {
      const x = +(1 + R() * 50).toFixed(2), y = +(1 + R() * 9).toFixed(1), z = Math.floor(R() * 30);
      const out = shape === 0 ? a * x + b * z : shape === 1 ? a * x * y : x * y - b * z;
      lines.push([x, y, z, U.roundTo(out, 2).toFixed(2)].join(','));
    }
    const r = U.analyze(lines.join('\n'));
    const f = formulaFor(r, 'Out');
    assert.ok(f, 'no formula for trial ' + trial);
    assert.strictEqual(f.inliers, 40, pretty(r, f));
    // the recovered formula must regenerate the column exactly
    const live = U.recompute(r, {});
    const out = r.cols.find((c) => c.name === 'Out');
    live.get(out.index).forEach((v, p) => assert.ok(Math.abs(v - out.values[p]) < 1e-9));
  }
});

test('living spreadsheet export writes formulas with correct cell references', () => {
  const r = U.analyze(S.all()[0].csv);
  const rows = U.parseCSV(U.livingCSV(r)).rows;
  assert.strictEqual(rows[0][7], 'Subtotal');
  assert.strictEqual(rows[1][7], '=F2*G2');
  assert.strictEqual(rows[5][12], '=K6+L6');
  assert.strictEqual(rows[2][0], '=A2+1');
  // the Qty typo is repaired in the export (input cells carry corrected values)
  assert.strictEqual(rows[15][5], '12');
});

test('recompute propagates an edited input through the formula graph', () => {
  const r = U.analyze(S.all()[2].csv);
  const hours = r.cols.findIndex((c) => c.name === 'Hours'), net = r.cols.findIndex((c) => c.name === 'Net');
  const before = U.recompute(r, {}).get(net)[0];
  const after = U.recompute(r, { [hours]: { 0: r.cols[hours].values[0] + 1 } }).get(net)[0];
  const rate = r.cols.find((c) => c.name === 'Rate').values[0];
  assert.ok(Math.abs(after - before - rate * 0.78) < 0.011, `${before} → ${after}`);
});

test('helpful errors on unusable input', () => {
  assert.throws(() => U.analyze('a,b\n1,2\n'), /at least 6/);
  assert.throws(() => U.analyze(''), /header row/);
});

test('European number formats: decimal comma, dot/space thousands, trailing currency', () => {
  assert.strictEqual(U.parseNumber('1.234,56 €', true).v, 1234.56);
  assert.strictEqual(U.parseNumber('1 234,5', true).v, 1234.5);
  assert.strictEqual(U.parseNumber("1'234.50").v, 1234.5);
  assert.strictEqual(U.parseNumber('EUR 12,40', true).v, 12.4);
  assert.strictEqual(U.parseNumber('12,40', true).decimals, 2);
  assert.strictEqual(U.parseNumber('150-').v, -150);
  // a semicolon-separated German export: Menge;Preis;Netto;MwSt;Brutto with 19% VAT
  const R = U.mulberry32(11), lines = ['Artikel;Menge;Preis;Netto;MwSt;Brutto'];
  const de = (x) => x.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  for (let i = 0; i < 20; i++) {
    const q = 1 + Math.floor(R() * 40), pr = [12.5, 1299, 89.9, 4.75][i % 4];
    const net = U.roundTo(q * pr, 2), vat = U.roundTo(net * 0.19, 2);
    lines.push(['A' + i, q, de(pr), de(net), de(vat), de(i === 7 ? net + vat + 900 : net + vat)].join(';'));
  }
  const r = U.analyze(lines.join('\n'));
  assert.strictEqual(pretty(r, formulaFor(r, 'Netto')), 'Menge × Preis');
  assert.strictEqual(pretty(r, formulaFor(r, 'MwSt')), 'round(0.19 × Netto, 2)');
  assert.strictEqual(pretty(r, formulaFor(r, 'Brutto')), 'Netto + MwSt');
  assert.deepStrictEqual(r.corrections.map((c) => c.row), [9]);
});

test('results survive a structured clone (Web Worker boundary) and re-hydrate', () => {
  const r = U.analyze(S.all()[0].csv);
  const cloned = U.hydrate(structuredClone(U.dehydrate(r)));
  assert.strictEqual(cloned.formulas.find((f) => f.kind === 'rate').map.get('CA'), 0.0725);
  assert.strictEqual(U.livingCSV(cloned).split('\n')[1].includes('=F2*G2'), true);
});

test('IF rules: free shipping from $50 (constant branches, ≥ threshold)', () => {
  const R = U.mulberry32(21), lines = ['Order,Subtotal,Shipping,Total'];
  for (let i = 0; i < 30; i++) {
    const sub = U.roundTo(12 + R() * 90, 2), ship = sub >= 50 ? 0 : 5.99;
    lines.push([1000 + i, sub.toFixed(2), ship.toFixed(2), U.roundTo(sub + ship, 2).toFixed(2)].join(','));
  }
  lines.push([1030, '50.00', '0.00', '50.00'].join(',')); // exactly on the threshold
  const r = U.analyze(lines.join('\n'));
  assert.strictEqual(pretty(r, formulaFor(r, 'Shipping')), 'if(Subtotal ≥ 50, 0, 5.99)');
  assert.strictEqual(formulaFor(r, 'Shipping').excelAt(0), '=IF(B2>=50,0,5.99)');
  assert.strictEqual(r.corrections.length, 0);
});

test('IF rules: payout sample recovers overtime and commission thresholds exactly', () => {
  const r = U.analyze(S.all()[3].csv);
  const base = formulaFor(r, 'Base Pay'), comm = formulaFor(r, 'Commission');
  assert.strictEqual(base.kind, 'if');
  assert.strictEqual(base.c, 40);
  assert.strictEqual(pretty(r, comm), 'round(if(Sales > 20000, 0.07 × Sales − 600, 0.04 × Sales), 2)');
  // the living export still recalculates: recompute reproduces every non-typo cell
  const live = U.recompute(r, {});
  const c = r.cols.find((x) => x.name === 'Commission');
  const mismatches = c.values.filter((v, p) => Math.abs(v - live.get(c.index)[p]) > 0.006).length;
  assert.strictEqual(mismatches, 1); // only the planted typo
});

// ---------------------------------------------------------------- workbook (SheetJS) features
const XLSX = require('../vendor/xlsx.full.min.js');
const W = require('../src/workbook.js');

function workbookWithLiveFormulas() {
  // Qty | Price | Total (=A*B), with row 6 typed over and row 9 using a different formula
  const rows = [['Qty', 'Price', 'Total']];
  for (let i = 0; i < 10; i++) rows.push([i + 2, 1.5 * ((i % 3) + 1), null]);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  for (let r = 2; r <= 11; r++) ws['C' + r] = { t: 'n', v: ws['A' + r].v * ws['B' + r].v, f: 'A' + r + '*B' + r };
  ws.C6 = { t: 'n', v: 99 };                          // hard-coded over the formula
  ws.C9 = { t: 'n', v: ws.A9.v * ws.B9.v + 1, f: 'A9*B9+1' }; // inconsistent formula
  ws['!ref'] = 'A1:C11';
  return ws;
}

test('relative formula patterns line up across rows', () => {
  assert.strictEqual(W.toRelative('=B2*C2', 1, 3), W.toRelative('=b3 * c3', 2, 3));
  assert.notStrictEqual(W.toRelative('=B2*C2', 1, 3), W.toRelative('=B2*$C$2', 1, 3));
  assert.strictEqual(W.fromRelative(W.toRelative('=ROUND(B2*$H$1,2)', 1, 3), 6, 3), '=ROUND(B7*$H$1,2)');
  assert.strictEqual(W.toRelative('=IF(A2="B2",1,0)', 1, 2).includes('"B2"'), true); // strings untouched
});

test('workbook audit finds typed-over and inconsistent formulas', () => {
  const ws = workbookWithLiveFormulas();
  const table = W.sheetTable(XLSX, ws);
  const audit = W.auditSheet(XLSX, ws, table);
  assert.strictEqual(audit.columns.length, 1);
  assert.strictEqual(audit.columns[0].example, '=A2*B2');
  const kinds = audit.issues.map((i) => i.kind + '@' + i.sheetRow + ' ' + i.expected).sort();
  assert.deepStrictEqual(kinds, ['hardcoded@6 =A6*B6', 'inconsistent@9 =A9*B9']);
  // and Unbake's own recovered formula agrees with the file's
  const r = U.analyze(table.csv);
  const f = formulaFor(r, 'Total');
  assert.strictEqual(W.compareFormula(f, 0, r, audit.columns[0]).same, true);
  assert.deepStrictEqual(r.corrections.map((c) => c.row).sort(), [6, 9]);
});

test('Excel export: formulas, corrections, comments, links and highlight styles', () => {
  const r = U.analyze(S.all()[0].csv);
  const overrides = {};
  for (const c of r.corrections) if (r.cols[c.col].formula === undefined) (overrides[c.col] = overrides[c.col] || {})[c.pos] = c.suggested;
  const u8 = W.buildExport(XLSX, r, { engine: U, name: 'invoices', live: U.recompute(r, overrides), overrides });
  const wb = XLSX.read(u8, { type: 'array', cellStyles: true });
  assert.deepStrictEqual(wb.SheetNames, ['invoices', 'Suspect cells', 'Formulas']);
  const d = wb.Sheets.invoices;
  assert.strictEqual(d.H2.f, 'F2*G2');
  assert.strictEqual(d.H2.z, '"$"#,##0.00');
  assert.strictEqual(d.F16.v, 12);                       // mistyped Qty repaired
  assert.match(d.F16.c[0].t, /Typed as 21/);
  assert.strictEqual(d.F16.s.fgColor.rgb, 'E3F3E8');     // green: repaired input
  assert.strictEqual(d.M31.s.fgColor.rgb, 'FDE2DE');     // red: suspect derived cell
  assert.strictEqual(d.M31.v, 287.04);
  assert.strictEqual(wb.Sheets['Suspect cells'].C2.l.Target, "#'invoices'!G8");
  assert.strictEqual(XLSX.utils.sheet_to_json(wb.Sheets.Formulas).length, r.formulas.length);
});
