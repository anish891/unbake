#!/usr/bin/env node
// Usage: node cli.js <file.csv | --sample invoices|ledger|payroll> [--living out.csv]
const fs = require('fs');
const U = require('./src/engine.js');
const S = require('./src/samples.js');
const args = process.argv.slice(2);
let text;
if (args[0] === '--sample') { const s = S.all().find((x) => x.id === args[1]); if (!s) { console.error('unknown sample'); process.exit(1); } text = s.csv; }
else if (args[0]) text = fs.readFileSync(args[0], 'utf8');
else { console.error('usage: node cli.js <file.csv> | --sample <invoices|ledger|payroll> [--living out.csv]'); process.exit(1); }
let r;
try { r = U.analyze(text); } catch (e) { console.error('error:', e.message); process.exit(1); }
const name = (c) => r.cols[c].name;
const pretty = (f) => f.tokens.map((t) => (t.t === 'col' ? (t.prev ? 'prev(' + t.s + ')' : t.s) : t.s)).join('');
console.log(`\n${r.n} rows · ${r.cols.length} columns · ${r.stats.ms} ms\n\nRecovered formulas`);
for (const f of r.formulas) console.log(`  ${name(f.target).padEnd(12)} = ${pretty(f).padEnd(48)} ${f.inliers}/${f.evaluable} rows   ${f.excelAt(1)}`);
for (const s of r.summaries) console.log(`  ${'row ' + s.row} ${name(s.col)}: ${s.ok ? 'is ' + s.excel : 'should be SUM ' + s.sum + ' but is ' + s.typed}`);
for (const fd of r.fds) console.log(`  ${name(fd.from)} → ${name(fd.to)}  (${fd.violations.length} violations)`);
console.log('\nSuspect cells');
for (const c of r.corrections) console.log(`  row ${c.row} ${name(c.col).padEnd(11)} typed ${c.typed}  → should be ${c.suggested}   ${c.diagnosis.label}  [fixes: ${c.fixes.map((i) => name(r.formulas[i].target)).join(', ')}]`);
for (const c of r.corrections) for (const a of c.alternatives || []) console.log(`      row ${a.row} alternative: ${name(a.col)} → ${a.suggested} (${a.diagnosis.label})`);
for (const u of r.unexplained) console.log(`  row ${u.row} ${name(u.col)} typed ${u.typed} expected ${u.expected} (unexplained)`);
const i = args.indexOf('--living');
if (i >= 0) { fs.writeFileSync(args[i + 1], U.livingCSV(r)); console.log('\nwrote living spreadsheet → ' + args[i + 1]); }
