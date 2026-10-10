# unbake

**Formula archaeology for spreadsheets.**

When a spreadsheet gets exported to CSV or a values-only Excel file (or a billing system, bank, or payroll tool hands you one), every formula is replaced by the number it happened to produce. Unbake works backwards from those numbers. It figures out the formulas that must have made them, then uses those formulas to find the cells someone typed wrong and to say what kind of mistake it was.

```
Subtotal = Qty × Unit Price                         34/36 rows exact
Tax      = round(Net × rate(State), 2)              CA → 7.25%  TX → 6.25%  NY → 4%  …
Balance  = Deposit − Withdrawal + ↑Balance          (running total)

row 8   Unit Price  $239.95 → $329.95   Two digits swapped (32 → 23). Repairs 2 broken calculations at once.
row 31  Total     $2,870.40 → $287.04   Decimal point slipped (×10).
```

Unbake makes no AI calls and needs no server. It's plain JavaScript running in your browser; the only third-party code is SheetJS, vendored for reading Excel files.

## Run it

```bash
python3 -m http.server 8737
```

Open http://localhost:8737 and click one of the three sample "dead exports", or drop in a CSV, `.xlsx`, `.xls` or `.ods` file of your own. Opening `index.html` straight from disk also works (analysis then runs on the main thread, because browsers block Web Workers on `file://`).

Things to try:
1. Read the **Recovered formulas**. The tax rates, prices, the 1.5× overtime multiplier and the running balance all come out of the data. Nothing was hand-written.
2. In **Suspect cells**, click an entry to jump to the red cell. "Root cause" means a single typo knocked out more than one calculation.
3. Switch the table to **Alive again**. The formulas are live, the typos are fixed, and every white cell can be edited. Change a quantity and watch everything downstream recalculate.
4. **Download living spreadsheet**. You get a CSV whose derived cells are real formulas (`=ROUND(H2*I2,2)`, `SWITCH(...)` lookups, `=SUM(D2:D53)`). Open it in Excel, Google Sheets or LibreOffice and it calculates again.

Command line:

```bash
node cli.js --sample invoices          # or ledger / payroll
node cli.js your.csv --living out.csv  # writes the formula-restored spreadsheet
npm test                               # 16 tests, node:test, no deps
```

## How it works (`src/engine.js`)

1. **Parsing.** CSV with delimiter detection (`, ; tab |`), or Excel/ODS via SheetJS (the largest sheet is picked; you can switch sheets). Numbers can come as `$1,234.50`, `(12.00)`, `7.25%`, `-€3`, `1.234,56 €`, `1 234,5`, `1'234.50`, `USD 12` or `150-`. Each column decides on its own whether it uses a decimal comma, from its unambiguous cells. Each column's printed precision is recorded, because that precision decides how close a formula has to land to count as exact.
2. **Hypothesis library.** For each numeric column Unbake builds candidate terms: the constant 1, every other column X, every product X·Y, every ratio X÷Y, and the column's own value in the previous row (which covers running totals and sequences).
3. **Robust search.** Combinations of 1–4 terms are fitted with **RANSAC**: solve exactly from a minimal random set of rows, then count how many other rows agree. A few typos can't pull the fit off course. Survivors are refit by least squares on their inliers. Each coefficient is then **snapped** to the simplest number (fewest decimals, then small fractions) that loses no inliers. That is how `0.0824999…` becomes `0.0825` and `1.4999…` becomes `1.5`. It also detects whether the column was `ROUND`ed.
4. **Lookups and rate tables.** A column might be a function of a text key (`Unit Price = lookup(SKU)`), or a numeric column times a per-key rate (`Tax = Net × rate(State)`).
5. **Occam within noise.** Among candidates that explain nearly as many rows as the best one, the simplest wins. Spreadsheets compute left-to-right, so each column is first explained from columns to its left. Columns still unexplained after that may use any column that doesn't depend on them, so the result is always a DAG.
6. **Blame solver.** Every row that breaks a formula is a symptom. For each cell those broken rows touch, Unbake solves for the value that would repair them. It throws out any candidate that would break a formula that currently holds. It ranks what's left by how many breaks it repairs, plus how much the correction looks like a human slip: swapped adjacent digits, slipped decimal point, one wrong digit, a dropped or extra digit, a flipped sign. This is how it tells "the Qty was mistyped" apart from "the Subtotal was mistyped", even though both break the same equation.
7. **Extras.** It also checks `Total` rows against `SUM` of the rows above, and finds text dependencies (every Customer has exactly one State) along with their violations.

## Verified

- `npm test`: 16 tests pass. They cover:
  - Number and CSV parsing.
  - Typo diagnosis.
  - **Each sample recovers exactly the planted formulas, with exactly the planted typos and no false positives.** This includes the exact tax-rate and price tables and the 1.5 overtime coefficient.
  - Random independent columns produce **zero** formulas (checked across 5 seeds).
  - A fuzz test of 12 random hidden formulas: each one is recovered and regenerates its column exactly.
  - Cell references in the living-CSV export.
  - Live recompute propagation.
  - Error messages.
  - European formats (a semicolon-delimited German invoice with 19% VAT).
  - Results surviving the Web Worker boundary (structured clone and re-hydrate).
- Checked by hand in the browser: all three samples, live editing (changing a Qty recalculated its 4 dependents), the layout at desktop and phone width, an `.xlsx` workbook with sheet switching, the German CSV with live editing in German number formatting, the Web Worker with progress bar, and the main-thread fallback.
- Performance: the samples analyse in under 100 ms. A 3,000-row × 15-column sheet takes about 3 s in a Web Worker, and the page stays responsive throughout.

## Limitations (honest)

- Only finds formulas built from **up to 3 terms** (4 if they're all plain columns) out of: columns, pairwise products and ratios, the previous row, one lookup, or one rate table. It won't find `IF`/piecewise logic (such as overtime only above 40 h), dates, string formulas, cross-sheet references, or formulas with more than two nested operations.
- A formula needs to hold exactly on at least 80% of rows, and there must be at least 6 rows. Data with measurement noise isn't "baked" and correctly yields nothing.
- If A and B are tied by an exact relation, Unbake may report it the other way round (e.g. `e = ratio × (1 + f)` instead of `ratio = e ÷ (1 + f)`) when the true direction needs a term outside its library.
- Integer columns with a small range don't get `ROUND` hypotheses, because rounding to ±0.5 there would make coincidences too easy.
- Very wide sheets (more than 20 numeric columns) get slow because the product and ratio library grows quadratically. The page stays responsive, but you wait.
- The living-CSV export always uses a comma delimiter and dot decimals. Excel set to a European locale may mis-read it; Google Sheets and LibreOffice handle it.
- Excel files are read as displayed values; any formulas still inside are ignored (the app tells you how many there were).
- The blame solver repairs one cell at a time. Two typos in the same row that interact can end up listed as "no single-cell fix".

## Privacy

Your file never leaves the browser tab. There is no upload, no server processing, no analytics, no cookies and no AI service. You can check this in the browser's network tab, or download the page and run it offline.

## Deploy

It's a static site with no build step, deployed on Vercel. `vercel.json` adds security headers, including a Content-Security-Policy with `connect-src 'none'`: the browser itself blocks the page from sending any network request, so the privacy promise above is enforced, not just stated. Any other static host (GitHub Pages, Cloudflare Pages, Netlify) also works; publish the repository root.

```bash
vercel --prod
```

When you ship an update, bump the `?v=` version on the three `<script>` tags in `index.html`. The worker reads the same version, so browsers never mix a cached old engine with a new page.

## License

MIT, see [LICENSE](LICENSE). SheetJS in `vendor/` is Apache 2.0, see [vendor/xlsx.LICENSE](vendor/xlsx.LICENSE).

## Files

```
index.html         UI (open directly, or serve)
src/engine.js      the whole discovery + blame engine (browser + Node)
src/app.js         rendering, live recalculation, exports, icons
src/worker.js      runs the engine off the main thread
vendor/            SheetJS 0.20.3 for Excel/ODS input
src/samples.js     generated demo data with planted typos and ground truth
cli.js             command-line front end
test/              node:test suite
```
