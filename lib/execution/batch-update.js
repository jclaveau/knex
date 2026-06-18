const chunk = require('lodash/chunk');
const flatten = require('lodash/flatten');
const delay = require('./internal/delay');
const { isNumber } = require('../util/is');

// Updates many rows with different per-row values, one set-based statement per
// chunk, wrapped in a transaction. Mirrors batchInsert's chunking/transaction/
// chainable shape and stays dialect-agnostic: the per-dialect SQL lives in each
// dialect's query compiler (`QueryCompiler#batchUpdate`). Unlike batchInsert it
// is keyed — every row is correlated to an existing row by `key`.
function batchUpdate(client, tableName, batch, key = 'id', chunkSize = 1000) {
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
  const columns = batch.length ? updatableColumns(batch, keyColumns) : [];
  const chunks = chunk(batch, chunkSize);

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
      return runInTransaction(async (tr) => {
        const chunksResults = [];
        for (const rows of chunks) {
          let query = tr(tableName).batchUpdate(rows, keyColumns, columns);
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
