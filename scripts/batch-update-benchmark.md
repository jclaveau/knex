# batchUpdate strategy tradeoffs (RFC data)

`knex.batchUpdate(table, rows, key, { mode })` can compile the same per-row
update three ways. This is the data behind the RFC discussion of which should
be the default. Reproduce with:

```
node scripts/batch-update-benchmark.js            # sqlite3, in-memory (all 3 modes)
node scripts/batch-update-benchmark.js pg         # set PG_URL
```

## Cross-dialect summary

One curve per mode, every dialect folded in. Absolute exec ms can't be averaged
across dialects — embedded SQLite and a networked Oracle/CockroachDB live on
different scales, so a raw mean just tracks the slowest engine. Instead each
mode's exec ms is normalized to **that dialect's own `union` baseline** at the
same row count, then aggregated with the **geometric mean** of the ratios (the
right central tendency for normalized/multiplicative numbers, and invariant to
which mode is the reference). The shaded band is the geometric standard
deviation — the spread across dialects, so a mode that wins big on one engine and
ties on another reads honestly instead of collapsing to a single line.

![exec ms vs union baseline, geomean across dialects](https://raw.githubusercontent.com/jclaveau/knex/feat/batch-update/scripts/bench-charts/mode-aggregate-ms.png)

_Type detection is excluded as a one-time, cacheable cost._ Every mode times the
"types already known" steady state: union and json pass pre-resolved column types
(as a caller would cache and reuse), so neither the `from_db` schema lookup
(`columnInfo()`, one round-trip) nor the per-batch `from_data` cast inference is
charged to the curve.

`1.0` is `union` (its own baseline); below the line is faster. `json` sits at
0.22–0.29× union from 1000 rows up and 0.53–0.93× below; `case` stays near 1.0
(0.79–1.22×) at every size.

## What each mode emits

- **union** (default) — `UPDATE … FROM (SELECT … UNION ALL …) v WHERE t.k = v.k`
  (pg/sqlite/mssql), `UPDATE … JOIN (derived)` (mysql), `MERGE … FROM dual`
  (oracle). One value bound per cell.
- **case** — `UPDATE … SET c = CASE WHEN k THEN ? … END … WHERE k IN-expanded`.
  One universal statement, every dialect. Values sit in assignment context, so
  **no Postgres casts**.
- **json** — the whole chunk rides as **one** JSON parameter, expanded server
  side: pg `jsonb_populate_recordset(null::<table>, ?)` (typed by the table's
  row type), sqlite `json_each(?)` + `UPDATE … FROM`, mysql/mariadb/oracle
  `JSON_TABLE`, mssql `OPENJSON`. Constant parameter count per chunk (chunks
  of the default `chunkSize`, 1000 rows).

## Measured — SQLite (in-memory, the one embedded dialect that runs all three)

CI run of 0c32392c, with the union cap of 500 rows and the `'case'` cap of
[SQLite case chunk size](#sqlite-case-chunk-size):

|  rows | cols | mode  | SQL bytes | params | chunks | exec ms |
| ----: | ---: | ----- | --------: | -----: | -----: | ------: |
|   100 |    3 | union |     2,934 |    400 |      1 |     2.4 |
|   100 |    3 | case  |     9,121 |    700 |      7 |     4.0 |
|   100 |    3 | json  |       264 |      5 |      1 |     2.4 |
|  1000 |    3 | union |    28,134 |  4,000 |      2 |     9.1 |
|  1000 |    3 | case  |    90,121 |  7,000 |     63 |    23.4 |
|  1000 |    3 | json  |       264 |      5 |      1 |     4.2 |
|  1000 |   20 | union |    79,589 | 21,000 |      2 |    23.9 |
|  1000 |   20 | case  |   583,600 | 41,000 |    500 |   125.5 |
|  1000 |   20 | json  |     1,127 |     22 |      1 |    24.7 |
| 10000 |    3 | union |   280,134 | 40,000 |     20 |    53.0 |
| 10000 |    3 | case  |   900,121 | 70,000 |    625 |   158.5 |
| 10000 |    3 | json  |       264 |      5 |     10 |    22.8 |

## Findings

- **json wins at scale.** SQL size and parameter count are _constant in the
  row count_ (one JSON param plus the `json_extract` paths), so it sidesteps
  every per-statement limit: 10000×3 runs in 22.8 ms vs 53.0 ms `union` and
  158.5 ms `case`. At 1000×20 it ties `union` (24.7 ms vs 23.9 ms).
- **case grows with width.** Its SQL grows as `rows × columns` and re-binds
  the key in every branch, so 1000×20 is 583KB / 41k params, run as 500
  two-row chunks. Its only wins are no per-dialect dispatch, no Postgres casts
  and raw values that read the target row.
- **union is bounded by more than bind parameters.** SQLite's
  `SQLITE_MAX_COMPOUND_SELECT` (500 UNION terms) trips well before the bind
  limit, so `Client_SQLite3#batchUpdateRowLimit` caps a union chunk at 500
  rows.
- **case hits expression-depth limits too** (`SQLITE_MAX_EXPR_DEPTH`): a
  composite key's OR-joined WHERE deepens with every row, which the `'case'`
  chunk cap keeps far below the limit.

## Measured — PostgreSQL (CI service, postgres:17)

Postgres has no small compound-SELECT cap, so `union` runs at every size here —
which lets the three be compared head to head.

CI run of 0c32392c, under the earlier `'case'` cap of `floor(1000 / columns)`
rows (now [250 rows](#postgresql-case-chunk-size)):

| rows×cols | mode  | SQL bytes | params | chunks | exec ms |
| --------- | ----- | --------: | -----: | -----: | ------: |
| 1000×3    | union |    28,160 |  4,000 |      1 |      39 |
| 1000×3    | case  |    90,121 |  7,000 |      4 |      39 |
| 1000×3    | json  |       153 |  **1** |      1 |  **12** |
| 1000×20   | union |    79,717 | 21,000 |      1 |     106 |
| 1000×20   | case  |   583,600 | 41,000 |     20 |     170 |
| 1000×20   | json  |       462 |  **1** |      1 |  **36** |
| 10000×3   | union |   280,160 | 40,000 |     10 |     387 |
| 10000×3   | case  |   900,121 | 70,000 |     31 |     331 |
| 10000×3   | json  |       153 |  **1** |     10 | **101** |

`columnTypes` overhead (pg, union, 1000×5; pg `json` takes its types from the
row type and refuses `from_db`): `from_data` 9.2ms, `from_db` 16.7ms.

Postgres findings:

- **json wins decisively** — one bound parameter and a flat ~153-byte statement
  per 1000-row chunk, whatever the row width; ~3.8× faster than `union` and ~3.3× faster than `case` at
  10000×3. (Note: pg json binds **1** param vs sqlite's 5 — sqlite also binds the
  `json_extract` path strings.)
- **union is solid on pg** (no compound-SELECT limit) but grows linearly — 280KB
  / 40k params at 10000×3.
- **case is the largest by far** (900KB at 10000×3). Chunked at its measured
  cap it overtakes `union` at 10000×3 (331 ms vs 387 ms) but stays the slowest on
  wide rows (1000×20: 170 ms vs 106 ms).
- **`from_db` costs a real round-trip on pg** (~7.5ms, ~80% over `from_data`
  here) — fine as an opt-in, never something to put on the default path.

## columnTypes strategies (union + json)

`columnTypes` decides where the per-column DB types come from (used by `union`'s
Postgres casts and the `JSON_TABLE`/`OPENJSON` column list of `json` mode;
pg `json` reads the table's row type instead):

- **object** `{ id: 'uuid' }` — explicit; unlisted columns fall back to `from_data`.
- **`'from_data'`** (default) — infer from the JS values. Free, but blind to
  `uuid`/`enum`/all-null columns.
- **`'from_db'`** — read real types via one `columnInfo()` query, inside the
  update transaction. Correct for the cases inference can't see, at the cost of
  a round-trip.

Measured (SQLite, json, 1000×5): `from_data` ~7.8ms, `from_db` ~9.2ms — the
`columnInfo` round-trip adds ~1–2ms locally; over a networked DB it costs one
extra latency. `from_db` still can't see array element types (`columnInfo`
reports the bare `ARRAY`), so array columns may need the explicit object.

## Limitations matrix

| mode  | dialects implemented                       | Postgres casts?               | per-row params          | extra limits                                                   |
| ----- | ------------------------------------------ | ----------------------------- | ----------------------- | -------------------------------------------------------------- |
| union | all 7                                      | needed (unknown-typed source) | keys + columns          | compound-SELECT / MERGE source term caps                       |
| case  | all 7 (universal SQL)                      | none (assignment context)     | columns×(keys+1) + keys | expression-tree depth; SQL size = rows×columns                 |
| json  | all but redshift (no JSON-rowset function) | none (row type / column list) | 1 per chunk             | values must be JSON-serializable (no Buffer; bigint as string) |

## Tentative recommendation (for discussion)

- Keep **union** as the portable default (works everywhere, linear in rows).
- Offer **json** as the high-throughput path — at 3 columns it is the fastest
  mode from 1000 rows up on every dialect, at 1000×20 within 11% of `union` on
  MySQL, MariaDB and SQLite, and it removes the cast machinery.
- Treat **case** as a niche fallback (cast-free, single dialect-agnostic
  statement, raw values that read the target row) but warn against it for wide
  tables.

## SQLite case chunk size

`Client_SQLite3#batchUpdateRowLimit` caps a `'case'` chunk at
`floor(CASE_BRANCH_BUDGET / columns)` rows (at least 1), with
`CASE_BRANCH_BUDGET = 50`. SQLite walks each column's CASE list for every row it
updates, so a statement costs about rows × columns × chunk: from 10 columns up
the chunk that runs fastest holds about 50 branches (rows × columns), whatever
the key; on 1 to 3 columns the timings are close and the best chunk lies
between 10 and 100 rows. The knex
compile cost is flat (~100 ms per 2000 rows at every chunk size); the rest is
SQLite's evaluation. A cap that small also keeps a composite key's OR-joined
WHERE, rows + keys + 1 deep, under `SQLITE_MAX_EXPR_DEPTH` (1000).

`benchCaseChunkSize` in `batch-update-benchmark.js` prints this table
(`DB=sqlite3`, `:memory:`, 2000 rows, median process CPU ms of 5 runs; column
headers are the forced row cap). The integration test "runs a case batch
fastest at the shipped SQLite chunk" pins the 2 keys × 10 columns row (shipped
5 beats 1 and 50), so a SQLite release that changes this fails CI: re-run the
sweep and move the budget.

| keys | cols |    1 |    2 |    5 |   10 |   20 |   50 |   100 | shipped cap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ----: | ----------: |
|    1 |    1 |  262 |  125 |   70 |   37 |   33 |   28 |    22 |          50 |
|    1 |    3 |  291 |  133 |   78 |   77 |   73 |   57 |    64 |          16 |
|    1 |   10 |  355 |  241 |  193 |  223 |  194 |  251 |   418 |           5 |
|    1 |   20 |  577 |  411 |  361 |  412 |  480 |  826 |  1521 |           2 |
|    2 |    1 |  259 |  148 |   81 |   69 |   78 |   95 |    53 |          50 |
|    2 |    3 |  285 |  201 |  156 |  142 |  120 |  197 |   211 |          16 |
|    2 |   10 |  491 |  394 |  382 |  374 |  504 |  843 |  1433 |           5 |
|    2 |   20 |  861 |  857 |  726 |  926 | 1558 | 3052 |  5416 |           2 |
|    3 |    1 |  221 |  151 |  103 |  142 |   85 |   86 |    87 |          50 |
|    3 |    3 |  312 |  230 |  196 |  174 |  176 |  247 |   335 |          16 |
|    3 |   10 |  671 |  533 |  483 |  692 |  876 | 1622 |  3122 |           5 |
|    3 |   20 | 1046 | 1087 | 1332 | 1754 | 2793 | 6322 | 11894 |           2 |

## PostgreSQL case chunk size

`Client_PG#batchUpdateRowLimit` caps a single-key `'case'` chunk at
`SINGLE_KEY_CASE_ROWS = 250` rows and a composite key's chunk at
`COMPOSITE_CASE_ROWS = 50`. Unlike SQLite, the fastest single-key chunk doesn't
shrink with the column count: from 1 to 10 columns it stays between 50 and 500
rows. Over this sweep and four earlier ones (CI run of 0c32392c, and local runs
in ascending, descending and fresh-table cap order), 250 comes within 12% of the
best cap in 13 of the 15 rows, `floor(1000 / columns)` in 10 and 500 in 8. Reruns
of one sweep swing a row by up to 45% (1 column at cap 250: best, then 465 vs
321 ms for cap 500), so no flat cap beats that spread.
A composite key's WHERE is an OR chain that PostgreSQL plans as a BitmapOr of one
index scan per row, and its planning time grows faster than the chain:
`EXPLAIN ANALYZE` on a 10000-row table gives 2.5 ms planning and 2.7 ms
execution at 50 rows, 679 ms planning and 49 ms execution at 1000. That plan
needs a table much larger than the chunk: on an analyzed 2000-row table a
1000-row chunk takes a seq scan with 13 ms planning, so a big chunk only costs
on big tables, where it matters. CockroachDB inherits both caps: on it 50, 100
and 250 rows come within noise of each other (worst ratio to the best cap 1.25
to 1.36 for each, single key and composite). Redshift keeps `chunkSize` and the
bind cap until it is measured.

`benchCaseChunkSize` in `batch-update-benchmark.js` prints these tables
(`DB=postgres` / `DB=cockroachdb`, 10000 rows, median wall ms of 3 runs; column
headers are the forced row cap). Each cap runs on a freshly seeded, analyzed
table after one discarded run: on one shared table the dead rows of the earlier
caps slowed the later ones (2 keys × 1 column at cap 1000 took 5820 ms after the
small caps vs 1911 ms run first). The integration test "runs a composite-key case batch fastest
at the shipped PostgreSQL chunk" pins the 2 keys × 1 column row, updating 2000
rows of an analyzed 10000-row table (shipped 50 beats 5 and 1000), so a
PostgreSQL release that changes this fails CI: re-run the sweep and move the
cap.

PostgreSQL (postgres:17, local docker):

| keys | cols |    5 |   10 |   25 |   50 |  100 |  250 |  500 | 1000 | shipped cap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ----------: |
|    1 |    1 | 1569 |  931 |  751 |  527 |  435 |  465 |  321 |  337 |         250 |
|    1 |    3 | 1804 | 1248 |  824 |  761 |  968 |  644 |  578 |  683 |         250 |
|    1 |   10 | 2889 | 2695 | 1772 | 1456 | 1763 | 1573 | 1836 | 2166 |         250 |
|    2 |    1 | 2181 | 1408 | 1247 | 1066 | 1310 | 1799 | 3021 | 5159 |          50 |
|    2 |    3 | 3085 | 2219 | 1596 | 1506 | 1562 | 2410 | 3336 | 5917 |          50 |
|    2 |   10 | 4048 | 3569 | 3049 | 3120 | 3141 | 4557 | 5450 | 9414 |          50 |

CockroachDB (v23.2 single node, 2 GB container on a 2-core i3-4005U):

| keys | cols |     5 |    10 |    25 |    50 |   100 |   250 |   500 |  1000 | shipped cap |
| ---: | ---: | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----------: |
|    1 |    1 |  6114 |  3785 |  2242 |  1940 |  1652 |  2244 |  1825 |  1972 |         250 |
|    1 |    3 | 10000 |  7006 |  4147 |  3229 |  4103 |  4406 |  3849 |  4654 |         250 |
|    1 |   10 | 16586 | 12116 | 12833 | 10661 | 10483 |  9405 | 10449 | 13778 |         250 |
|    2 |    1 | 10826 |  7474 |  5197 |  4395 |  5067 |  4804 |  4044 |  4068 |          50 |
|    2 |    3 | 14048 | 10428 |  7948 |  8491 |  7860 |  7455 |  6849 |  7898 |          50 |
|    2 |   10 | 23852 | 19909 | 22135 | 19925 | 16576 | 16019 | 17207 | 22007 |          50 |
