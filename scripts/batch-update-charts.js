'use strict';

// Renders the batchUpdate benchmark numbers as committed SVG charts for the PR /
// report — log-log scaling curves where Mermaid can't (no legend, stroke styles,
// or log axes). A cross-dialect summary (3 curves, one per mode, exec ms
// geomean-normalized to each dialect's union baseline), one chart per mode (exec
// ms, a curve per dialect), one graph per dialect gathering all nine curves (exec
// ms + bound params + chunks × the three modes), plus a faceted exec-ms overview.
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
// Point shapes are pinned per metric: exec ms = square, bound params = circle,
// chunks = triangle (see the shape scale in dialectSpec).
const METRIC_ORDER = ['exec ms', 'bound params', 'chunks'];

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
        chunks: r.chunks,
        sqlBytes: r.sqlBytes,
      });
    }
  }
  return records;
}

// One graph per dialect gathering every curve: exec ms, bound params and chunk
// count for all three modes (9 curves). color = mode, point shape = metric, on a
// shared log y-axis (all three are "lower is better"). `detail` keeps each
// (mode, metric) a separate line.
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
      shape: {
        field: 'metric',
        type: 'nominal',
        sort: METRIC_ORDER,
        scale: {
          domain: METRIC_ORDER,
          range: ['square', 'circle', 'triangle-up'],
        },
        title: 'metric',
      },
      detail: { field: 'metric', type: 'nominal' },
    },
  };
}

// Aggregate across dialects into one curve per mode. Absolute exec ms can't be
// averaged across dialects — they live on different scales (embedded SQLite vs a
// networked Oracle/CockroachDB), so an arithmetic mean of ms just tracks the
// slowest dialect and buries the mode effect. Instead normalize each mode to that
// dialect's own union baseline (same rows), then take the GEOMETRIC mean of the
// ratios: the correct central tendency for normalized/multiplicative numbers
// (Fleming–Wallace) and reference-direction invariant, unlike the arithmetic mean
// of ratios. A geometric stdev factor gives the spread band — one mode that wins
// big on one dialect and ties elsewhere shows as a wide band, not a misleading
// single line. union is 1.0 by construction (its own baseline).
function aggregateByMode(sweep) {
  const ms = new Map();
  for (const r of sweep) ms.set(`${r.dialect}|${r.rows}|${r.mode}`, r.ms);
  const rowCounts = [...new Set(sweep.map((r) => r.rows))].sort(
    (a, b) => a - b
  );
  const dialects = [...new Set(sweep.map((r) => r.dialect))];
  const out = [];
  for (const mode of MODE_ORDER) {
    for (const rows of rowCounts) {
      const logRatios = [];
      for (const dialect of dialects) {
        const baseline = ms.get(`${dialect}|${rows}|union`);
        const value = ms.get(`${dialect}|${rows}|${mode}`);
        // Need both this mode and its union baseline for the same dialect+rows;
        // skip the dialect at this row count otherwise (e.g. union ERR'd).
        if (baseline > 0 && value > 0)
          logRatios.push(Math.log(value / baseline));
      }
      if (logRatios.length === 0) continue;
      const meanLog = logRatios.reduce((a, b) => a + b, 0) / logRatios.length;
      const geomean = Math.exp(meanLog);
      const varLog =
        logRatios.reduce((a, b) => a + (b - meanLog) ** 2, 0) /
        logRatios.length;
      const gsd = Math.exp(Math.sqrt(varLog)); // geometric stdev factor
      out.push({
        rows,
        mode,
        ratio: geomean,
        lo: geomean / gsd,
        hi: geomean * gsd,
        dialects: logRatios.length,
      });
    }
  }
  return out;
}

// The cross-dialect summary chart: 3 curves (one per mode), exec ms normalized to
// each dialect's union baseline and geomean-aggregated, with the geometric-stdev
// band shaded. The dashed rule at 1.0 is union (the baseline); below it = faster.
function aggregateSpec(values) {
  const x = {
    field: 'rows',
    type: 'quantitative',
    scale: { type: 'log' },
    title: 'rows (log)',
  };
  const color = {
    field: 'mode',
    type: 'nominal',
    sort: MODE_ORDER,
    title: 'mode',
  };
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title:
      'batchUpdate exec time vs union baseline — geomean across dialects (1.0 = union, lower = faster)',
    width: 520,
    height: 340,
    background: 'white',
    data: { values },
    layer: [
      {
        mark: { type: 'errorband', opacity: 0.15 },
        encoding: {
          x,
          y: {
            field: 'lo',
            type: 'quantitative',
            scale: { type: 'log' },
            title: 'exec ms ÷ union (geomean, log)',
          },
          y2: { field: 'hi' },
          color,
        },
      },
      {
        mark: {
          type: 'line',
          point: { size: 70, filled: true },
          strokeWidth: 2,
        },
        encoding: {
          x,
          y: { field: 'ratio', type: 'quantitative', scale: { type: 'log' } },
          color,
        },
      },
      {
        mark: { type: 'rule', strokeDash: [4, 4], color: '#888' },
        encoding: { y: { datum: 1, type: 'quantitative' } },
      },
    ],
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

  // Cross-dialect summary: one curve per mode, geomean-normalized to union.
  const aggregate = aggregateByMode(sweep);
  const aggregateSvg = await toSvg(aggregateSpec(aggregate));
  const aggregateFile = path.join(outDir, 'mode-aggregate-ms.svg');
  fs.writeFileSync(aggregateFile, aggregateSvg);
  console.log(`wrote ${aggregateFile}`);

  // One chart per mode: exec ms vs rows, a curve per dialect (colour = dialect).
  for (const mode of MODE_ORDER) {
    const values = sweep.filter((r) => r.mode === mode);
    const svg = await toSvg({
      $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
      title: `batchUpdate '${mode}' — exec ms vs rows by dialect (cols=3, log-log)`,
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
          field: 'ms',
          type: 'quantitative',
          scale: { type: 'log' },
          title: 'exec ms (log)',
        },
        color: { field: 'dialect', type: 'nominal', title: 'dialect' },
        detail: { field: 'dialect', type: 'nominal' },
      },
    });
    const file = path.join(outDir, `mode-${mode}-ms.svg`);
    fs.writeFileSync(file, svg);
    console.log(`wrote ${file}`);
  }

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
