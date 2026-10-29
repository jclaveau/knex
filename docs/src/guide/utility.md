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
  - `'case'` — a single `UPDATE ... SET c = CASE WHEN key THEN ? ... END`, universal across dialects. SQL grows with `rows × columns`; `columnTypes` and `returning` don't apply. On MySQL, MariaDB, SQLite and MSSQL it is the slowest mode once a batch is large or wide (MySQL, 10000 rows × 3 columns: 586 ms vs 226 ms for `'union'` and 191 ms for `'json'`); on PostgreSQL, CockroachDB and Oracle it beats `'union'` on large batches but not `'json'` (PostgreSQL, 10000 rows × 3 columns: 331 ms vs 387 ms for `'union'` and 101 ms for `'json'`). Pick it when a raw value must read the row being updated: only `'case'` evaluates it against the target row.
  - `'json'` — passes the whole chunk as one JSON parameter expanded by the dialect's JSON-rowset function (`jsonb_populate_recordset` / `json_each` / `JSON_TABLE` / `OPENJSON`). Sidesteps the per-parameter ceiling, so it chunks far less; needs an explicit `columnTypes` map on MySQL/MariaDB/MSSQL/Oracle (their JSON-rowset syntax can't infer types). On PostgreSQL/CockroachDB every column takes its type from the table's row type (`uuid`, `enum`, arrays included), so `columnTypes` is rejected there (only `'from_data'` is accepted). A `Buffer` (or `Uint8Array`) column auto-splits off to a companion `union`/per-row statement in the same transaction (JSON can't carry binary), and a `Buffer` key runs the whole update as `union` (per row on Oracle, which can't bind a `Buffer` in a set statement); on PostgreSQL/CockroachDB that `union` statement reads the column types from the catalog (one extra query), so a `uuid` or `enum` key still matches. A raw value or a subquery throws: JSON carries data, not SQL — use `'case'`. Unsupported on Redshift.
- **Uniform shape required.** Every row must carry the key column(s) plus the _same_ set of non-key columns. Ragged rows (a column present on some rows, absent on others) throw, because a single set-based statement applies one SET clause to all rows and a missing column would silently overwrite existing data with `NULL`. Pre-group ragged data by shape.
- **Table and keys.** `tableName` is a table name, optionally schema-qualified (`'public.users'`); an alias (`'users as u'`) or a raw table throws. A `null` or `undefined` key throws: `.where({ id: null })` compiles `is null` and can match many rows, while a key correlates one row. A key column holds one JS type — `1` and `'1'` in the same batch throw, since duplicates are found by JS value.
- **Raw values and subqueries** (`knex.raw()`, `knex.fn.now()`, a query builder or a function building one) are written as SQL, as `.update()` writes them. In `'case'` mode they are evaluated against the row being updated, so `knex.raw('?? + 1', ['age'])` increments it; in `'union'` mode they are evaluated in the values source, which can't see the target row (a self-contained expression like `knex.fn.now()` works) and keep their own type, as in `.update()`: on the Postgres family only a `columnTypes` entry casts them (`(40 + 2)::integer`), never a type inferred from the column's other values, so `knex.raw('? * 1.5', [7])` among integers stays `10.5` (CockroachDB, which types the source from its first row, throws instead); `'json'` mode throws on them.
- **`undefined` values.** A column `undefined` in every row is left out of the `SET` clause, as `.update()` leaves it. A column `undefined` in only some rows throws: one `SET` clause can't leave it unwritten for some rows only — set it to `null` or leave it out of every row.
- **Returns** the per-chunk driver responses, flattened — so on the PostgreSQL family it is an array of one affected-row count per emitted statement (e.g. `[2, 1]` for a 3-row batch chunked at 2). The shape follows the underlying driver and is not uniform across dialects (SQLite, for instance, resolves empty), so don't rely on it for a single total. Use [returning](/guide/query-builder#returning) to get data back; it is opt-in for DB-computed columns, only honored on PostgreSQL and CockroachDB, and throws on other dialects and in `'case'` mode (an empty batch included) and when `Buffer` columns split a `'json'` update across two statements.
- Large batches are split into chunks of `chunkSize`, each binding one parameter per cell (`rows × columns`). SQL Server's 2100-parameter ceiling leaves 2098 once `sp_executesql` claims two slots, so on MSSQL the effective chunk is automatically reduced to fit regardless of `chunkSize`: `floor(2098 / (keys + columns))` rows in `'union'` mode, `floor(2098 / (columns × (keys + 1) + keys))` in `'case'` mode. Other dialects get the same reduction against their own ceiling (65535 on PostgreSQL, MySQL and Oracle, 32766 on SQLite). The count takes one parameter per cell, so a raw or subquery cell that binds values of its own can still overflow the ceiling: lower `chunkSize` for those. On SQLite a chunk is also capped at 500 rows in `'union'` mode (`SQLITE_MAX_COMPOUND_SELECT`), and in `'case'` mode at `floor(50 / columns)` rows (at least 1): SQLite walks every column's CASE list for each row it updates, so a chunk of about 50 branches runs fastest from 10 columns up (on 1 to 3 columns the best chunk lies between 10 and 100 rows), and it keeps a composite key's OR-joined WHERE under `SQLITE_MAX_EXPR_DEPTH` (1000). On PostgreSQL and CockroachDB a `'case'` chunk is capped at `floor(1000 / columns)` rows, and at 50 rows for a composite key, whose OR-joined WHERE takes longer to plan than to run past that; Redshift keeps `chunkSize`.
- **Duplicate keys.** A set-based UPDATE has no defined row order, so two rows sharing a key would be non-deterministic (and Oracle's `MERGE` errors on it). By default the **last** row for a key wins (`options.onDuplicateKey: 'last'`); pass `options: { onDuplicateKey: 'throw' }` to reject duplicates instead. Keys compare by JS value (equal `Date`s or `Buffer`s are one key, and so are `Uint8Array`s with the same bytes, and so are arrays or plain objects with the same JSON, whatever their property order; a class instance, a raw or a subquery key is compared by reference; `Infinity`, `-Infinity` or `NaN` inside a composite, array or object key throws, since JSON writes all three as `null`), so keys the database alone treats as equal — `'abc'` and `'ABC'` under a case-insensitive collation, or a `uuid` in upper and lower case — are not collapsed: both rows reach the same target row, the first one wins in `'case'` mode, and the database picks one otherwise (Oracle's `MERGE` raises ORA-30926).
- **Column casts (Postgres family, `union` mode).** On PostgreSQL/CockroachDB/Redshift the values source is cast from each value's JS type (`number→bigint` when every value in the column is a safe integer (`Number.isSafeInteger`), else `numeric`, `bigint`, `boolean`, `Date→timestamptz`, `Buffer`/`Uint8Array`→`bytea`, object→`jsonb`, else `text`). The JS type can't reveal columns like `uuid`, `enum`, arrays, or columns that are all-null in a chunk — for those, pass explicit casts via `options.columnTypes`, e.g. `{ columnTypes: { id: 'uuid', tags: 'text[]' } }`. Each cast is validated as a type name (one word, an optional `(n[, m])`, `(max)` or `(n char|byte)`, then only type keywords such as `with time zone`, `precision`, `varying`, `unsigned`; or a quoted name without `"`, `?` or `\` inside, optionally behind one schema, optionally `[]`) and interpolated literally, so `columnTypes` cannot carry arbitrary SQL (`'boolean or true'` throws). In `'union'` mode `columnTypes` is rejected on non-PostgreSQL dialects (`'json'` mode needs it there, see above), and Redshift (which lacks `bytea`/`jsonb`) throws on those casts unless you override them. `'from_db'` reads the column names through `wrapIdentifier` and casts to the catalog type without its length or precision (`varchar`, not `varchar(5)`), so a value too long for the column raises as in `.update()` rather than being truncated by the cast. Inferred casts differ from `.update()` in five cases: a fraction written to an integer column is rounded (`1.5` → `2`) where `.update()` raises; a key out of range for its integer key column (`3e9` for an `integer`, `1e19` for a `bigint`) matches no row where `.update()` raises `22003` (on CockroachDB, whose `integer` is a `bigint`, only past `bigint`); a `Date` written to a `timestamp` (without time zone) or `date` column keeps the database session's wall clock where `.update()` keeps Node's, so a `date` can land on the day before or after (the same when both use one time zone); and an object written to a `json` (not `jsonb`) column is stored normalised by its `jsonb` cast (keys sorted, `{"a": 2, "b": 1}`) where `.update()` keeps the text as sent; and a number that is not a safe integer, written to a `text` column, goes through its `numeric` cast, so `1e-7` lands as `'0.0000001'` and `1e21` as `'1000000000000000000000'` where `.update()` stores `'1e-7'` and `'1e+21'`. Use `columnTypes: 'from_db'` or `'case'` mode to avoid all five.
- **Values in Postgres `json` mode.** A `Date`, a `bigint`, `NaN` and `Infinity` go through node-pg's own `prepareValue`, so they reach the row type as the text `.update()` binds (a `Date` in local time with its offset, or UTC under `pg.defaults.parseInputDatesAsUTC`). A finite number stays a JSON number, which jsonb renders in canonical form: `1e-7` lands in a `text` column as `'0.0000001'` where `.update()` stores `'1e-7'`, and `1e21` as `'1000000000000000000000'`. Numeric and jsonb columns get the same value either way; pass a string for a `text` column to keep the JS form. A string in a `json`/`jsonb` column is stored as a JSON string, where `.update()` parses it: pass the object, not `JSON.stringify(object)`.

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
