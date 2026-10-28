const chunk = require('lodash/chunk');
const flatten = require('lodash/flatten');
const delay = require('./internal/delay');
const { isNumber } = require('../util/is');
const QueryBuilder = require('../query/querybuilder');

// A DB type name is interpolated verbatim into the cast (`?::<type>`), so it
// can't be bound — guard it against injection. Allows `text`, `text[]`,
// `varchar(255)`, `numeric(10, 2)`, `timestamp(3) with time zone`, and a
// quoted, optionally schema-qualified name such as `"public"."mood"[]` (no `"`
// or `?` inside the quotes: one would end the identifier, the other is a knex
// binding placeholder).
const SAFE_DB_TYPE =
  /^(?:[a-z0-9_ ]+(?:\([\d, ]+\))?[a-z ]*|(?:"[^"?]+"\.)?"[^"?]+")(?:\[\])?$/i;

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
  // The statement names the table in every SET and WHERE reference
  // (`"t"."id"`), which an aliased (`t as x`), raw or builder table can't be.
  if (typeof tableName !== 'string' || /\sas\s/i.test(tableName)) {
    throw new TypeError(
      `Invalid tableName: Expected a table name without an alias, got ${
        typeof tableName === 'string'
          ? JSON.stringify(tableName)
          : typeof tableName
      }`
    );
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
  // `!(chunkSize >= 1)` and not `chunkSize < 1`: NaN would chunk to nothing.
  if (!isNumber(chunkSize) || !(chunkSize >= 1)) {
    throw new TypeError(`Invalid chunkSize: ${chunkSize}`);
  }
  if (onDuplicateKey !== 'last' && onDuplicateKey !== 'throw') {
    throw new TypeError(
      `Invalid onDuplicateKey: Expected 'last' or 'throw', got ${onDuplicateKey}`
    );
  }
  // Per-column DB cast types, used by 'union' (Postgres family: casts the
  // unknown-typed source) and 'json' (the typed COLUMNS/WITH list of the
  // JSON_TABLE/OPENJSON dialects). Three forms:
  //   - an object { id: 'uuid', tags: 'text[]' } — explicit per column
  //   - 'from_data' — infer from the JS values (the default when omitted)
  //   - 'from_db'   — read the real types from the schema (one columnInfo query)
  if (columnTypes != null) {
    // 'case' puts values in assignment context, where the column already types
    // them — there is nothing to cast, so columnTypes can't apply.
    if (mode === 'case') {
      throw new TypeError(`columnTypes has no effect in 'case' mode`);
    }
    // Postgres 'json' types every column from the table's row type; refuse a
    // map or 'from_db' here so 'from_db' doesn't run its columnInfo query first.
    if (
      mode === 'json' &&
      columnTypes !== 'from_data' &&
      !client.client.batchUpdateJsonTakesColumnTypes()
    ) {
      throw new TypeError(
        `columnTypes has no effect in 'json' mode on postgres: the column types come from the table row type`
      );
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
  // A raw or a subquery value reaches 'case' and 'union' as SQL, as in
  // .update(); 'json' sends values as data, where it would serialize the
  // builder object itself.
  if (mode === 'json') {
    const sqlColumn = [...keyColumns, ...columns].find((column) =>
      rows.some((row) => containsRawOrQuery(row[column]))
    );
    if (sqlColumn !== undefined) {
      throw new TypeError(
        `Invalid batch: ${sqlColumn} holds a raw value or a subquery; 'json' mode can't carry SQL, use mode 'case'`
      );
    }
  }
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
  // A Buffer key can't ride json either, and the key is in every statement, so
  // the whole update runs as 'union'.
  const hasBinaryKey = keyColumns.some((column) =>
    rows.some((row) => Buffer.isBuffer(row[column]))
  );

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
        // Column types for a 'union' statement run in place of 'json'. Where
        // 'json' types columns from the table row type (Postgres), the union
        // reads the same types from the catalog, so a uuid or enum key still
        // matches; elsewhere union needs no types. The caller asked for 'json',
        // not 'from_db', so a refusal names the batch and points at 'union'.
        const resolveUnionColumnTypes = (cols) =>
          client.client.batchUpdateJsonTakesColumnTypes()
            ? undefined
            : resolveColumnTypesFromDb(
                client.client,
                tr,
                tableName,
                [...keyColumns, ...cols],
                UNION_FOR_JSON_REFUSAL
              );
        // Binary columns: a Buffer binds natively in a 'union' statement, except
        // where the dialect needs the per-row LOB path (Oracle).
        const applyBinaryColumns = async (cols) =>
          canBindBinarySetBased
            ? applySetBased(
                cols,
                'union',
                undefined,
                await resolveUnionColumnTypes(cols)
              )
            : runPerRow(tr, tableName, rows, keyColumns, cols, undefined);

        if (mode === 'json' && hasBinaryKey) {
          if (!canBindBinarySetBased) {
            rejectReturningAcrossStatements(returning);
            return runPerRow(tr, tableName, rows, keyColumns, columns);
          }
          return applySetBased(
            columns,
            'union',
            returning,
            await resolveUnionColumnTypes(columns)
          );
        }
        // Resolve the type strategy to a concrete object once, before chunking
        // (after the Buffer-key reroute above, which reads its own types):
        // 'from_data' (or omitted) -> undefined, so the compiler infers per
        // value; 'from_db' -> one columnInfo lookup (in this transaction) mapped
        // to the columns; an object is passed through.
        const resolvedColumnTypes =
          columnTypes === 'from_db'
            ? await resolveColumnTypesFromDb(client.client, tr, tableName, [
                ...keyColumns,
                ...columns,
              ])
            : columnTypes === 'from_data'
            ? undefined
            : columnTypes;
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

const FROM_DB_REFUSAL = {
  prefix: "columnTypes 'from_db'",
  advice: 'pass an explicit columnTypes entry for it',
};
const UNION_FOR_JSON_REFUSAL = {
  prefix: 'Invalid batch',
  advice: "pass mode 'union' with a columnTypes entry for it",
};

// Reads the live schema types for the given columns (one query, through the
// dialect's `batchUpdateColumnTypesFromDb`) and returns a { column: type } map.
// A column the table doesn't report, or whose type isn't a safe type name,
// throws rather than falling back to value inference.
async function resolveColumnTypesFromDb(
  dialectClient,
  tr,
  tableName,
  allColumns,
  refusal = FROM_DB_REFUSAL
) {
  const dbTypes = await dialectClient.batchUpdateColumnTypesFromDb(
    tr,
    tableName
  );
  const types = {};
  for (const column of allColumns) {
    // The catalog names the column as the table does, after wrapIdentifier.
    const type =
      dbTypes[
        dialectClient.customWrapIdentifier(column, (identity) => identity)
      ];
    if (type === undefined) {
      throw new Error(
        `${refusal.prefix}: ${tableName} has no column ${column}`
      );
    }
    if (typeof type !== 'string' || !SAFE_DB_TYPE.test(type)) {
      throw new Error(
        `${refusal.prefix}: column ${column} has type ${JSON.stringify(
          type
        )}, which is not a valid type name; ${refusal.advice}`
      );
    }
    types[column] = type;
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
  const rowColumns = Object.keys(batch[0]).filter(
    (column) => !keyColumns.includes(column)
  );
  const expected = new Set([...keyColumns, ...rowColumns]);
  // Single primitive key (the common case) can index the Map directly; a
  // composite key is stringified.
  const singleKey = keyColumns.length === 1 ? keyColumns[0] : null;
  const byKey = new Map();
  const referenceIds = new Map();
  // The JS type of each key column's values, seen so far.
  const keyKinds = {};
  batch.forEach((row, rowIndex) => {
    const rowKeys = Object.keys(row);
    const sameShape =
      rowKeys.length === expected.size &&
      rowKeys.every((column) => expected.has(column));
    if (!sameShape) {
      throw new TypeError(
        'Invalid batch: every row must have the key column(s) and the same non-key columns'
      );
    }
    for (const keyColumn of keyColumns) {
      const value = row[keyColumn];
      // .where({ id: null }) compiles `is null` and can match many rows; a
      // key correlates one row, and `=` never matches null.
      if (value === null || value === undefined) {
        throw new TypeError(
          `Invalid batch: key ${keyColumn} is ${value} in row ${rowIndex}; a key must match one row by equality`
        );
      }
      // Duplicates are found by JS value, so 1 and '1' would stay two rows
      // that the database matches to the same one.
      const kind = valueKind(value);
      const firstKind = keyKinds[keyColumn];
      if (firstKind === undefined) {
        keyKinds[keyColumn] = kind;
      } else if (firstKind !== kind) {
        throw new TypeError(
          `Invalid batch: key ${keyColumn} holds both ${firstKind} and ${kind} values; pass one type so duplicate keys are found`
        );
      }
    }
    const identity = singleKey
      ? keyIdentity(row[singleKey])
      : JSON.stringify(
          keyColumns.map((column) =>
            compositeKeyPart(row[column], referenceIds)
          ),
          canonicalKeyValue
        );
    if (onDuplicateKey === 'throw' && byKey.has(identity)) {
      throw new Error(
        `Invalid batch: duplicate key ${JSON.stringify(
          keyColumns.map((column) => row[column]),
          duplicateKeyText
        )} (use onDuplicateKey: 'last' to keep the last row instead)`
      );
    }
    byKey.set(identity, row);
  });
  // Reuse the original array when nothing was collapsed.
  const rows = byKey.size === batch.length ? batch : [...byKey.values()];
  // .update() leaves an undefined column unwritten. One SET clause can do that
  // for every row, not for some: json would write NULL there and union would
  // bind an undefined.
  const columns = rowColumns.filter((column) => {
    const undefinedCount = rows.filter(
      (row) => row[column] === undefined
    ).length;
    if (undefinedCount > 0 && undefinedCount < rows.length) {
      throw new TypeError(
        `Invalid batch: ${column} is undefined in some rows only; one SET clause writes it in every row, so set it to null or leave it out of every row`
      );
    }
    return undefinedCount === 0;
  });
  if (columns.length === 0) {
    throw new TypeError(
      'Invalid batch: rows have no non-key columns to update'
    );
  }
  return { columns, rows };
}

// A raw value or a subquery (a builder, or a function .update() compiles to
// one): SQL in the statement, not a bound value.
function isRawOrQuery(value) {
  return Boolean(
    value &&
      (value.isRawInstance ||
        value instanceof QueryBuilder ||
        typeof value === 'function')
  );
}

// json serializes nested arrays and objects too, where a raw would become
// its builder object. The walk follows JSON.stringify: through toJSON, past
// nested functions (dropped), and once per object so a cycle reaches its own
// error at serialization.
function containsRawOrQuery(value, visited = new WeakSet()) {
  if (isRawOrQuery(value)) {
    return true;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    visited.has(value)
  ) {
    return false;
  }
  visited.add(value);
  if (typeof value.toJSON === 'function') {
    return containsRawOrQuery(value.toJSON(), visited);
  }
  return Object.values(value).some(
    (nested) =>
      typeof nested !== 'function' && containsRawOrQuery(nested, visited)
  );
}

function valueKind(value) {
  if (value instanceof Date) {
    return 'Date';
  }
  if (Buffer.isBuffer(value)) {
    return 'Buffer';
  }
  return typeof value;
}

// A Map compares a Date, a Buffer, an array or an object by reference; two
// equal ones are the same key. The key column holds one JS type, so these
// can't collide with a number or a string key. A raw or a subquery key is SQL
// the database evaluates, and a class instance's JSON may not hold its state
// (a #private field bound through toPostgres), so both stay compared by
// reference.
function keyIdentity(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('hex');
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    return JSON.stringify(value, canonicalKeyValue);
  }
  return value;
}

// A composite key is one JSON string, where a raw would hit its client's cycle
// and a class instance or a subquery would collapse to {} or null. Each stands
// as the id of its object instead, so it is compared by reference as a single
// key is. A key column holds one JS type, and the other values of an object
// column serialize to an array or an object, never to a bare id.
function compositeKeyPart(value, referenceIds) {
  if (!comparesByReference(value)) {
    return value;
  }
  if (!referenceIds.has(value)) {
    referenceIds.set(value, referenceIds.size);
  }
  return referenceIds.get(value);
}

function comparesByReference(value) {
  if (isRawOrQuery(value)) {
    return true;
  }
  return (
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value) &&
    !Array.isArray(value) &&
    !isPlainObject(value)
  );
}

function duplicateKeyText(_, value) {
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (comparesByReference(value)) {
    return `[${value.constructor.name}]`;
  }
  return value;
}

// JSON.stringify throws on a bigint (an int8 key column), so it is wrapped in
// an object no primitive key value can serialize to. jsonb ignores property
// order, so a plain object's properties are sorted.
function canonicalKeyValue(_, value) {
  if (typeof value === 'bigint') {
    return { bigint: String(value) };
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((property) => [property, value[property]])
    );
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = batchUpdate;
module.exports.prepareBatch = prepareBatch;
module.exports.resolveColumnTypesFromDb = resolveColumnTypesFromDb;
