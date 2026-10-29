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
  `JSON_TABLE`, mssql `OPENJSON`. Constant parameter count.

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
| 10000 |    3 | json  |       264 |      5 |      1 |    22.8 |

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

CI run of 0c32392c, with the `'case'` chunk cap of
[PostgreSQL case chunk size](#postgresql-case-chunk-size):

| rows×cols | mode  | SQL bytes | params | chunks | exec ms |
| --------- | ----- | --------: | -----: | -----: | ------: |
| 1000×3    | union |    28,160 |  4,000 |      1 |      39 |
| 1000×3    | case  |    90,121 |  7,000 |      4 |      39 |
| 1000×3    | json  |       153 |  **1** |      1 |  **12** |
| 1000×20   | union |    79,717 | 21,000 |      1 |     106 |
| 1000×20   | case  |   583,600 | 41,000 |     20 |     170 |
| 1000×20   | json  |       462 |  **1** |      1 |  **36** |
| 10000×3   | union |   280,160 | 40,000 |      1 |     387 |
| 10000×3   | case  |   900,121 | 70,000 |     31 |     331 |
| 10000×3   | json  |       153 |  **1** |      1 | **101** |

`columnTypes` overhead (pg, union, 1000×5; pg `json` takes its types from the
row type and refuses `from_db`): `from_data` 9.2ms, `from_db` 16.7ms.

Postgres findings:

- **json wins decisively** — one bound parameter and a flat ~153-byte statement
  regardless of size; ~3.8× faster than `union` and ~3.3× faster than `case` at
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
updates, so a statement costs about rows × columns × chunk: the chunk that runs
fastest holds about 50 branches (rows × columns), whatever the key. The knex
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

`Client_PG#batchUpdateRowLimit` caps a `'case'` chunk at
`floor(CASE_BRANCH_BUDGET / columns)` rows (at least 1), with
`CASE_BRANCH_BUDGET = 1000`, and a composite key's chunk at
`COMPOSITE_CASE_ROWS = 50`. As on SQLite each updated row walks every column's
CASE list, so a wide row wants a short chunk. A composite key's WHERE is an OR
chain that PostgreSQL plans as a BitmapOr of one index scan per row, and its
planning time grows faster than the chain: `EXPLAIN ANALYZE` on a 10000-row
table gives 2.5 ms planning and 2.7 ms execution at 50 rows, 679 ms planning
and 49 ms execution at 1000. That plan needs a table much larger than the
chunk: on an analyzed 2000-row table a 1000-row chunk takes a seq scan with
13 ms planning, so a big chunk only costs on big tables, where it matters.
CockroachDB inherits the cap; Redshift keeps `chunkSize` and the bind cap until
it is measured.

`benchCaseChunkSize` in `batch-update-benchmark.js` prints these tables
(`DB=postgres` / `DB=cockroachdb`, 10000 rows, median wall ms of 3 runs; column
headers are the forced row cap). The integration test "runs a composite-key case
batch fastest at the shipped PostgreSQL chunk" pins the 2 keys × 1 column row,
updating 2000 rows of an analyzed 10000-row table (shipped 50 beats 5 and 1000),
so a PostgreSQL release that changes this fails CI: re-run the sweep and move
the cap.

PostgreSQL (postgres:17):

| keys | cols |    5 |   10 |   25 |   50 |  100 |  250 |  500 |  1000 | shipped cap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ----: | ----------: |
|    1 |    1 | 1689 |  729 |  500 |  404 |  309 |  321 |  271 |   306 |        1000 |
|    1 |    3 | 1841 | 1527 |  815 |  653 |  620 |  557 |  577 |   836 |         333 |
|    1 |   10 | 3502 | 2437 | 1836 | 1617 | 1555 | 1710 | 2148 |  2660 |         100 |
|    2 |    1 | 2133 | 1567 | 1298 | 1265 | 1725 | 1908 | 1901 |  5972 |          50 |
|    2 |    3 | 2666 | 2226 | 1809 | 1958 | 1910 | 2329 | 3878 |  6645 |          50 |
|    2 |   10 | 4944 | 4060 | 3831 | 3520 | 3676 | 4740 | 6535 | 10851 |          50 |

CockroachDB:

| keys | cols |     5 |    10 |    25 |    50 |   100 |   250 |   500 |  1000 | shipped cap |
| ---: | ---: | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----------: |
|    1 |    1 | 13312 |  7523 |  3680 |  2588 |  2331 |  1927 |  1743 |  2006 |        1000 |
|    1 |    3 | 11755 |  8225 |  4081 |  3083 |  3077 |  3696 |  3734 |  4901 |         333 |
|    1 |   10 | 10977 |  8342 |  7535 |  6686 |  6443 |  6448 |  7789 | 10822 |         100 |
|    2 |    1 | 11218 |  6593 |  5210 |  3611 |  3993 |  4143 |  3870 |  5168 |          50 |
|    2 |    3 | 12996 |  7614 |  6287 |  8075 |  6487 |  6697 |  7289 |  7933 |          50 |
|    2 |   10 | 19586 | 12598 | 14780 | 10932 | 12150 | 14394 | 17227 | 25052 |          50 |
