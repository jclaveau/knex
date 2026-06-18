const chunk = require('lodash/chunk');
const flatten = require('lodash/flatten');
const delay = require('./internal/delay');
const { isNumber } = require('../util/is');

// Updates many rows with different per-row values in a single set-based
// statement per chunk, picking the best form each dialect supports
// (UPDATE ... FROM (SELECT ...) / UPDATE ... JOIN / MERGE). Mirrors batchInsert's
// chunking + transaction + chainable shape; unlike batchInsert it is keyed
// (correlates each row to an existing row) and dialect-aware.
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
          chunksResults.push(
            await buildBatchUpdateQuery(
              tr,
              tableName,
              keyColumns,
              columns,
              rows,
              returning
            )
          );
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

function buildBatchUpdateQuery(
  qb,
  tableName,
  keyColumns,
  columns,
  rows,
  returning
) {
  const dialect = qb.client.dialect;
  switch (dialect) {
    // Postgres / CockroachDB / Redshift all speak UPDATE ... FROM, but only
    // node-postgres exposes `.updateFrom()` on the builder, so build it raw.
    case 'postgresql':
    case 'redshift':
      return updateFromSelect(qb, tableName, keyColumns, columns, rows, {
        returning,
        casts: true,
        // Only true Postgres/CockroachDB support RETURNING on UPDATE.
        allowReturning: dialect === 'postgresql',
      });
    case 'sqlite3':
      return updateFromSelect(qb, tableName, keyColumns, columns, rows, {
        returning,
        casts: false,
        allowReturning: false,
      });
    case 'mysql':
    case 'mssql':
      return updateFromJoin(
        qb,
        tableName,
        keyColumns,
        columns,
        rows,
        returning
      );
    case 'oracle':
      return updateFromMerge(
        qb,
        tableName,
        keyColumns,
        columns,
        rows,
        returning
      );
    default:
      throw new Error(`.batchUpdate() is not supported for ${dialect}`);
  }
}

// Postgres / CockroachDB / Redshift / SQLite:
//   UPDATE t SET c = v.c FROM (SELECT ... UNION ALL ...) v WHERE t.k = v.k
// Built raw (?? = identifier, ? = value) because neither the SQLite builder nor
// the CockroachDB/Redshift builders emit a FROM clause on UPDATE.
function updateFromSelect(qb, tableName, keyColumns, columns, rows, options) {
  const { returning, casts, allowReturning } = options;
  if (returning && !allowReturning) {
    throw new Error(
      `.batchUpdate().returning() is not supported for ${qb.client.dialect}`
    );
  }
  const allColumns = [...keyColumns, ...columns];
  const source = derivedSelect(allColumns, rows, 'v', {
    useAs: true,
    fromDual: false,
    castTypes: casts ? allColumns.map((c) => inferPgCast(rows, c)) : null,
  });
  const setSql = columns.map(() => '?? = ??').join(', ');
  const setBindings = [];
  for (const column of columns) {
    setBindings.push(column, `v.${column}`);
  }
  const whereSql = keyColumns.map(() => '?? = ??').join(' and ');
  const whereBindings = [];
  for (const keyColumn of keyColumns) {
    whereBindings.push(`${tableName}.${keyColumn}`, `v.${keyColumn}`);
  }
  let sql = `update ?? set ${setSql} from ${source.sql} where ${whereSql}`;
  const bindings = [
    tableName,
    ...setBindings,
    ...source.bindings,
    ...whereBindings,
  ];
  if (returning) {
    const returns = Array.isArray(returning) ? returning : [returning];
    sql += ` returning ${returns.map(() => '??').join(', ')}`;
    // Qualify with the target table: the FROM source shares column names
    // (e.g. "id"), so a bare RETURNING column reference is ambiguous.
    bindings.push(...returns.map((column) => `${tableName}.${column}`));
  }
  return qb.raw(sql, bindings);
}

// MySQL / MariaDB / MSSQL: UPDATE t JOIN (SELECT ...) src ON t.k = src.k SET t.c = src.c.
// Uses the builder so MSSQL still emits its `select @@rowcount` affected-rows tail.
function updateFromJoin(qb, tableName, keyColumns, columns, rows, returning) {
  if (returning) {
    throw new Error(
      `.batchUpdate().returning() is not supported for ${qb.client.dialect}`
    );
  }
  const allColumns = [...keyColumns, ...columns];
  const source = derivedSelect(allColumns, rows, 'src', {
    useAs: true,
    fromDual: false,
    castTypes: null,
  });
  const set = {};
  for (const column of columns) {
    // ref() emits an identifier in SET, so the value is pulled from the join.
    set[`${tableName}.${column}`] = qb.ref(`src.${column}`);
  }
  return qb(tableName)
    .join(qb.raw(source.sql, source.bindings), function () {
      for (const keyColumn of keyColumns) {
        this.on(`${tableName}.${keyColumn}`, '=', `src.${keyColumn}`);
      }
    })
    .update(set);
}

// Oracle: MERGE INTO t tgt USING (SELECT ... FROM dual ...) v ON (...) WHEN MATCHED THEN UPDATE SET ...
function updateFromMerge(qb, tableName, keyColumns, columns, rows, returning) {
  if (returning) {
    throw new Error('.batchUpdate().returning() is not supported by oracle');
  }
  const allColumns = [...keyColumns, ...columns];
  // Oracle rejects AS for subquery/column aliases and needs FROM dual.
  const source = derivedSelect(allColumns, rows, 'v', {
    useAs: false,
    fromDual: true,
    castTypes: null,
  });
  const onSql = keyColumns.map(() => '?? = ??').join(' and ');
  const onBindings = [];
  for (const keyColumn of keyColumns) {
    onBindings.push(`tgt.${keyColumn}`, `v.${keyColumn}`);
  }
  const setSql = columns.map(() => '?? = ??').join(', ');
  const setBindings = [];
  for (const column of columns) {
    setBindings.push(`tgt.${column}`, `v.${column}`);
  }
  return qb.raw(
    `merge into ?? tgt using ${source.sql} on (${onSql}) when matched then update set ${setSql}`,
    [tableName, ...source.bindings, ...onBindings, ...setBindings]
  );
}

// `(SELECT v1 [as] k1, ... [from dual] UNION ALL SELECT v2, ... ) [as] alias`.
// Only the first SELECT names (and, for Postgres, casts) the columns; later rows
// inherit them. Returns raw template parts (`?` value / `??` identifier
// placeholders + bindings) so callers embed it (FROM/MERGE) or wrap it as a join
// source (mysql/mssql).
function derivedSelect(
  allColumns,
  rows,
  alias,
  { useAs, fromDual, castTypes }
) {
  let sql = '';
  const bindings = [];
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) {
      sql += ' union all ';
    }
    sql +=
      'select ' +
      allColumns
        .map((column, columnIndex) => {
          if (rowIndex === 0) {
            bindings.push(row[column], column);
            const value = castTypes ? `?::${castTypes[columnIndex]}` : '?';
            return useAs ? `${value} as ??` : `${value} ??`;
          }
          bindings.push(row[column]);
          return '?';
        })
        .join(', ');
    if (fromDual) {
      sql += ' from dual';
    }
  });
  bindings.push(alias);
  return { sql: useAs ? `(${sql}) as ??` : `(${sql}) ??`, bindings };
}

function inferPgCast(rows, column) {
  for (const row of rows) {
    const value = row[column];
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'number') return 'numeric';
    if (typeof value === 'boolean') return 'boolean';
    if (value instanceof Date) return 'timestamptz';
    if (Buffer.isBuffer(value)) return 'bytea';
    if (typeof value === 'object') return 'jsonb';
    return 'text';
  }
  return 'text';
}

module.exports = batchUpdate;
module.exports.buildBatchUpdateQuery = buildBatchUpdateQuery;
module.exports.updatableColumns = updatableColumns;
