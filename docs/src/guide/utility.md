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

**knex.batchUpdate(tableName, rows, key, chunkSize, options)**

The `batchUpdate` utility updates many rows with **different per-row values** in a single set-based statement per chunk, wrapped in a transaction _(automatically created unless explicitly given one using [transacting](/guide/query-builder#transacting))_. Each row is matched to an existing row by `key`, which defaults to `'id'` and may be an array for a composite key. The default `chunkSize` is 1000.

It picks the best statement each dialect supports — `UPDATE ... FROM (SELECT ...)` on PostgreSQL/CockroachDB/Redshift/SQLite, `UPDATE ... JOIN` on MySQL/MariaDB/MSSQL, and `MERGE` on Oracle — so there is no need for per-row loops or `CASE` expressions.

- **Uniform shape required.** Every row must carry the key column(s) plus the _same_ set of non-key columns. Ragged rows (a column present on some rows, absent on others) throw, because a single set-based statement applies one SET clause to all rows and a missing column would silently overwrite existing data with `NULL`. Pre-group ragged data by shape.
- **Returns** the affected-row counts (not identities — the caller already supplies every key). [returning](/guide/query-builder#returning) is opt-in for DB-computed columns and is only honored on the PostgreSQL family; it throws on other dialects.
- Large batches are split into chunks of `chunkSize`; keep that in mind against the SQLite (~999) and MSSQL (2100) bind-parameter limits.
- **Duplicate keys.** A set-based UPDATE has no defined row order, so two rows sharing a key would be non-deterministic (and Oracle's `MERGE` errors on it). By default the **last** row for a key wins (`options.onDuplicateKey: 'last'`); pass `options: { onDuplicateKey: 'throw' }` to reject duplicates instead.
- **Column casts (Postgres family).** On PostgreSQL/CockroachDB/Redshift the values source is cast from each value's JS type (`number→numeric`, `bigint`, `boolean`, `Date→timestamptz`, `Buffer→bytea`, object→`jsonb`, else `text`). The JS type can't reveal columns like `uuid`, `enum`, arrays, or columns that are all-null in a chunk — for those, pass explicit casts via `options.columnTypes`, e.g. `{ columnTypes: { id: 'uuid', tags: 'text[]' } }`.

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
    .batchUpdate('memberships', rows, ['tenant_id', 'user_id'], 500)
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
