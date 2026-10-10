# unbake

**Formula archaeology for spreadsheets.**

When a spreadsheet gets exported to CSV (or a billing system, bank, or payroll tool hands you one), every formula is replaced by the number it happened to produce. Unbake works backwards from those numbers. It figures out the formulas that must have made them, then uses those formulas to find the cells someone typed wrong and to say what kind of mistake it was.

```
Subtotal = Qty × Unit Price                         34/36 rows exact
Tax      = round(Net × rate(State), 2)              CA → 7.25%  TX → 6.25%  NY → 4%  …
Balance  = Deposit − Withdrawal + ↑Balance          (running total)

row 8   Unit Price  $239.95 → $329.95   Two digits swapped (32 → 23). Repairs 2 broken calculations at once.
row 31  Total     $2,870.40 → $287.04   Decimal point slipped (×10).
```

Unbake makes no AI calls and uses no servers or dependencies. It's plain JavaScript running in your browser.

## Run it

```bash
python3 -m http.server 8737
```

Open http://localhost:8737 and click one of the three sample "dead exports", or drop in any CSV of your own. Opening `index.html` straight from disk also works.

Things to try:
1. Read the **Recovered formulas**. The tax rates, prices, the 1.5× overtime multiplier and the running balance all come out of the data. Nothing was hand-written.
2. In **Cells someone typed wrong**, click an entry to jump to the red cell. "Root cause" means a single typo knocked out more than one calculation.
3. Switch the table to **Alive again**. The formulas are live, the typos are fixed, and every white cell can be edited. Change a quantity and watch everything downstream recalculate.
4. **Download living spreadsheet**. You get a CSV whose derived cells are real formulas (`=ROUND(H2*I2,2)`, `SWITCH(...)` lookups, `=SUM(D2:D53)`). Open it in Excel, Google Sheets or LibreOffice and it calculates again.

Command line:

```bash
node cli.js --sample invoices          # or ledger / payroll
node cli.js your.csv --living out.csv  # writes the formula-restored spreadsheet
npm test                               # 14 tests, node:test, no deps
```

## Extra test files (`examples/`)

Drop these on the page or run `node cli.js examples/<file>`. Each has typos planted in it.

| File | Hidden formulas | Planted errors |
|---|---|---|
| `1-sales-commissions.csv` | `Revenue = Units × Unit Price`, `Commission = round(Revenue × rate(Region), 2)` (4 regional rates), `Payout = Commission + Bonus` | swapped digits in a Revenue, a wrong Payout, an extra zero in Units |
| `2-savings-compound-interest.csv` | `Balance = round(1.004 × previous Balance + Deposit − Withdrawal, 2)` (0.4%/month compounding) | swapped digits, decimal slip |
| `3-gradebook-weights.csv` | `Final = round(0.25×Homework + 0.35×Midterm + 0.40×Exam, 1)` | Midterm typed 85 for 58; one Final hand-curved +5 (honestly ambiguous: Unbake suggests "Homework 96 → 76" and lists "Final 75.5" as the alternative) |

## How it works (`src/engine.js`)

1. **Parsing.** CSV with delimiter detection (`, ; tab |`). Numbers can come as `$1,234.50`, `(12.00)`, `7.25%` or `-€3`. Each column's printed precision is recorded, because that precision decides how close a formula has to land to count as exact.
2. **Hypothesis library.** For each numeric column Unbake builds candidate terms: the constant 1, every other column X, every product X·Y, every ratio X÷Y, and the column's own value in the previous row (which covers running totals and sequences).
3. **Robust search.** Combinations of 1–4 terms are fitted with **RANSAC**: solve exactly from a minimal random set of rows, then count how many other rows agree. A few typos can't pull the fit off course. Survivors are refit by least squares on their inliers. Each coefficient is then **snapped** to the simplest number (fewest decimals, then small fractions) that loses no inliers. That is how `0.0824999…` becomes `0.0825` and `1.4999…` becomes `1.5`. It also detects whether the column was `ROUND`ed.
4. **Lookups and rate tables.** A column might be a function of a text key (`Unit Price = lookup(SKU)`), or a numeric column times a per-key rate (`Tax = Net × rate(State)`).
5. **Occam within noise.** Among candidates that explain nearly as many rows as the best one, the simplest wins. Spreadsheets compute left-to-right, so each column is first explained from columns to its left. Columns still unexplained after that may use any column that doesn't depend on them, so the result is always a DAG.
6. **Blame solver.** Every row that breaks a formula is a symptom. For each cell those broken rows touch, Unbake solves for the value that would repair them. It throws out any candidate that would break a formula that currently holds. It ranks what's left by how many breaks it repairs, plus how much the correction looks like a human slip: swapped adjacent digits, slipped decimal point, one wrong digit, a dropped or extra digit, a flipped sign. This is how it tells "the Qty was mistyped" apart from "the Subtotal was mistyped", even though both break the same equation.
7. **Extras.** It also checks `Total` rows against `SUM` of the rows above, and finds text dependencies (every Customer has exactly one State) along with their violations.

## Verified

- `npm test`: 14 tests pass. They cover:
  - Number and CSV parsing.
  - Typo diagnosis.
  - **Each sample recovers exactly the planted formulas, with exactly the planted typos and no false positives.** This includes the exact tax-rate and price tables and the 1.5 overtime coefficient.
  - Random independent columns produce **zero** formulas (checked across 5 seeds).
  - A fuzz test of 12 random hidden formulas: each one is recovered and regenerates its column exactly.
  - Cell references in the living-CSV export.
  - Live recompute propagation.
  - Error messages.
- Checked by hand in the browser: all three samples, live editing (changing a Qty recalculated its 4 dependents), and the layout at desktop and phone width.
- Performance: the samples analyse in under 100 ms. A 3,000-row × 15-column sheet takes about 3 s.

## Limitations (honest)

- Only finds formulas built from **up to 3 terms** (4 if they're all plain columns) out of: columns, pairwise products and ratios, the previous row, one lookup, or one rate table. It won't find `IF`/piecewise logic (such as overtime only above 40 h), dates, string formulas, cross-sheet references, or formulas with more than two nested operations.
- A formula needs to hold exactly on at least 80% of rows, and there must be at least 6 rows. Data with measurement noise isn't "baked" and correctly yields nothing.
- If A and B are tied by an exact relation, Unbake may report it the other way round (e.g. `e = ratio × (1 + f)` instead of `ratio = e ÷ (1 + f)`) when the true direction needs a term outside its library.
- Integer columns with a small range don't get `ROUND` hypotheses, because rounding to ±0.5 there would make coincidences too easy.
- Analysis runs on the main thread. Very wide sheets (more than 20 numeric columns) get slow because the product and ratio library grows quadratically.
- The blame solver repairs one cell at a time. Two typos in the same row that interact can end up listed as "no single-cell fix".

## Files

```
index.html         UI (open directly, or serve)
src/engine.js      the whole discovery + blame engine (browser + Node)
src/app.js         rendering, live recalculation, exports
src/samples.js     generated demo data with planted typos and ground truth
cli.js             command-line front end
test/              node:test suite
```
