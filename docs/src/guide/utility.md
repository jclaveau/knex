# Utility

A collection of utilities that the knex library provides for convenience.

## batchInsert

**knex.batchInsert(tableName)**

The `batchInsert` utility will insert a batch of rows wrapped inside a transaction _(which is automatically created unless explicitly given a transaction using [transacting](/guide/query-builder#transacting))_, at a given `chunkSize`.

It's primarily designed to be used when you have thousands of rows to insert into a table.

By default, the `chunkSize` is set to 1000.

BatchInsert also allows for [returning values](/guide/query-builder#returning) and supplying transactions using [transacting](/guide/query-builder#transacting).

```js
const rows = [
  {
    /*...*/
  },
  {
    /*...*/
  },
];
const chunkSize = 30;
knex
  .batchInsert('TableName', rows, chunkSize)
  .returning('id')
  .then(function (ids) {
    /*...*/
  })
  .catch(function (error) {
    /*...*/
  });

knex
  .transaction(function (tr) {
    return knex.batchInsert('TableName', rows, chunkSize).transacting(tr);
  })
  .then(function () {
    /*...*/
  })
  .catch(function (error) {
    /*...*/
  });
```

## batchUpdate

**knex.batchUpdate(tableName, rows, key, options)**

The `batchUpdate` utility updates many rows with **different per-row values** in a single set-based statement per chunk, wrapped in a transaction _(automatically created unless explicitly given one using [transacting](/guide/query-builder#transacting))_. Each row is matched to an existing row by `key`, which defaults to `'id'` and may be an array for a composite key. Behaviour is tuned through the `options` object: `mode`, `chunkSize` (default 1000), `onDuplicateKey`, and `columnTypes`.

It picks the best statement each dialect supports — `UPDATE ... FROM (SELECT ...)` on PostgreSQL/CockroachDB/Redshift/SQLite/MSSQL, `UPDATE ... JOIN` on MySQL/MariaDB, and `MERGE` on Oracle — so there is no need for per-row loops or `CASE` expressions.

- **`mode` — SQL strategy** (default `'union'`). Three forms, all keyed and chunked the same way; they differ only in how the per-row values reach the database:
  - `'union'` — `UPDATE ... FROM (SELECT ... UNION ALL ...)` / `JOIN` / `MERGE`. Binds one parameter per cell. The portable default.
  - `'case'` — a single `UPDATE ... SET c = CASE WHEN key THEN ? ... END`, universal across dialects. SQL grows with `rows × columns`; `columnTypes` and `returning` don't apply.
  - `'json'` — passes the whole chunk as one JSON parameter expanded by the dialect's JSON-rowset function (`jsonb_to_recordset` / `json_each` / `JSON_TABLE` / `OPENJSON`). Sidesteps the per-parameter ceiling, so it chunks far less; needs an explicit `columnTypes` map on MySQL/MariaDB/MSSQL/Oracle (their JSON-rowset syntax can't infer types). A `Buffer` column auto-splits off to a companion `union`/per-row statement in the same transaction (JSON can't carry binary). Unsupported on Redshift.
- **Uniform shape required.** Every row must carry the key column(s) plus the _same_ set of non-key columns. Ragged rows (a column present on some rows, absent on others) throw, because a single set-based statement applies one SET clause to all rows and a missing column would silently overwrite existing data with `NULL`. Pre-group ragged data by shape.
- **Returns** the per-chunk driver responses, flattened — so on the PostgreSQL family it is an array of one affected-row count per emitted statement (e.g. `[2, 1]` for a 3-row batch chunked at 2). The shape follows the underlying driver and is not uniform across dialects (SQLite, for instance, resolves empty), so don't rely on it for a single total. Use [returning](/guide/query-builder#returning) to get data back; it is opt-in for DB-computed columns, only honored on the PostgreSQL family, and throws on other dialects.
- Large batches are split into chunks of `chunkSize`, each binding one parameter per cell (`rows × columns`). SQL Server's 2100-parameter ceiling leaves 2098 once `sp_executesql` claims two slots, so on MSSQL the effective chunk is automatically reduced to fit (`floor(2098 / columns)`) regardless of `chunkSize`. Other dialects have far higher limits (Postgres 65535, SQLite ≥3.32 32766) — tune `chunkSize` yourself if a single row is very wide.
- **Duplicate keys.** A set-based UPDATE has no defined row order, so two rows sharing a key would be non-deterministic (and Oracle's `MERGE` errors on it). By default the **last** row for a key wins (`options.onDuplicateKey: 'last'`); pass `options: { onDuplicateKey: 'throw' }` to reject duplicates instead.
- **Column casts (Postgres family).** On PostgreSQL/CockroachDB/Redshift the values source is cast from each value's JS type (`number→numeric`, `bigint`, `boolean`, `Date→timestamptz`, `Buffer→bytea`, object→`jsonb`, else `text`). The JS type can't reveal columns like `uuid`, `enum`, arrays, or columns that are all-null in a chunk — for those, pass explicit casts via `options.columnTypes`, e.g. `{ columnTypes: { id: 'uuid', tags: 'text[]' } }`. Each cast is validated as a plain type name and interpolated literally, so `columnTypes` cannot carry arbitrary SQL. `columnTypes` is rejected on non-PostgreSQL dialects, and Redshift (which lacks `bytea`/`jsonb`) throws on those casts unless you override them.

```js
const rows = [
  { id: 1, name: 'Alice', status: 'active' },
  { id: 2, name: 'Bob', status: 'paused' },
];

// matches on the default `id` key
knex
  .batchUpdate('users', rows)
  .then(function () {
    /*...*/
  })
  .catch(function (error) {
    /*...*/
  });

// composite key + an explicit chunk size, inside a caller transaction
knex.transaction(function (tr) {
  return knex
    .batchUpdate('memberships', rows, ['tenant_id', 'user_id'], {
      chunkSize: 500,
    })
    .transacting(tr);
});
```

> On MySQL, if inserting missing rows is acceptable, [`insert(...).onConflict(...).merge()`](/guide/query-builder#onConflict) (`INSERT ... ON DUPLICATE KEY UPDATE`) is an alternative — but it is an upsert, not a pure update.

## now

**knex.fn.now(precision)**

Return the current timestamp with a precision (optional)

```js
table.datetime('some_time', { precision: 6 }).defaultTo(knex.fn.now(6));
```

## uuid

**knex.fn.uuid()**

Return a uuid generation function. Not supported by Redshift

```js
table.uuid('uuid').defaultTo(knex.fn.uuid());
```

## uuidToBin

**knex.fn.uuidToBin(uuid)**

Convert a string uuid (char(36)) to a binary uuid (binary(16))

```js
knex.schema.createTable('uuid_table', (t) => {
  t.uuid('uuid_col_binary', { useBinaryUuid: true });
});
knex('uuid_table').insert({
  uuid_col_binary: knex.fn.uuidToBin('3f06af63-a93c-11e4-9797-00505690773f'),
});
```

## binToUuid

**knex.fn.binToUuid(binaryUuid)**

Convert a binary uuid (binary(16)) to a string uuid (char(36))

```js
const res = await knex('uuid_table').select('uuid_col_binary');
knex.fn.binToUuid(res[0].uuid_col_binary);
```
