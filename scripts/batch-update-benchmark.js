'use strict';

// Benchmark for knex.batchUpdate's three strategies (mode: union | case | json).
// Produces the tradeoff data referenced in the RFC: generated-SQL size, bound
// parameter count, chunks needed under the dialect's parameter limit, and the
// wall-clock to apply the whole batch.
//
// Usage:
//   node scripts/batch-update-benchmark.js            # sqlite3, in-memory (all 3 modes)
//   DB=mysql node scripts/batch-update-benchmark.js   # any dialect, via the test
//                                                     # connection config (needs the
//                                                     # matching docker-compose service)
//
// The dialect comes from the DB env var (the same one the integration suite
// uses) and the connection from the shared test config, so every dialect runs
// against the same servers CI stands up. sqlite3 is the default — the one
// embedded dialect that needs no server.

const crypto = require('crypto');
const {
  getKnexForDb,
} = require('../test/integration2/util/knex-instance-provider');

const MODES = ['union', 'case', 'json'];

// Blob scenario: rows carry metadata columns plus one binary column, so the
// timings show binary handling per mode — union/case bind the Buffer natively,
// json auto-splits (json for the metadata + a companion union/per-row for the
// blob), and Oracle/pgnative take the per-row path.
const BLOB_MATRIX = [
  { rows: 100, metaColumns: 3, blobBytes: 1024 },
  { rows: 100, metaColumns: 3, blobBytes: 16384 },
  // Wide metadata + a small blob — json's split should win here: the bulk
  // metadata rides one json parameter (no per-row param explosion, no compound
  // SELECT / 2098-param chunking) while only the narrow blob takes the companion
  // union/per-row statement.
  { rows: 1000, metaColumns: 20, blobBytes: 1024 },
];

// The JSON_TABLE / OPENJSON dialects need an explicit type per column for json
// mode (they can't infer it); Postgres infers and SQLite is typeless, so they
// pass no map. The bench batch is one integer key plus string columns.
function jsonColumnTypesFor(knex, columns) {
  const stringType = {
    mysql: 'char(255)',
    mssql: 'nvarchar(255)',
    oracle: 'varchar2(255)',
  }[knex.client.dialect];
  if (!stringType) {
    return undefined;
  }
  const intType = knex.client.dialect === 'oracle' ? 'number' : 'int';
  const types = { id: intType };
  for (const column of columns) {
    types[column] = stringType;
  }
  return types;
}

// Pre-resolved cast types for union on the Postgres family, so the timed call
// uses cached types instead of inferring them per batch — the cast-detection a
// real caller resolves once and reuses stays out of the numbers. Mirrors the
// compiler's own inference for this batch (numeric key, text columns), so the
// emitted SQL is byte-identical; only the per-call inference walk drops out.
// Other dialects don't cast the union source, so they pass no map.
function unionCastTypesFor(knex, columns) {
  if (knex.client.dialect !== 'postgresql') {
    return undefined;
  }
  const types = { id: 'numeric' };
  for (const column of columns) {
    types[column] = 'text';
  }
  return types;
}

const MATRIX = [
  // Small tiers — the everyday case (updating a handful of rows) far outweighs
  // bulk imports, so the curves need points down here where per-statement
  // overhead, not chunking, dominates.
  { rows: 3, cols: 3 },
  { rows: 5, cols: 3 },
  { rows: 10, cols: 3 },
  { rows: 20, cols: 3 },
  { rows: 50, cols: 3 },
  { rows: 80, cols: 3 },
  { rows: 100, cols: 3 },
  { rows: 1000, cols: 3 },
  { rows: 1000, cols: 20 },
  { rows: 10000, cols: 3 },
  // Heavy tier to exercise the chunk loop where a per-statement cap bites:
  // ~100 chunks for union on SQLite (500-term cap) and MSSQL (2098 params / 4
  // per row). High-bind-limit dialects (65535) still take far more rows to chunk
  // union, so they show only a handful here — that's expected. cols stays at 3
  // so the case/json payloads don't balloon at this row count.
  { rows: 50000, cols: 3 },
];

function buildBatch(rowCount, colCount) {
  const columns = Array.from({ length: colCount }, (_, i) => `c${i}`);
  const rows = [];
  for (let id = 1; id <= rowCount; id++) {
    const row = { id };
    for (const column of columns) {
      row[column] = `${column}-${id}`;
    }
    rows.push(row);
  }
  return { columns, rows };
}

async function createTable(knex, columns) {
  await knex.schema.dropTableIfExists('bench');
  await knex.schema.createTable('bench', (table) => {
    table.integer('id').primary();
    for (const column of columns) {
      table.string(column);
    }
  });
}

// SQL size + parameter count for the whole batch compiled as a single statement
// (chunking disabled), so the numbers reflect each strategy's raw growth.
function measureStatement(knex, columns, rows, mode, columnTypes) {
  const compiled = knex('bench')
    .batchUpdate(
      rows,
      ['id'],
      columns,
      mode === 'json' ? columnTypes : undefined,
      mode
    )
    .toSQL();
  return { sqlBytes: compiled.sql.length, params: compiled.bindings.length };
}

function chunksNeeded(knex, columns, rows, mode) {
  const limit = knex.client.maxBindParameters || Infinity;
  if (mode === 'json') {
    return 1; // one parameter per chunk regardless of row count
  }
  const perRow =
    mode === 'case'
      ? columns.length * 2 + 1 // each column matches the row's key, plus the WHERE key
      : columns.length + 1; // union: one value per cell (key + columns)
  // Mirror the executor: the tighter of the bind-parameter cap and any
  // structural per-statement row cap (e.g. SQLite's compound-SELECT limit).
  const maxRows = Math.min(
    Math.max(1, Math.floor(limit / perRow)),
    knex.client.batchUpdateRowLimit(mode)
  );
  return Math.ceil(rows.length / maxRows);
}

async function timeExecution(knex, columns, rows, mode, columnTypes) {
  await createTable(knex, columns);
  // Size the seed insert to the dialect's bind limit (mssql caps at 2100), so
  // table setup never overflows before the batchUpdate under test runs.
  const limit = knex.client.maxBindParameters || Infinity;
  const insertChunk = Math.max(
    1,
    Math.min(500, Math.floor(limit / (columns.length + 1)))
  );
  await knex.batchInsert('bench', rows, insertChunk);
  const updated = rows.map((row) => {
    const next = { id: row.id };
    for (const column of columns) {
      next[column] = `${column}-updated-${row.id}`;
    }
    return next;
  });
  const options = columnTypes ? { mode, columnTypes } : { mode };
  const start = process.hrtime.bigint();
  await knex.batchUpdate('bench', updated, 'id', options);
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6; // ms
}

// Isolates the cost of the columnTypes strategies. 'from_db' adds one
// columnInfo round-trip per call; 'from_data' (the default) adds nothing.
// Run on the 'json' strategy because it accepts columnTypes on sqlite/pg.
async function benchColumnTypes(knex) {
  // from_data / from_db only apply where types are inferred (Postgres family) or
  // ignored (SQLite); the JSON_TABLE/OPENJSON dialects need an explicit map.
  if (jsonColumnTypesFor(knex, [])) {
    console.log(
      `\n## columnTypes strategy overhead — skipped on ${knex.client.dialect} (json needs an explicit map)\n`
    );
    return;
  }
  const { columns, rows } = buildBatch(1000, 5);
  console.log('\n## columnTypes strategy overhead (json, 1000×5)\n');
  console.log('| columnTypes | exec ms |');
  console.log('|---|---:|');
  for (const columnTypes of ['from_data', 'from_db']) {
    let ms;
    try {
      ms = (
        await timeExecution(knex, columns, rows, 'json', columnTypes)
      ).toFixed(1);
    } catch (error) {
      ms = `ERR: ${error.message.split(' - ').pop().slice(0, 50)}`;
    }
    console.log(`| ${columnTypes} | ${ms} |`);
  }
}

// Times each mode updating rows that carry a binary column. pgnative can't bind
// a Buffer to bytea (driver limit) so it's skipped; Redshift has no bytea and
// errors per cell. The json column types cover only the metadata (the blob rides
// the companion union/per-row statement, which needs no map).
async function benchBlobs(knex) {
  if (knex.client.driverName === 'pgnative') {
    console.log(
      "\n## blob updates — skipped on pgnative (driver can't bind bytea)\n"
    );
    return;
  }
  console.log('\n## blob updates (metadata cols + 1 blob)\n');
  console.log('| rows | meta cols | blob bytes | mode | exec ms |');
  console.log('|---:|---:|---:|---|---:|');
  const limit = knex.client.maxBindParameters || Infinity;
  for (const {
    rows: rowCount,
    metaColumns: metaCount,
    blobBytes,
  } of BLOB_MATRIX) {
    const metaColumns = Array.from({ length: metaCount }, (_, i) => `m${i}`);
    const metaTypes = jsonColumnTypesFor(knex, metaColumns);
    const insertChunk = Math.max(
      1,
      Math.min(50, Math.floor(limit / (metaColumns.length + 2)))
    );
    await knex.schema.dropTableIfExists('bench_blobs');
    await knex.schema.createTable('bench_blobs', (table) => {
      table.integer('id').primary();
      for (const column of metaColumns) {
        table.string(column);
      }
      table.binary('data');
    });
    const seed = [];
    for (let id = 1; id <= rowCount; id++) {
      const row = { id, data: Buffer.alloc(blobBytes, id % 256) };
      for (const column of metaColumns) {
        row[column] = `${column}-${id}`;
      }
      seed.push(row);
    }
    await knex.batchInsert('bench_blobs', seed, insertChunk);
    for (const mode of MODES) {
      let ms;
      try {
        const updates = seed.map((row) => {
          const next = { id: row.id, data: crypto.randomBytes(blobBytes) };
          for (const column of metaColumns) {
            next[column] = `${column}-updated-${row.id}`;
          }
          return next;
        });
        const options = { mode };
        if (mode === 'json' && metaTypes) {
          options.columnTypes = metaTypes;
        }
        const start = process.hrtime.bigint();
        await knex.batchUpdate('bench_blobs', updates, 'id', options);
        ms = (Number(process.hrtime.bigint() - start) / 1e6).toFixed(1);
      } catch (error) {
        ms = `ERR: ${error.message.split(' - ').pop().slice(0, 45)}`;
      }
      console.log(
        `| ${rowCount} | ${metaCount} | ${blobBytes} | ${mode} | ${ms} |`
      );
    }
  }
  await knex.schema.dropTableIfExists('bench_blobs');
}

async function run() {
  const dialect = (process.env.DB || process.argv[2] || 'sqlite3').match(
    /[\w-]+/g
  )[0];
  const knex = getKnexForDb(dialect);

  console.log(`\n# batchUpdate strategy benchmark — ${dialect}\n`);
  printModeImages();
  console.log('| rows | cols | mode | SQL bytes | params | chunks | exec ms |');
  console.log('|---:|---:|---|---:|---:|---:|---:|');

  const results = [];
  for (const { rows: rowCount, cols: colCount } of MATRIX) {
    const { columns, rows } = buildBatch(rowCount, colCount);
    const jsonColumnTypes = jsonColumnTypesFor(knex, columns);
    const unionColumnTypes = unionCastTypesFor(knex, columns);
    for (const mode of MODES) {
      let line;
      try {
        const { sqlBytes, params } = measureStatement(
          knex,
          columns,
          rows,
          mode,
          jsonColumnTypes
        );
        const chunks = chunksNeeded(knex, columns, rows, mode);
        const ms = await timeExecution(
          knex,
          columns,
          rows,
          mode,
          mode === 'json'
            ? jsonColumnTypes
            : mode === 'union'
            ? unionColumnTypes
            : undefined
        );
        results.push({
          rowCount,
          colCount,
          mode,
          sqlBytes,
          params,
          chunks,
          ms,
        });
        line = `| ${rowCount} | ${colCount} | ${mode} | ${sqlBytes} | ${params} | ${chunks} | ${ms.toFixed(
          1
        )} |`;
      } catch (error) {
        // Surface the limit that was hit (e.g. SQLite's compound-SELECT cap)
        // without dumping the multi-KB statement the driver echoes back.
        const reason = error.message.split(' - ').pop().slice(0, 60);
        results.push({ rowCount, colCount, mode, error: reason });
        line = `| ${rowCount} | ${colCount} | ${mode} | — | — | — | ERR: ${reason} |`;
      }
      console.log(line);
    }
  }

  printChartImage(dialect);
  printResultsJson(dialect, results);
  await benchColumnTypes(knex);
  await benchBlobs(knex);

  await knex.destroy();
}

// Cross-dialect charts at the top of every job's summary: one per mode, exec ms
// vs rows with a curve per dialect. They aren't job-specific (every dialect's
// data), so a single job can't generate them — they're the committed PNGs that
// scripts/batch-update-charts.js builds from all dialects' JSON. Embedded from
// the branch head, so they reflect the last committed chart run.
function printModeImages() {
  const base =
    'https://raw.githubusercontent.com/jclaveau/knex/feat/batch-update/scripts/bench-charts';
  // Lead with the cross-dialect summary: 3 curves (one per mode), exec ms
  // normalized to each dialect's union baseline and geomean-aggregated, so the
  // whole-picture "which mode wins overall" reads at a glance (1.0 = union,
  // lower = faster; the shaded band is the geometric spread across dialects).
  console.log(
    '## exec time vs union baseline — geomean across dialects (committed)\n'
  );
  console.log(
    `![exec ms vs union, geomean across dialects](${base}/mode-aggregate-ms.png)`
  );
  console.log('');
  console.log('## exec ms vs rows by dialect, per mode (committed)\n');
  for (const mode of MODES) {
    console.log(`![${mode} exec ms by dialect](${base}/mode-${mode}-ms.png)`);
    console.log('');
  }
}

// One graph per dialect in the run summary: embed the committed combined chart
// (all six curves, log axes, legend) for this dialect. Mermaid can't render that
// — no legend or stroke styles — so the summary points at the SVG/PNG that
// scripts/batch-update-charts.js builds from the JSON block below. It reflects
// the last committed chart data (this run's fresh numbers are in the table).
function printChartImage(dialect) {
  const base =
    'https://raw.githubusercontent.com/jclaveau/knex/feat/batch-update/scripts/bench-charts';
  console.log('\n## chart (committed; regenerate from the JSON below)\n');
  console.log(`![${dialect} batchUpdate chart](${base}/${dialect}.png)`);
  console.log('');
}

// Machine-readable results for scripts/batch-update-charts.js, in an HTML comment
// so it stays out of the rendered summary but is greppable in the job log.
function printResultsJson(dialect, results) {
  console.log('\n<!-- batch-update-bench-json');
  console.log(JSON.stringify({ dialect, results }));
  console.log('-->');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
