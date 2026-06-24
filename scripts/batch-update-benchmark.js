'use strict';

// Benchmark for knex.batchUpdate's three strategies (mode: union | case | json).
// Produces the tradeoff data referenced in the RFC: generated-SQL size, bound
// parameter count, chunks needed under the dialect's parameter limit, and the
// wall-clock to apply the whole batch.
//
// Usage:
//   node scripts/batch-update-benchmark.js            # sqlite3, in-memory (all 3 modes)
//   node scripts/batch-update-benchmark.js pg         # needs a reachable pg (see CONNECTIONS)
//
// sqlite is the default because it is the one embedded dialect that supports
// all three strategies with no server to stand up.

const knexLib = require('../knex');

const CONNECTIONS = {
  sqlite3: { connection: ':memory:', useNullAsDefault: true },
  pg: { connection: process.env.PG_URL || 'postgres://localhost/knex_test' },
  mysql: { connection: process.env.MYSQL_URL || 'mysql://localhost/knex_test' },
};

// Every strategy works on sqlite/pg; the others only implement a subset so far.
const MODES = ['union', 'case', 'json'];

const MATRIX = [
  { rows: 100, cols: 3 },
  { rows: 1000, cols: 3 },
  { rows: 1000, cols: 20 },
  { rows: 10000, cols: 3 },
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
function measureStatement(knex, columns, rows, mode) {
  const compiled = knex('bench')
    .batchUpdate(rows, ['id'], columns, undefined, mode)
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
  const maxRows = Math.max(1, Math.floor(limit / perRow));
  return Math.ceil(rows.length / maxRows);
}

async function timeExecution(knex, columns, rows, mode) {
  await createTable(knex, columns);
  await knex.batchInsert('bench', rows, 500);
  const updated = rows.map((row) => {
    const next = { id: row.id };
    for (const column of columns) {
      next[column] = `${column}-updated-${row.id}`;
    }
    return next;
  });
  const start = process.hrtime.bigint();
  await knex.batchUpdate('bench', updated, 'id', { mode });
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6; // ms
}

async function run() {
  const dialect = process.argv[2] || 'sqlite3';
  const config = CONNECTIONS[dialect];
  if (!config) {
    throw new Error(`Unknown dialect '${dialect}'. Try: sqlite3, pg, mysql`);
  }
  const knex = knexLib({ client: dialect, ...config });

  console.log(`\n# batchUpdate strategy benchmark — ${dialect}\n`);
  console.log('| rows | cols | mode | SQL bytes | params | chunks | exec ms |');
  console.log('|---:|---:|---|---:|---:|---:|---:|');

  for (const { rows: rowCount, cols: colCount } of MATRIX) {
    const { columns, rows } = buildBatch(rowCount, colCount);
    for (const mode of MODES) {
      let line;
      try {
        const { sqlBytes, params } = measureStatement(
          knex,
          columns,
          rows,
          mode
        );
        const chunks = chunksNeeded(knex, columns, rows, mode);
        const ms = await timeExecution(knex, columns, rows, mode);
        line = `| ${rowCount} | ${colCount} | ${mode} | ${sqlBytes} | ${params} | ${chunks} | ${ms.toFixed(
          1
        )} |`;
      } catch (error) {
        // Surface the limit that was hit (e.g. SQLite's compound-SELECT cap)
        // without dumping the multi-KB statement the driver echoes back.
        const reason = error.message.split(' - ').pop().slice(0, 60);
        line = `| ${rowCount} | ${colCount} | ${mode} | — | — | — | ERR: ${reason} |`;
      }
      console.log(line);
    }
  }

  await knex.destroy();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
