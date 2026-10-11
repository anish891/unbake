/* Unbake UI: renders what the engine discovers. No logic here invents results. */
(function () {
  'use strict';
  const U = window.Unbake, W = window.UnbakeWorkbook, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ROW_LIMIT = 400;

  // Inline SVG icons (stroke style, 24x24 grid). No emoji, no icon font, no network.
  const ICONS = {
    receipt: '<path d="M5 3v18l2.3-1.5L9.7 21l2.3-1.5 2.3 1.5 2.4-1.5L19 21V3l-2.3 1.5L14.3 3 12 4.5 9.7 3 7.3 4.5Z"/><path d="M9 9h6M9 13h6M9 17h3"/>',
    landmark: '<path d="M3 21h18M5 21v-9M9.7 21v-9M14.3 21v-9M19 21v-9M2.5 9.5 12 3l9.5 6.5Z"/>',
    briefcase: '<rect x="2.5" y="7" width="19" height="13.5" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M2.5 13h19"/>',
    sheet: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8Z"/><path d="M14 2.5V8h5.5M8 12.5h8M8 16.5h8M12 12.5v6"/>',
    upload: '<path d="M12 15V3.5M7 8.5l5-5 5 5M4 15v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V15"/>',
    download: '<path d="M12 3.5V15M7 10l5 5 5-5M4 19.5h16"/>',
    clipboard: '<rect x="8" y="2.5" width="8" height="4" rx="1"/><path d="M16 4.5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h2"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19.5 7"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    flask: '<path d="M9 3h6M10 3v6.5L4.6 18.8A1.5 1.5 0 0 0 5.9 21h12.2a1.5 1.5 0 0 0 1.3-2.2L14 9.5V3M7.5 15h9"/>',
    shield: '<path d="M12 21.5s7.5-3.5 7.5-9.5V5.5L12 2.5 4.5 5.5V12c0 6 7.5 9.5 7.5 9.5Z"/><path d="M9 12l2 2 4-4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.5-4.5"/>',
    lock: '<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
    sigma: '<path d="M17.5 7V4h-11l6 8-6 8h11v-3"/>',
    alert: '<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  };
  const ic = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  document.querySelectorAll('i[data-ic]').forEach((el) => { el.outerHTML = ic(el.dataset.ic, el.dataset.cls); });

  let R = null, fileName = 'sheet', mode = 'audit', overrides = {}, live = null, showAll = false;

  // ------------------------------------------------------------ landing
  const samples = window.UnbakeSamples.all();
  $('samples').innerHTML = samples.map((s) => `
    <button class="sample" data-id="${s.id}">
      ${ic(s.icon, 'big')}<div class="t">${esc(s.title)}</div><div class="d">${esc(s.blurb)}</div>
      <div class="go">Unbake it ${ic('arrowRight')}</div>
    </button>`).join('');
  $('samples').addEventListener('click', (e) => {
    const b = e.target.closest('.sample'); if (!b) return;
    const s = samples.find((x) => x.id === b.dataset.id);
    run(s.csv, s.id);
  });
  $('pick').onclick = () => $('file').click();
  $('file').onchange = (e) => e.target.files[0] && readFile(e.target.files[0]);
  $('pasteBtn').onclick = () => { $('paste').style.display = 'block'; $('pasteText').focus(); };
  $('pasteGo').onclick = () => run($('pasteText').value, 'pasted');
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });
  $('back').onclick = $('home').onclick = () => { $('results').style.display = 'none'; $('landing').style.display = 'block'; history.replaceState(null, '', location.pathname); window.scrollTo(0, 0); };

  const SHEET_EXT = /\.(xlsx|xlsm|xlsb|xls|ods|numbers)$/i;
  let sheets = null, sheetIdx = 0, workbookNote = '';

  function readFile(f) {
    if (f.size > 25e6) return showErr('That file is over 25 MB. Unbake is built for spreadsheet sized data, so try exporting just the sheet you care about.');
    const r = new FileReader();
    const base = f.name.replace(/\.[^.]+$/, '');
    r.onerror = () => showErr('Could not read that file.');
    if (SHEET_EXT.test(f.name)) {
      r.onload = () => loadSheetJS().then(() => openWorkbook(r.result, base)).catch((e) => showErr(e.message || String(e)));
      r.readAsArrayBuffer(f);
    } else {
      sheets = null;
      r.onload = () => run(r.result, base);
      r.readAsText(f);
    }
  }

  // SheetJS (Apache-2.0, vendored) is only fetched when someone opens a workbook.
  let sheetJS = null;
  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve();
    return sheetJS || (sheetJS = new Promise((ok, fail) => {
      const el = document.createElement('script');
      el.src = 'vendor/xlsx.full.min.js?v=0.20.3';
      el.onload = ok;
      el.onerror = () => { sheetJS = null; fail(new Error('Could not load the Excel reader (vendor/xlsx.full.min.js).')); };
      document.head.appendChild(el);
    }));
  }

  function openWorkbook(buf, base) {
    let wb;
    try { wb = XLSX.read(buf, { type: 'array', cellFormula: true }); }
    catch (e) { return showErr('That workbook could not be read: ' + (e.message || e)); }
    let formulaCells = 0;
    sheets = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const table = W.sheetTable(XLSX, ws);
      if (!table) return null;
      const audit = W.auditSheet(XLSX, ws, table);
      formulaCells += audit.formulaCells;
      return { name, size: table.size, csv: table.csv, table, audit };
    }).filter(Boolean);
    if (!sheets.length) return showErr('That workbook has no sheets with data.');
    workbookNote = formulaCells
      ? `This workbook still contains ${formulaCells.toLocaleString()} live formula cell${formulaCells > 1 ? 's' : ''}. Unbake recovers formulas from the displayed values alone, then checks its answers against them.`
      : '';
    sheetIdx = sheets.reduce((best, x, i) => (x.size > sheets[best].size ? i : best), 0);
    fileName = base;
    run(sheets[sheetIdx].csv, base + (sheets.length > 1 ? ' · ' + sheets[sheetIdx].name : ''), true);
  }

  function showErr(m) { $('err').textContent = m; $('err').style.display = m ? 'block' : 'none'; }

  // Analysis runs in a Web Worker when the page is served over http(s); opened straight
  // from disk (file://) browsers refuse workers, so it falls back to the main thread.
  let worker = null;
  function analyzeAsync(text, onProgress) {
    return new Promise((resolve, reject) => {
      let w;
      // reuse the page's own ?v= so the worker loads the same engine build
      const v = (document.querySelector('script[src*="app.js"]').src.split('?')[1] || '');
      try { w = new Worker('src/worker.js' + (v ? '?' + v : '')); } catch (e) { w = null; }
      if (!w) {
        setTimeout(() => { try { resolve(U.analyze(text)); } catch (e) { reject(e); } }, 30);
        return;
      }
      if (worker) worker.terminate();
      worker = w;
      let started = false;
      w.onmessage = (e) => {
        started = true;
        const m = e.data;
        if (m.type === 'progress') onProgress(m.fraction, m.column);
        else { w.terminate(); worker = null; m.type === 'done' ? resolve(U.hydrate(m.result)) : reject(new Error(m.message)); }
      };
      w.onerror = (e) => {
        e.preventDefault(); w.terminate(); worker = null;
        if (started) return reject(new Error(e.message || 'Analysis failed.'));
        try { resolve(U.analyze(text)); } catch (err) { reject(err); }
      };
      w.postMessage({ text });
    });
  }

  function setProgress(f, label) {
    $('spin').style.display = 'block';
    $('bar').style.width = Math.round(f * 100) + '%';
    $('spinLabel').textContent = label ? 'Testing hypotheses for “' + label + '”…' : 'Reading the sheet…';
  }

  function run(text, name, keepSheets) {
    if (!keepSheets) sheets = null;
    showErr('');
    setProgress(0.02);
    document.querySelectorAll('#landing button, #results .sheetpick button').forEach((b) => (b.disabled = true));
    analyzeAsync(text, setProgress).then((result) => {
      R = result;
      fileName = name || 'sheet';
      overrides = {};
      for (const c of R.corrections) if (R.cols[c.col].formula === undefined) (overrides[c.col] = overrides[c.col] || {})[c.pos] = c.suggested;
      live = U.recompute(R, overrides);
      mode = 'audit'; showAll = false;
      render();
      if (samples.some((s) => s.id === name)) history.replaceState(null, '', '#' + name);
    }).catch((e) => {
      console.error(e);
      $('results').style.display = 'none'; $('landing').style.display = 'block';
      showErr(e.message || String(e));
    }).finally(() => {
      $('spin').style.display = 'none';
      document.querySelectorAll('button').forEach((b) => (b.disabled = false));
    });
  }

  // ------------------------------------------------------------ rendering helpers
  const colName = (c) => R.cols[c].name;
  const sheetInfo = () => (sheets && sheets[sheetIdx]) || null;
  // Row numbers as they appear in the user's own file (workbooks may start lower or skip blank rows).
  const rowLabel = (p) => { const s = sheetInfo(); return s ? s.table.sheetRows[R.dataIdx[p] + 1] + 1 : R.rowNum[p]; };
  // audit issues are keyed by body row (totals included); the table by data position
  const dataPos = (bodyIndex) => R.dataIdx.indexOf(bodyIndex);
  const bodyRowLabel = (ri) => { const s = sheetInfo(); return s ? s.table.sheetRows[ri + 1] + 1 : ri + 2; };
  const fileAudit = () => { const s = sheetInfo(); return s && s.audit && s.audit.columns.length ? s.audit : null; };
  function fmtNum(c, v) {
    const col = R.cols[c];
    if (!isFinite(v)) return '';
    if (col.pct) return U.fmt(v * 100, Math.max(0, col.decimals - 2)) + '%';
    if (col.style === undefined) {
      const raw = col.raw.filter(Boolean);
      const most = (re) => raw.filter((s) => re.test(s)).length > raw.length / 2;
      col.style = {
        sep: raw.some((s) => (col.decComma ? /\d[.\s\u00a0]\d{3}/ : /\d,\d{3}/).test(s)),
        pre: most(/^[-(]?\$/) ? '$' : most(/^[-(]?£/) ? '£' : most(/^[-(]?€/) ? '€' : most(/^[-(]?₹/) ? '₹' : '',
        post: most(/€\s*\)?$/) ? ' €' : '',
      };
    }
    const s = Math.abs(U.roundTo(v, col.decimals)).toLocaleString(col.decComma ? 'de-DE' : 'en-US', { minimumFractionDigits: col.decimals, maximumFractionDigits: col.decimals, useGrouping: col.style.sep });
    return (v < 0 ? '-' : '') + col.style.pre + s + col.style.post;
  }
  function tokensHTML(f) {
    return f.tokens.map((t) => t.t === 'col'
      ? `<span class="col${t.prev ? ' prev' : ''}" data-c="${t.c}" title="${t.prev ? 'value from the previous row' : 'column ' + R.cols[t.c].letter}">${t.prev ? ic('arrowUp') : ''}${esc(t.s)}</span>`
      : `<span class="${t.t}">${esc(t.s)}</span>`).join('');
  }

  function render() {
    $('landing').style.display = 'none';
    $('results').style.display = 'block';
    window.scrollTo(0, 0);
    const nf = R.formulas.length, nb = R.corrections.length + R.unexplained.length;
    const derivedCells = R.formulas.reduce((s, f) => s + f.evaluable, 0);
    $('headline').innerHTML = nf
      ? `Recovered <span class="n">${nf} formula${nf > 1 ? 's' : ''}</span> behind ${derivedCells.toLocaleString()} cells` +
        (nb ? `, plus <span class="bad">${nb} suspect cell${nb > 1 ? 's' : ''}</span> that break them.` : '. Every derived cell is consistent.')
      : 'No exact formulas found in this sheet.';
    $('headline').insertAdjacentHTML('beforeend', `<div class="meta">${R.n} rows × ${R.cols.length} columns · searched in ${R.stats.ms} ms · ${esc(fileName)}</div>`);
    if (sheets && sheets.length > 1) {
      $('headline').insertAdjacentHTML('beforeend', '<div class="sheetpick">' + sheets.map((sh, i) =>
        `<button class="btn${i === sheetIdx ? ' on' : ''}" data-i="${i}">${esc(sh.name)}</button>`).join('') + '</div>');
      $('headline').querySelectorAll('.sheetpick button').forEach((b) => b.onclick = () => {
        sheetIdx = +b.dataset.i;
        run(sheets[sheetIdx].csv, fileName.split(' · ')[0] + ' · ' + sheets[sheetIdx].name, true);
      });
    }
    if (sheets && workbookNote) $('headline').insertAdjacentHTML('beforeend', `<div class="meta">${esc(workbookNote)}</div>`);
    renderFormulas(); renderFileCheck(); renderFixes(); renderGraph(); renderTable();
  }

  function fileBadge(f) {
    const a = fileAudit();
    const colAudit = a && a.columns.find((c) => c.col === f.target);
    const cmp = colAudit && W.compareFormula(f, f.lag ? 1 : 0, R, colAudit);
    if (!cmp) return '';
    return cmp.same
      ? `<span class="pill" title="The file's own formula in this column is ${esc(cmp.fileFormula)}">${ic('check')} same as the file's formula</span>`
      : `<span class="pill neutral" title="Both reproduce the values; they are written differently">file writes it as ${esc(cmp.fileFormula)}</span>`;
  }

  function renderFileCheck() {
    const a = fileAudit(), box = $('filecheck');
    if (!a) { box.innerHTML = ''; return; }
    const cols = a.columns.map((c) => {
      const f = R.cols[c.col] && R.cols[c.col].formula !== undefined ? R.formulas[R.cols[c.col].formula] : null;
      const cmp = f && W.compareFormula(f, f.lag ? 1 : 0, R, c);
      const verdict = !f ? 'Unbake found no formula for this column'
        : cmp.same ? ic('check', 'ok-ic') + ' Unbake recovered the same formula from the values alone'
        : 'Unbake recovered an equivalent formula written differently';
      return `<div>${esc(R.cols[c.col] ? R.cols[c.col].name : 'Column ' + c.col)}: <code>${esc(c.example)}</code> in ${c.count} of ${c.cells} cells. ${verdict}.</div>`;
    }).join('');
    const issues = a.issues.map((iss, i) => `<div class="fix hardfix" data-h="${i}">
        <div class="where">row ${iss.sheetRow}</div>
        <div class="what"><b>${esc(colName(iss.col))}</b> ${iss.kind === 'hardcoded'
          ? `holds the typed number <s>${esc(String(iss.value))}</s> instead of <code>${esc(iss.expected)}</code>`
          : `uses <s>${esc(iss.formula)}</s> instead of <code>${esc(iss.expected)}</code>`}</div>
        <div class="why">${iss.kind === 'hardcoded'
          ? 'Someone typed over the formula, so this cell no longer updates when its inputs change.'
          : 'This cell breaks the pattern of every other formula in the column.'}</div></div>`).join('');
    box.innerHTML = '<h2 style="margin-top:16px">Formulas inside the file</h2><div class="extra">' + cols + '</div>' +
      (issues ? '<div style="margin-top:10px">' + issues + '</div>' : '<div class="empty">Every formula cell follows its column\u2019s pattern, and no formula was typed over.</div>');
    box.querySelectorAll('.hardfix').forEach((el) => el.onclick = () => { const iss = a.issues[+el.dataset.h]; if (dataPos(iss.bodyIndex) >= 0) focusCell(dataPos(iss.bodyIndex), iss.col); });
  }

  function renderFormulas() {
    const box = $('formulas');
    if (!R.formulas.length) {
      box.innerHTML = '<div class="empty">Every numeric column looks independent: no column can be reproduced exactly from the others on 80%+ of rows. That is a real answer: either this data was typed by hand, or its formulas use inputs that aren’t in the file.</div>';
    } else box.innerHTML = R.formulas.map((f) => {
      const bad = f.anomalies.length;
      let map = '';
      if (f.kind === 'lookup' || f.kind === 'rate') {
        const entries = [...f.map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        map = '<div class="maptbl">' + entries.slice(0, 24).map(([k, v]) => `<span>${esc(k)} ${ic('arrowRight')} <b>${f.kind === 'rate' ? +(v * 100).toPrecision(6) + '%' : esc(U.numStr(v))}</b></span>`).join('') + (entries.length > 24 ? `<span>+${entries.length - 24} more</span>` : '') + '</div>';
      }
      const firstRow = f.lag ? 1 : 0;
      return `<div class="formula" data-f="${f.id}">
        <div class="fx"><span class="tg">${esc(colName(f.target))}</span> <span class="op">=</span> ${tokensHTML(f)}</div>
        ${map}
        <div class="fmeta"><span class="xl" title="as a spreadsheet formula">${esc(R.cols[f.target].letter + R.rowNum[firstRow])} ${esc(f.excelAt(firstRow))}</span>
          <span class="pill${bad ? ' warn' : ''}">${f.inliers}/${f.evaluable} rows exact${bad ? ' · ' + bad + ' break' : ''}</span>
          ${f.mode === 'round' ? '<span>rounded to ' + R.cols[f.target].decimals + ' dp</span>' : ''}${fileBadge(f)}</div>
      </div>`;
    }).join('');
    // staggered reveal
    [...box.querySelectorAll('.formula')].forEach((el, i) => setTimeout(() => el.classList.add('in'), 90 * i + 40));
    box.querySelectorAll('.formula').forEach((el) => {
      const f = R.formulas[+el.dataset.f];
      el.onmouseenter = () => highlight(f);
      el.onmouseleave = () => highlight(null);
    });
    const ex = [];
    for (const s of R.summaries) ex.push(s.ok
      ? `<div>${ic('check', 'ok-ic')} Row ${bodyRowLabel(s.rowIndex)} <b>${esc(colName(s.col))}</b> is <code>${esc(s.excel)}</code></div>`
      : `<div>${ic('x', 'bad-ic')} Row ${bodyRowLabel(s.rowIndex)} <b>${esc(colName(s.col))}</b> claims ${fmtNum(s.col, s.typed)} but the rows above sum to ${fmtNum(s.col, s.sum)}</div>`);
    for (const fd of R.fds.slice(0, 6)) ex.push(`<div>Every <b>${esc(colName(fd.from))}</b> has exactly one <b>${esc(colName(fd.to))}</b>` +
      (fd.violations.length ? `, <span style="color:var(--warn)">except ${fd.violations.slice(0, 3).map((v) => 'row ' + rowLabel(v.pos) + ' (“' + esc(v.typed) + '”, expected “' + esc(v.expected) + '”)').join(', ')}</span>` : '') + '</div>');
    $('extra').innerHTML = ex.length ? '<h2 style="margin-top:16px">Also noticed</h2>' + ex.join('') : '';
  }

  function renderFixes() {
    const box = $('fixes');
    if (!R.corrections.length && !R.unexplained.length) {
      box.innerHTML = R.formulas.length ? '<div class="empty">None. Every derived cell matches its formula exactly.</div>' : '<div class="empty">Nothing to check without formulas.</div>';
      return;
    }
    box.innerHTML = R.corrections.map((c, i) => {
      const fixes = c.fixes.map((id) => colName(R.formulas[id].target));
      const typed = c.typed === null ? '(blank)' : fmtNum(c.col, c.typed);
      const isInput = R.cols[c.col].formula === undefined;
      const because = c.fixCount > 1
        ? `Repairs <b>${c.fixCount} broken calculations</b> at once (${esc(fixes.join(', '))})`
        : isInput ? `Explains why <b>${esc(fixes[0])}</b> doesn’t add up on this row` : `Doesn’t match its own formula`;
      return `<div class="fix" data-i="${i}">
        <div class="where">row ${rowLabel(c.pos)}</div>
        <div class="what"><b>${esc(colName(c.col))}</b> &nbsp;<s>${esc(typed)}</s> ${ic('arrowRight')} <ins>${esc(fmtNum(c.col, c.suggested))}</ins>${c.fixCount > 1 ? '<span class="root">' + ic('alert') + ' root cause</span>' : ''}</div>
        <div class="why"><b>${esc(c.diagnosis.label[0].toUpperCase() + c.diagnosis.label.slice(1))}.</b> ${because}.${c.alternatives && c.alternatives.length ? `<br>Less likely: ${c.alternatives.map((a) => `${esc(colName(a.col))} should be ${esc(fmtNum(a.col, a.suggested))} (${esc(a.diagnosis.label)})`).join('; ')}.` : ''}</div>
      </div>`;
    }).join('') + R.unexplained.map((u) => `<div class="fix" data-u="${u.pos}:${u.col}">
        <div class="where">row ${rowLabel(u.pos)}</div>
        <div class="what"><b>${esc(colName(u.col))}</b> is ${esc(fmtNum(u.col, u.typed))}, formula says ${esc(fmtNum(u.col, u.expected))}</div>
        <div class="why">No single cell fix explains this one. It may be a manual override.</div></div>`).join('');
    box.querySelectorAll('.fix').forEach((el) => el.onclick = () => {
      if (el.dataset.i !== undefined) { const c = R.corrections[+el.dataset.i]; focusCell(c.pos, c.col); }
      else { const [p, c] = el.dataset.u.split(':').map(Number); focusCell(p, c); }
    });
  }

  function highlight(f) {
    document.querySelectorAll('th.hot, #graph .hot').forEach((el) => el.classList.remove('hot'));
    if (!f) return;
    for (const c of [f.target, ...f.inputs, ...(f.key !== undefined ? [f.key] : [])]) {
      const th = document.querySelector(`th[data-c="${c}"]`); if (th) th.classList.add('hot');
      const n = document.querySelector(`#graph .node[data-c="${c}"]`); if (n) n.classList.add('hot');
    }
    document.querySelectorAll(`#graph path[data-t="${f.target}"]`).forEach((p) => p.classList.add('hot'));
  }

  // ------------------------------------------------------------ dependency graph
  function renderGraph() {
    const fs = R.formulas;
    if (!fs.length) { $('graph').style.display = 'none'; return; }
    $('graph').style.display = '';
    const depth = new Map(), nodes = new Set();
    const parents = (f) => [...f.inputs, ...(f.key !== undefined ? [f.key] : [])];
    fs.forEach((f) => { nodes.add(f.target); parents(f).forEach((c) => nodes.add(c)); });
    const d = (c) => {
      if (depth.has(c)) return depth.get(c);
      const f = fs.find((x) => x.target === c);
      const v = f ? 1 + Math.max(-1, ...parents(f).map(d)) : 0;
      depth.set(c, v); return v;
    };
    [...nodes].forEach(d);
    const layers = [];
    [...nodes].sort((a, b) => a - b).forEach((c) => { (layers[depth.get(c)] = layers[depth.get(c)] || []).push(c); });
    const W = 150, H = 44, gx = 46, gy = 16;
    const pos = new Map();
    const maxRows = Math.max(...layers.map((l) => l.length));
    layers.forEach((l, i) => l.forEach((c, j) => pos.set(c, { x: 10 + i * (W + gx), y: 10 + (j + (maxRows - l.length) / 2) * (H + gy) })));
    const width = 20 + layers.length * (W + gx) - gx, height = 20 + maxRows * (H + gy) - gy;
    let edges = '', boxes = '';
    for (const f of fs) {
      const t = pos.get(f.target);
      for (const c of parents(f)) {
        const s = pos.get(c);
        const x1 = s.x + W, y1 = s.y + H / 2, x2 = t.x, y2 = t.y + H / 2, mx = (x1 + x2) / 2;
        edges += `<path data-t="${f.target}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 4},${y2}" marker-end="url(#ah)"/>`;
      }
      if (f.lag) edges += `<path data-t="${f.target}" d="M${t.x + W - 30},${t.y} c0,-14 26,-14 22,2" marker-end="url(#ah)"/>`;
    }
    for (const c of nodes) {
      const p = pos.get(c), col = R.cols[c], f = fs.find((x) => x.target === c);
      const label = col.name.length > 18 ? col.name.slice(0, 17) + '…' : col.name;
      const sub = f ? (f.kind === 'lookup' ? 'lookup' : f.kind === 'rate' ? 'rate table' : f.kind === 'if' ? 'if rule' : 'formula') : col.type === 'text' ? 'key' : 'input';
      boxes += `<g class="node ${f ? 'derived' : col.type === 'text' ? 'text' : ''}" data-c="${c}" transform="translate(${p.x},${p.y})">
        <rect width="${W}" height="${H}" rx="9"/><text x="12" y="19" font-weight="600">${esc(label)}</text>
        <text x="12" y="34" style="fill:var(--muted);font-size:11px">${col.letter} · ${sub}</text></g>`;
    }
    $('graphSvg').innerHTML = `<svg viewBox="0 0 ${width} ${height + 10}" style="width:${width}px;max-width:100%" role="img" aria-label="dependency graph">
      <defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--line2);stroke:none"/></marker></defs>
      ${edges}${boxes}</svg>`;
    $('graphSvg').querySelectorAll('.node').forEach((n) => {
      const f = fs.find((x) => x.target === +n.dataset.c);
      if (!f) return;
      n.onmouseenter = () => highlight(f); n.onmouseleave = () => highlight(null);
    });
  }

  // ------------------------------------------------------------ table
  function cellInfo() {
    const wrong = new Map(), ripple = new Map(), fdbad = new Map();
    for (const c of R.corrections) wrong.set(c.pos + ':' + c.col, c);
    for (const f of R.formulas) for (const p of f.anomalies) {
      const k = p + ':' + f.target;
      if (!wrong.has(k)) ripple.set(k, f);
    }
    for (const fd of R.fds) for (const v of fd.violations) fdbad.set(v.pos + ':' + fd.to, v);
    const hard = new Map();
    const a = fileAudit();
    if (a) for (const iss of a.issues) if (dataPos(iss.bodyIndex) >= 0) hard.set(dataPos(iss.bodyIndex) + ':' + iss.col, iss);
    return { wrong, ripple, fdbad, hard };
  }

  function renderTable() {
    const info = cellInfo();
    const cols = R.cols;
    const isDerived = (c) => cols[c].formula !== undefined;
    let h = '<table><thead><tr><th></th>' + cols.map((c) => `<th data-c="${c.index}"><span class="l">${c.letter}</span>${esc(c.name)}${c.formula !== undefined ? '<span class="f" title="recovered formula">' + ic('sigma') + '</span>' : ''}</th>`).join('') + '</tr></thead><tbody>';
    const limit = showAll ? R.n : Math.min(R.n, ROW_LIMIT);
    for (let p = 0; p < limit; p++) {
      h += `<tr><td class="rn">${rowLabel(p)}</td>`;
      for (const c of cols) {
        const k = p + ':' + c.index;
        if (c.type === 'text') {
          const bad = info.fdbad.get(k);
          h += `<td class="${bad ? 'fdbad' : ''}"${bad ? ` title="Every other row says “${esc(bad.expected)}” here"` : ''}>${esc(c.text[p])}</td>`;
          continue;
        }
        const cls = ['num'];
        let content, title = '';
        if (mode === 'audit') {
          content = esc(c.raw[p]);
          const w = info.wrong.get(k), r = info.ripple.get(k);
          if (w) { cls.push('wrong'); content += `<span class="sug">${ic('arrowRight')} ${esc(fmtNum(c.index, w.suggested))}</span>`; title = w.diagnosis.label; }
          else if (r) { cls.push('ripple'); title = `Doesn’t match the ${c.name} formula because of a typo elsewhere in this row`; }
          else if (isDerived(c.index)) cls.push('derived');
          const hd = info.hard.get(k);
          if (hd) { cls.push('hard'); title = (title ? title + '. ' : '') + (hd.kind === 'hardcoded' ? 'Typed number where the file expects ' + hd.expected : 'Formula ' + hd.formula + ' differs from the column\u2019s ' + hd.expected); }
        } else {
          const v = live.get(c.index)[p];
          const f = isDerived(c.index) ? R.formulas[c.formula] : null;
          const editable = !f || (f.lag && p === 0);
          content = c.blank[p] && !(overrides[c.index] && overrides[c.index][p] !== undefined) && !f ? '' : esc(fmtNum(c.index, v));
          if (editable) cls.push('edit');
          if (f && !(f.lag && p === 0)) { cls.push('derived'); title = f.excelAt(p); }
          if (overrides[c.index] && overrides[c.index][p] !== undefined) { cls.push('fixed'); title = 'was ' + c.raw[p]; }
          h += `<td class="${cls.join(' ')}" data-k="${k}"${editable ? ' contenteditable="true" spellcheck="false"' : ''}${title ? ` title="${esc(title)}"` : ''}>${content}</td>`;
          continue;
        }
        h += `<td class="${cls.join(' ')}" data-k="${k}"${title ? ` title="${esc(title)}"` : ''}>${content}</td>`;
      }
      h += '</tr>';
    }
    // summary rows
    for (const ri of R.summaryIdx) {
      h += `<tr class="sum"><td class="rn">${ri + 2}</td>`;
      for (const c of cols) {
        const s = R.summaries.find((x) => x.rowIndex === ri && x.col === c.index);
        let v = R.body[ri][c.index];
        if (s && mode === 'live' && s.ok) v = fmtNum(c.index, live.get(c.index).reduce((a, x) => a + x, 0));
        h += `<td class="${c.type === 'number' ? 'num' : ''} ${s ? (s.ok ? 'ok' : 'wrong') : ''}"${s ? ` title="${esc(s.ok ? s.excel : 'does not equal the sum of the rows above')}"` : ''}>${esc(v)}</td>`;
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    if (limit < R.n) h += `<div class="more"><button class="btn" id="showAll">Show all ${R.n.toLocaleString()} rows</button></div>`;
    $('tbl').innerHTML = h;
    if ($('showAll')) $('showAll').onclick = () => { showAll = true; renderTable(); };

    $('hint').innerHTML = mode === 'audit'
      ? 'Exactly as exported. Hover a red cell for the diagnosis; click a typo on the right to jump to it.'
      : 'The formulas are live again and the typos are repaired. <b>Edit any white input cell</b> and every cell that depends on it recalculates.';
    $('legend').innerHTML = mode === 'audit'
      ? (fileAudit() && fileAudit().issues.length ? '<span><i style="background:var(--hard-soft);outline:2px dashed var(--hard)"></i>formula typed over in the file</span>' : '') + '<span><i style="background:var(--derived)"></i>computed by a recovered formula</span><span><i style="background:var(--bad-soft);outline:2px solid var(--bad)"></i>suspect: breaks a formula (likely fix below)</span><span><i style="background:var(--warn-soft)"></i>inconsistent only because of a typo elsewhere</span>'
      : '<span><i style="background:var(--derived)"></i>live formula (hover for the spreadsheet syntax)</span><span><i style="background:var(--good-soft)"></i>repaired input</span><span><i style="background:var(--paper);outline:1px dashed var(--accent)"></i>editable input</span>';

    if (mode === 'live') wireEditing();
  }

  function wireEditing() {
    $('tbl').querySelectorAll('td.edit').forEach((td) => {
      td.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); td.blur(); } if (e.key === 'Escape') { td.textContent = td.dataset.prev; td.blur(); } });
      td.addEventListener('focus', () => { td.dataset.prev = td.textContent; });
      td.addEventListener('blur', () => {
        if (td.textContent === td.dataset.prev) return;
        const [p, c] = td.dataset.k.split(':').map(Number);
        const parsed = U.parseNumber(td.textContent, R.cols[c].decComma);
        if (!parsed) { td.textContent = td.dataset.prev; return; }
        (overrides[c] = overrides[c] || {})[p] = parsed.v;
        const before = live;
        live = U.recompute(R, overrides);
        renderTable();
        // flash every cell whose value changed
        let changed = 0;
        for (const [col, arr] of live) arr.forEach((v, q) => {
          if (Math.abs(v - before.get(col)[q]) > 1e-9) {
            const el = document.querySelector(`td[data-k="${q}:${col}"]`);
            if (el) { el.classList.add('flash'); changed++; }
          }
        });
        $('hint').innerHTML = `Changed ${esc(R.cols[c].name)} on row ${rowLabel(p)}: <b>${changed - 1} dependent cell${changed - 1 === 1 ? '' : 's'} recalculated</b>.`;
      });
    });
  }

  function focusCell(p, c) {
    if (p >= ROW_LIMIT && !showAll) { showAll = true; renderTable(); }
    if (mode !== 'audit') setMode('audit');
    const el = document.querySelector(`td[data-k="${p}:${c}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    el.classList.remove('focus'); void el.offsetWidth; el.classList.add('focus');
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    renderTable();
  }
  document.querySelectorAll('#mode button').forEach((b) => b.onclick = () => setMode(b.dataset.m));

  // ------------------------------------------------------------ exports
  function download(name, data, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: type || 'text/csv' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  $('dlLiving').onclick = () => download(fileName + '.living.csv', U.livingCSV(R));
  $('dlXlsx').onclick = () => {
    const btn = $('dlXlsx');
    btn.disabled = true;
    loadSheetJS().then(() => {
      const s = sheetInfo();
      const u8 = W.buildExport(XLSX, R, {
        engine: U, name: (s ? s.name : fileName.split(' · ')[0]) || 'Data',
        live: U.recompute(R, overrides), overrides, rowLabel, audit: s ? s.audit : null,
      });
      download(fileName.replace(/ · /g, ' ') + '.unbaked.xlsx', u8, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }).catch((e) => alert('Could not build the Excel file: ' + (e.message || e))).finally(() => { btn.disabled = false; });
  };
  $('dlFixed').onclick = () => {
    const vals = U.recompute(R, overrides);
    const rows = [R.header.slice()];
    const posOf = new Map(R.dataIdx.map((ri, p) => [ri, p]));
    R.body.forEach((r, ri) => {
      const out = r.slice();
      if (posOf.has(ri)) {
        const p = posOf.get(ri);
        for (const c of R.cols) if (c.type === 'number' && !(c.blank[p] && c.formula === undefined)) out[c.index] = U.fmt(vals.get(c.index)[p], c.decimals);
      }
      rows.push(out);
    });
    download(fileName + '.corrected.csv', U.toCSV(rows));
  };

  // deep link: index.html#invoices
  const h = location.hash.slice(1);
  if (h) { const s = samples.find((x) => x.id === h); if (s) run(s.csv, s.id); }
})();
