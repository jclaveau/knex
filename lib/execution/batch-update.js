const chunk = require('lodash/chunk');
const flatten = require('lodash/flatten');
const delay = require('./internal/delay');
const { isNumber } = require('../util/is');

// A DB type name is interpolated verbatim into the cast (`?::<type>`), so it
// can't be bound — guard it against injection. Allows `text`, `text[]`,
// `varchar(255)`, `numeric(10, 2)`, `timestamp with time zone`.
const SAFE_DB_TYPE = /^[a-z0-9_ ]+(\([\d, ]+\))?(\[\])?$/i;

// Updates many rows with different per-row values, one set-based statement per
// chunk, wrapped in a transaction. Mirrors batchInsert's chunking/transaction/
// chainable shape and stays dialect-agnostic: the per-dialect SQL lives in each
// dialect's query compiler (`QueryCompiler#batchUpdate`). Unlike batchInsert it
// is keyed — every row is correlated to an existing row by `key`.
function batchUpdate(client, tableName, batch, key = 'id', options = {}) {
  let returning = undefined;
  let transaction = null;
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
  // chunkSize: rows per set-based statement. onDuplicateKey: how to handle two
  // rows sharing a key — keep the last (default) or throw.
  const {
    chunkSize = 1000,
    onDuplicateKey = 'last',
    columnTypes,
  } = options || {};
  if (!isNumber(chunkSize) || chunkSize < 1) {
    throw new TypeError(`Invalid chunkSize: ${chunkSize}`);
  }
  if (onDuplicateKey !== 'last' && onDuplicateKey !== 'throw') {
    throw new TypeError(
      `Invalid onDuplicateKey: Expected 'last' or 'throw', got ${onDuplicateKey}`
    );
  }
  // Optional per-column DB cast types (Postgres family only), e.g.
  // { id: 'uuid', tags: 'text[]' } — for types the JS-value heuristic can't see.
  if (columnTypes != null) {
    if (typeof columnTypes !== 'object') {
      throw new TypeError(
        `Invalid columnTypes: Expected an object, got ${typeof columnTypes}`
      );
    }
    for (const [column, type] of Object.entries(columnTypes)) {
      if (typeof type !== 'string' || !SAFE_DB_TYPE.test(type)) {
        throw new TypeError(
          `Invalid columnTypes.${column}: ${JSON.stringify(
            type
          )} is not a valid type name`
        );
      }
    }
  }
  // Validate shape and collapse duplicate keys up front (one pass), so every
  // input error throws synchronously at the call site like the guards above.
  const { columns, rows } =
    batch.length === 0
      ? { columns: [], rows: [] }
      : prepareBatch(batch, keyColumns, onDuplicateKey);
  // A chunk binds one parameter per cell (rows * all columns). Dialects that
  // cap parameters per statement (mssql: 2100) expose `maxBindParameters`; cap
  // the chunk so a wide table can't overflow it on the default chunkSize.
  const cellsPerRow = keyColumns.length + columns.length;
  const maxBindParameters = client.client.maxBindParameters || Infinity;
  const maxRowsPerChunk = Math.floor(maxBindParameters / cellsPerRow);
  const chunks = chunk(rows, Math.min(chunkSize, maxRowsPerChunk));

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
      if (rows.length === 0) {
        return [];
      }
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

// Validates row shape and collapses duplicate keys in a single pass, returning
// the updatable (non-key) columns and the deduped rows.
//
// Shape: every row must carry the key column(s) plus an identical set of non-key
// columns. Ragged rows are rejected because one SET clause applies to every row,
// so a missing column would silently NULL-overwrite existing data.
//
// Duplicates: a set-based UPDATE (UPDATE ... FROM / JOIN / MERGE) applies the
// matched set in no defined order, so the database cannot honor "the last row
// wins" for a duplicated key — it picks an arbitrary matching source row
// (Postgres/MySQL/MSSQL) or errors (Oracle MERGE, ORA-30926). Row order only
// exists here in the JS array, so deduping here — keeping the last occurrence —
// is what actually makes last-write-wins deterministic and gives every emitted
// statement unique keys. `onDuplicateKey: 'throw'` rejects duplicates instead.
function prepareBatch(batch, keyColumns, onDuplicateKey) {
  const columns = Object.keys(batch[0]).filter(
    (column) => !keyColumns.includes(column)
  );
  if (columns.length === 0) {
    throw new TypeError(
      'Invalid batch: rows have no non-key columns to update'
    );
  }
  const expected = new Set([...keyColumns, ...columns]);
  // Single primitive key (the common case) can index the Map directly; a
  // composite key is stringified.
  const singleKey = keyColumns.length === 1 ? keyColumns[0] : null;
  const byKey = new Map();
  for (const row of batch) {
    const rowKeys = Object.keys(row);
    const sameShape =
      rowKeys.length === expected.size &&
      rowKeys.every((column) => expected.has(column));
    if (!sameShape) {
      throw new TypeError(
        'Invalid batch: every row must have the key column(s) and the same non-key columns'
      );
    }
    const identity = singleKey
      ? row[singleKey]
      : JSON.stringify(keyColumns.map((column) => row[column]));
    if (onDuplicateKey === 'throw' && byKey.has(identity)) {
      throw new Error(
        `Invalid batch: duplicate key ${JSON.stringify(
          keyColumns.map((column) => row[column])
        )} (use onDuplicateKey: 'last' to keep the last row instead)`
      );
    }
    byKey.set(identity, row);
  }
  // Reuse the original array when nothing was collapsed.
  const rows = byKey.size === batch.length ? batch : [...byKey.values()];
  return { columns, rows };
}

module.exports = batchUpdate;
module.exports.prepareBatch = prepareBatch;
