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
  assert.strictEqual(rows[2][0], '=1+A2');
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
