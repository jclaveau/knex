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
  // mode: the SQL strategy — 'union' (default), 'case', or 'json'. chunkSize:
  // rows per statement. onDuplicateKey: how to handle two rows sharing a key —
  // keep the last (default) or throw.
  const {
    mode = 'union',
    chunkSize = 1000,
    onDuplicateKey = 'last',
    columnTypes,
  } = options || {};
  if (mode !== 'union' && mode !== 'case' && mode !== 'json') {
    throw new TypeError(
      `Invalid mode: Expected 'union', 'case' or 'json', got ${mode}`
    );
  }
  if (!isNumber(chunkSize) || chunkSize < 1) {
    throw new TypeError(`Invalid chunkSize: ${chunkSize}`);
  }
  if (onDuplicateKey !== 'last' && onDuplicateKey !== 'throw') {
    throw new TypeError(
      `Invalid onDuplicateKey: Expected 'last' or 'throw', got ${onDuplicateKey}`
    );
  }
  // Per-column DB cast types (Postgres family only), used by 'union' (casts the
  // unknown-typed source) and 'json' (the column-definition list). Three forms:
  //   - an object { id: 'uuid', tags: 'text[]' } — explicit per column
  //   - 'from_data' — infer from the JS values (the default when omitted)
  //   - 'from_db'   — read the real types from the schema (one columnInfo query)
  if (columnTypes != null) {
    // 'case' puts values in assignment context, where the column already types
    // them — there is nothing to cast, so columnTypes can't apply.
    if (mode === 'case') {
      throw new TypeError(`columnTypes has no effect in 'case' mode`);
    }
    if (columnTypes !== 'from_data' && columnTypes !== 'from_db') {
      if (typeof columnTypes !== 'object') {
        throw new TypeError(
          `Invalid columnTypes: Expected an object, 'from_data' or 'from_db', got ${typeof columnTypes}`
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
  }
  // Validate shape and collapse duplicate keys up front (one pass), so every
  // input error throws synchronously at the call site like the guards above.
  const { columns, rows } =
    batch.length === 0
      ? { columns: [], rows: [] }
      : prepareBatch(batch, keyColumns, onDuplicateKey);
  // Binary (Buffer) columns. 'json' can't carry a Buffer — JSON.stringify mangles
  // it into { type: 'Buffer', data: [...] } — so when json mode meets binary
  // columns the update is auto-split: the json-able columns ride json and the
  // binary columns ride a companion 'union' (or, where a dialect can't bind a
  // Buffer in a set statement, per-row) UPDATE — both keyed, in the same
  // transaction. union/case bind a Buffer natively, except where
  // batchUpdateSupportsBinary() is false (Oracle's BLOB needs a per-row
  // RETURNING ... INTO LOB), which falls back to per-row for the whole row.
  const binaryColumns = columns.filter((column) =>
    rows.some((row) => Buffer.isBuffer(row[column]))
  );
  const hasBinary = binaryColumns.length > 0;
  const canBindBinarySetBased = client.client.batchUpdateSupportsBinary();

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
        // Resolve the type strategy to a concrete object once, before chunking:
        // 'from_data' (or omitted) -> undefined, so the compiler infers per
        // value; 'from_db' -> one columnInfo lookup (in this transaction) mapped
        // to the columns; an object is passed through.
        const resolvedColumnTypes =
          columnTypes === 'from_db'
            ? await resolveColumnTypesFromDb(tr, tableName, [
                ...keyColumns,
                ...columns,
              ])
            : columnTypes === 'from_data'
            ? undefined
            : columnTypes;

        // Set-based UPDATE(s) for one column subset, chunked for the mode. The
        // caller passes the columnTypes that apply to that statement (none for the
        // binary companion — union infers a Buffer's type, and non-pg dialects
        // reject a columnTypes map on union outright) and, for the json split, the
        // rows projected to the statement's columns so a stripped-out blob doesn't
        // bloat the json payload.
        const applySetBased = (
          cols,
          statementMode,
          ret,
          statementColumnTypes,
          sourceRows = rows
        ) =>
          runChunks(
            tr,
            tableName,
            chunkRowsFor(
              client,
              sourceRows,
              keyColumns,
              cols,
              statementMode,
              chunkSize
            ),
            keyColumns,
            cols,
            statementColumnTypes,
            statementMode,
            ret
          );
        // Binary columns: a Buffer binds natively in a 'union' statement, except
        // where the dialect needs the per-row LOB path (Oracle).
        const applyBinaryColumns = (cols) =>
          canBindBinarySetBased
            ? applySetBased(cols, 'union', undefined, undefined)
            : runPerRow(tr, tableName, rows, keyColumns, cols, undefined);

        // json can't take a Buffer: split the row — json-able columns ride json,
        // binary columns ride a companion union/per-row statement, same txn.
        if (mode === 'json' && hasBinary) {
          rejectReturningAcrossStatements(returning);
          const jsonableColumns = columns.filter(
            (column) => !binaryColumns.includes(column)
          );
          const results = [];
          if (jsonableColumns.length) {
            // Project away the binary columns: json serializes whole rows, and a
            // Buffer balloons into a per-byte array it would carry but never use.
            const keptColumns = [...keyColumns, ...jsonableColumns];
            const jsonRows = rows.map((row) => {
              const projected = {};
              for (const column of keptColumns) {
                projected[column] = row[column];
              }
              return projected;
            });
            results.push(
              ...(await applySetBased(
                jsonableColumns,
                'json',
                undefined,
                resolvedColumnTypes,
                jsonRows
              ))
            );
          }
          results.push(...(await applyBinaryColumns(binaryColumns)));
          return results;
        }
        // union/case carrying a Buffer on a dialect that can't bind it set-based
        // (Oracle): per-row for the whole row.
        if (hasBinary && !canBindBinarySetBased) {
          rejectReturningAcrossStatements(returning);
          return runPerRow(tr, tableName, rows, keyColumns, columns, returning);
        }
        // Common path: one set-based statement family for every column.
        return applySetBased(columns, mode, returning, resolvedColumnTypes);
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

// Split `rows` into chunks small enough for one statement: the tighter of the
// dialect's bind-parameter cap (mssql: 2098) and any structural per-statement row
// cap (e.g. SQLite's compound-SELECT term limit), for this mode and column set.
//  - union: one value per cell -> keys + columns
//  - case:  each column's CASE matches every row -> columns*(keys+1) + the WHERE
//           keys per row
//  - json:  the whole chunk is a single parameter -> independent of rows
function chunkRowsFor(client, rows, keyColumns, columns, mode, chunkSize) {
  const perRowBindParameters =
    mode === 'json'
      ? 0
      : mode === 'case'
      ? columns.length * (keyColumns.length + 1) + keyColumns.length
      : keyColumns.length + columns.length;
  const maxBindParameters = client.client.maxBindParameters || Infinity;
  const maxRowsByBindParameters =
    perRowBindParameters > 0
      ? Math.max(1, Math.floor(maxBindParameters / perRowBindParameters))
      : Infinity;
  const maxRowsByDialect = client.client.batchUpdateRowLimit(mode);
  const maxRowsPerChunk = Math.min(maxRowsByBindParameters, maxRowsByDialect);
  return chunk(rows, Math.max(1, Math.min(chunkSize, maxRowsPerChunk)));
}

// One set-based batchUpdate statement per chunk for the given columns and mode.
async function runChunks(
  tr,
  tableName,
  chunks,
  keyColumns,
  columns,
  columnTypes,
  mode,
  returning
) {
  const results = [];
  for (const chunkRows of chunks) {
    let query = tr(tableName).batchUpdate(
      chunkRows,
      keyColumns,
      columns,
      columnTypes,
      mode
    );
    if (returning) {
      query = query.returning(returning);
    }
    results.push(await query);
  }
  return flatten(results);
}

// `returning` has no single source statement once the update spans more than one
// (the binary auto-split / per-row paths), so reject it there.
function rejectReturningAcrossStatements(returning) {
  if (returning) {
    throw new Error(
      `.batchUpdate().returning() is not supported when binary columns split the update across statements`
    );
  }
}

// Per-row fallback: one UPDATE per row through the normal builder, which reuses
// the dialect's binary/LOB handling (e.g. Oracle's BlobHelper RETURNING ... INTO
// path). Used only when a dialect can't carry a Buffer in the set-based form.
async function runPerRow(tr, tableName, rows, keyColumns, columns, returning) {
  const results = [];
  for (const row of rows) {
    const where = {};
    for (const keyColumn of keyColumns) {
      where[keyColumn] = row[keyColumn];
    }
    const update = {};
    for (const column of columns) {
      update[column] = row[column];
    }
    let query = tr(tableName).where(where).update(update);
    if (returning) {
      query = query.returning(returning);
    }
    results.push(await query);
  }
  return flatten(results);
}

// Reads the live schema types for the given columns via columnInfo (one query)
// and returns a { column: type } map for the columns whose reported type is a
// safe plain type name. Unsafe/missing types are dropped so the compiler falls
// back to value inference for them. Arrays surface as the bare `ARRAY`, so an
// element type (`text[]`) may still need an explicit columnTypes entry.
async function resolveColumnTypesFromDb(tr, tableName, allColumns) {
  const info = await tr(tableName).columnInfo();
  const types = {};
  for (const column of allColumns) {
    const type = info[column] && info[column].type;
    if (typeof type === 'string' && SAFE_DB_TYPE.test(type)) {
      types[column] = type;
    }
  }
  return types;
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
