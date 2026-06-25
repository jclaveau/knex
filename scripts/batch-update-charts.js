'use strict';

// Renders the batchUpdate benchmark numbers as committed SVG charts for the PR /
// report — log-log scaling curves where Mermaid can't (no legend, stroke styles,
// or log axes). One graph per dialect gathers all nine curves (exec ms + bound
// params + chunks × the three modes), plus a faceted exec-ms overview.
//
// No repo dependency: run it with vega/vega-lite supplied by npx, e.g.
//   npx --yes -p vega@5 -p vega-lite@5 node scripts/batch-update-charts.js \
//     scripts/bench-charts/data.json scripts/bench-charts
//
// Input JSON: an array of { dialect, results: [ { rowCount, colCount, mode, ms,
// params, chunks, sqlBytes } ] } — concatenate each dialect's `batch-update-bench-json`
// block (from the benchmark output / CI logs) into one array.

const fs = require('fs');
const path = require('path');
const vegaLite = require('vega-lite');
const vega = require('vega');

const MODE_ORDER = ['union', 'case', 'json'];

function loadRecords(dataPath) {
  const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const records = [];
  for (const { dialect, results } of raw) {
    for (const r of results) {
      if (r.ms == null) continue; // skip ERR cells
      records.push({
        dialect,
        rows: r.rowCount,
        cols: r.colCount,
        mode: r.mode,
        ms: r.ms,
        params: r.params,
        sqlBytes: r.sqlBytes,
      });
    }
  }
  return records;
}

// One graph per dialect gathering every curve: exec ms, bound params and chunk
// count for all three modes (9 curves). color = mode, stroke-dash + point shape =
// metric, on a shared log y-axis (all three are "lower is better"). `detail`
// keeps each (mode, metric) a separate line.
function dialectSpec({ dialect, values }) {
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: `${dialect} — batchUpdate cost vs rows (cols=3, log-log)`,
    width: 520,
    height: 340,
    background: 'white',
    data: { values },
    mark: { type: 'line', point: { size: 70, filled: true }, strokeWidth: 2 },
    encoding: {
      x: {
        field: 'rows',
        type: 'quantitative',
        scale: { type: 'log' },
        title: 'rows (log)',
      },
      y: {
        field: 'value',
        type: 'quantitative',
        scale: { type: 'log' },
        title: 'exec ms / bound params / chunks (log)',
      },
      color: {
        field: 'mode',
        type: 'nominal',
        sort: MODE_ORDER,
        title: 'mode',
      },
      strokeDash: { field: 'metric', type: 'nominal', title: 'metric' },
      shape: { field: 'metric', type: 'nominal', title: 'metric' },
      detail: { field: 'metric', type: 'nominal' },
    },
  };
}

// Long-form rows for the combined chart: one record per (mode, metric, rows).
function toLongForm(records) {
  const long = [];
  for (const r of records) {
    long.push({ rows: r.rows, mode: r.mode, metric: 'exec ms', value: r.ms });
    long.push({
      rows: r.rows,
      mode: r.mode,
      metric: 'bound params',
      value: r.params,
    });
    long.push({
      rows: r.rows,
      mode: r.mode,
      metric: 'chunks',
      value: r.chunks,
    });
  }
  return long;
}

async function toSvg(vlSpec) {
  const { spec } = vegaLite.compile(vlSpec);
  const view = new vega.View(vega.parse(spec), { renderer: 'none' });
  return view.toSVG();
}

async function main() {
  const dataPath = process.argv[2] || 'scripts/bench-charts/data.json';
  const outDir = process.argv[3] || path.dirname(dataPath);
  fs.mkdirSync(outDir, { recursive: true });
  const records = loadRecords(dataPath);
  const sweep = records.filter((r) => r.cols === 3); // the row-count sweep
  const dialects = [...new Set(sweep.map((r) => r.dialect))];

  for (const dialect of dialects) {
    const values = toLongForm(sweep.filter((r) => r.dialect === dialect));
    const svg = await toSvg(dialectSpec({ dialect, values }));
    const file = path.join(outDir, `${dialect}.svg`);
    fs.writeFileSync(file, svg);
    console.log(`wrote ${file}`);
  }

  // Faceted overview: exec ms vs rows, one panel per dialect.
  const overview = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title: 'batchUpdate — exec ms vs rows by dialect (cols=3, log-log)',
    background: 'white',
    data: { values: sweep },
    columns: 3,
    facet: { field: 'dialect', type: 'nominal', title: null },
    spec: {
      width: 260,
      height: 190,
      mark: { type: 'line', point: { size: 45, filled: true }, strokeWidth: 2 },
      encoding: {
        x: {
          field: 'rows',
          type: 'quantitative',
          scale: { type: 'log' },
          title: 'rows (log)',
        },
        y: {
          field: 'ms',
          type: 'quantitative',
          scale: { type: 'log' },
          title: 'exec ms (log)',
        },
        color: { field: 'mode', type: 'nominal', sort: MODE_ORDER },
        strokeDash: { field: 'mode', type: 'nominal', sort: MODE_ORDER },
        shape: { field: 'mode', type: 'nominal', sort: MODE_ORDER },
      },
    },
  };
  const overviewSvg = await toSvg(overview);
  const overviewFile = path.join(outDir, 'overview-ms.svg');
  fs.writeFileSync(overviewFile, overviewSvg);
  console.log(`wrote ${overviewFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
