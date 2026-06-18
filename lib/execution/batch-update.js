const chunk = require('lodash/chunk');
const flatten = require('lodash/flatten');
const delay = require('./internal/delay');
const { isNumber } = require('../util/is');

// Updates many rows with different per-row values, one set-based statement per
// chunk, wrapped in a transaction. Mirrors batchInsert's chunking/transaction/
// chainable shape and stays dialect-agnostic: the per-dialect SQL lives in each
// dialect's query compiler (`QueryCompiler#batchUpdate`). Unlike batchInsert it
// is keyed — every row is correlated to an existing row by `key`.
function batchUpdate(
  client,
  tableName,
  batch,
  key = 'id',
  chunkSize = 1000,
  options = {}
) {
  let returning = undefined;
  let transaction = null;
  if (!isNumber(chunkSize) || chunkSize < 1) {
    throw new TypeError(`Invalid chunkSize: ${chunkSize}`);
  }
  if (!Array.isArray(batch)) {
    throw new TypeError(`Invalid batch: Expected array, got ${typeof batch}`);
  }
  const keyColumns = Array.isArray(key) ? key : [key];
  if (
    keyColumns.length === 0 ||
    keyColumns.some((column) => typeof column !== 'string')
  ) {
    throw new TypeError(
      `Invalid key: Expected a column name or array of column names`
    );
  }
  // How to handle two rows sharing a key: keep the last (default) or throw.
  const { onDuplicateKey = 'last', columnTypes } = options || {};
  if (onDuplicateKey !== 'last' && onDuplicateKey !== 'throw') {
    throw new TypeError(
      `Invalid onDuplicateKey: Expected 'last' or 'throw', got ${onDuplicateKey}`
    );
  }
  // Optional per-column DB cast types (Postgres family only), e.g.
  // { id: 'uuid', tags: 'text[]' } — for types the JS-value heuristic can't see.
  if (columnTypes != null && typeof columnTypes !== 'object') {
    throw new TypeError(
      `Invalid columnTypes: Expected an object, got ${typeof columnTypes}`
    );
  }
  const columns = batch.length ? updatableColumns(batch, keyColumns) : [];

  const runInTransaction = (cb) => {
    if (transaction) {
      return cb(transaction);
    }
    return client.transaction(cb);
  };

  return Object.assign(
    Promise.resolve().then(async () => {
      //Next tick to ensure wrapper functions are called if needed
      await delay(1);
      if (batch.length === 0) {
        return [];
      }
      // Collapse duplicate keys to a single row per statement (last wins),
      // unless the caller opted into throwing. A set-based UPDATE has no
      // defined row order, so duplicate keys are otherwise non-deterministic
      // (and Oracle MERGE errors on them).
      const rows = dedupeByKey(batch, keyColumns, onDuplicateKey === 'throw');
      const chunks = chunk(rows, chunkSize);
      return runInTransaction(async (tr) => {
        const chunksResults = [];
        for (const chunkRows of chunks) {
          let query = tr(tableName).batchUpdate(
            chunkRows,
            keyColumns,
            columns,
            columnTypes
          );
          if (returning) {
            query = query.returning(returning);
          }
          chunksResults.push(await query);
        }
        return flatten(chunksResults);
      });
    }),
    {
      returning(columnsToReturn) {
        returning = columnsToReturn;

        return this;
      },
      transacting(tr) {
        transaction = tr;

        return this;
      },
    }
  );
}

// Deduplicates by key, keeping the last occurrence (last-write-wins). With
// `throwOnDuplicate`, a repeated key throws instead. Keeping one row per key
// makes the per-statement update deterministic across dialects.
function dedupeByKey(batch, keyColumns, throwOnDuplicate) {
  const byKey = new Map();
  for (const row of batch) {
    const identity = JSON.stringify(keyColumns.map((column) => row[column]));
    if (throwOnDuplicate && byKey.has(identity)) {
      throw new Error(
        `Invalid batch: duplicate key ${identity} (use onDuplicateKey: 'last' to keep the last row instead)`
      );
    }
    byKey.set(identity, row);
  }
  return [...byKey.values()];
}

// Every row must carry the key column(s) plus an identical set of non-key
// columns. Ragged rows are rejected: a single set-based statement applies one
// SET clause to every row, so a missing column would silently NULL-overwrite
// existing data. Callers with ragged data pre-group by shape.
function updatableColumns(batch, keyColumns) {
  const first = batch[0];
  const columns = Object.keys(first).filter(
    (column) => !keyColumns.includes(column)
  );
  if (columns.length === 0) {
    throw new TypeError(
      'Invalid batch: rows have no non-key columns to update'
    );
  }
  const expected = new Set([...keyColumns, ...columns]);
  for (const row of batch) {
    const rowKeys = Object.keys(row);
    const sameShape =
      rowKeys.length === expected.size &&
      rowKeys.every((column) => expected.has(column)) &&
      keyColumns.every((column) => column in row);
    if (!sameShape) {
      throw new TypeError(
        'Invalid batch: every row must have the key column(s) and the same non-key columns'
      );
    }
  }
  return columns;
}

module.exports = batchUpdate;
module.exports.updatableColumns = updatableColumns;
module.exports.dedupeByKey = dedupeByKey;
