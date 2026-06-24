# batchUpdate strategy tradeoffs (RFC data)

`knex.batchUpdate(table, rows, key, { mode })` can compile the same per-row
update three ways. This is the data behind the RFC discussion of which should
be the default. Reproduce with:

```
node scripts/batch-update-benchmark.js            # sqlite3, in-memory (all 3 modes)
node scripts/batch-update-benchmark.js pg         # set PG_URL
```

## What each mode emits

- **union** (default) — `UPDATE … FROM (SELECT … UNION ALL …) v WHERE t.k = v.k`
  (pg/sqlite/mssql), `UPDATE … JOIN (derived)` (mysql), `MERGE … FROM dual`
  (oracle). One value bound per cell.
- **case** — `UPDATE … SET c = CASE WHEN k THEN ? … END … WHERE k IN-expanded`.
  One universal statement, every dialect. Values sit in assignment context, so
  **no Postgres casts**.
- **json** — the whole chunk rides as **one** JSON parameter, expanded server
  side: pg `jsonb_to_recordset(?)` with a typed column list, sqlite
  `json_each(?)` + `UPDATE … FROM`. Constant parameter count.

## Measured — SQLite (in-memory, the one embedded dialect that runs all three)

|  rows | cols | mode  | SQL bytes | params |                                    exec ms |
| ----: | ---: | ----- | --------: | -----: | -----------------------------------------: |
|   100 |    3 | union |     2,934 |    400 |                                        3.7 |
|   100 |    3 | case  |    10,801 |    700 |                                        8.5 |
|   100 |    3 | json  |       264 |      5 |                                        2.7 |
|  1000 |    3 | union |         — |      — | **ERR: too many terms in compound SELECT** |
|  1000 |    3 | case  |         — |      — |      **ERR: Expression tree is too large** |
|  1000 |    3 | json  |       264 |      5 |                                        5.9 |
|  1000 |   20 | union |         — |      — | **ERR: too many terms in compound SELECT** |
|  1000 |   20 | case  |   600,580 | 41,000 |                                    6,539.6 |
|  1000 |   20 | json  |     1,127 |     22 |                                       74.2 |
| 10000 |    3 | json  |       264 |      5 |                                       72.3 |

(union/case at 10000×3 fail the same way as 1000×3 — omitted.)

## Findings

- **json is the clear winner at scale.** SQL size and parameter count are
  _constant in the row count_ (one JSON param), so it sidesteps every
  per-statement limit. At 1000×20 it is ~88× faster than `case` (74ms vs 6.5s)
  and emits 1.1KB instead of 600KB.
- **case explodes with width.** Its SQL grows as `rows × columns` and re-binds
  the key in every branch, so 1000×20 is 600KB / 41k params. Its only wins are
  no per-dialect dispatch and no Postgres casts.
- **union is bounded by more than bind parameters.** Beyond `maxBindParameters`
  it also hits each engine's compound-query limits — SQLite's
  `SQLITE_MAX_COMPOUND_SELECT` (500 UNION terms) trips well before the bind
  limit. The chunk cap currently models only parameters, so the default
  `chunkSize` (1000) overflows union on SQLite. **Follow-up:** model a
  per-dialect compound-select / expression-depth cap the same way
  `maxBindParameters` is modelled.
- **case hits expression-depth limits too** (`SQLITE_MAX_EXPR_DEPTH`), so it is
  not a free "universal" escape hatch for large batches either.

## Measured — PostgreSQL (CI service, postgres:16)

Postgres has no small compound-SELECT cap, so `union` runs at every size here —
which lets the three be compared head to head.

| rows×cols | mode  | SQL bytes | params | exec ms |
| --------- | ----- | --------: | -----: | ------: |
| 1000×3    | union |    28,161 |  4,000 |      36 |
| 1000×3    | case  |   107,101 |  7,000 |      59 |
| 1000×3    | json  |       179 |  **1** |   **8** |
| 1000×20   | union |    79,718 | 21,000 |      98 |
| 1000×20   | case  |   600,580 | 41,000 |     272 |
| 1000×20   | json  |       685 |  **1** |  **21** |
| 10000×3   | union |   280,161 | 40,000 |     289 |
| 10000×3   | case  | 1,070,101 | 70,000 |   1,201 |
| 10000×3   | json  |       179 |  **1** |  **77** |

`columnTypes` overhead (pg, json, 1000×5): `from_data` 9.2ms, `from_db` 16.7ms.

Postgres findings:

- **json wins decisively** — one bound parameter and a flat ~179-byte statement
  regardless of size; ~3.7× faster than `union` and ~16× faster than `case` at
  10000×3. (Note: pg json binds **1** param vs sqlite's 5 — sqlite also binds the
  `json_extract` path strings.)
- **union is solid on pg** (no compound-SELECT limit) but grows linearly — 280KB
  / 40k params at 10000×3.
- **case is the slowest everywhere** and the largest by far (1MB at 10000×3).
- **`from_db` costs a real round-trip on pg** (~7.5ms, ~80% over `from_data`
  here) — fine as an opt-in, never something to put on the default path.

## columnTypes strategies (union + json)

`columnTypes` decides where the per-column DB types come from (used by `union`'s
casts and `json`'s column-definition list):

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

| mode  | dialects implemented                                                             | Postgres casts?               | per-row params          | extra limits                                                   |
| ----- | -------------------------------------------------------------------------------- | ----------------------------- | ----------------------- | -------------------------------------------------------------- |
| union | all 7                                                                            | needed (unknown-typed source) | keys + columns          | compound-SELECT / MERGE source term caps                       |
| case  | all 7 (universal SQL)                                                            | none (assignment context)     | columns×(keys+1) + keys | expression-tree depth; SQL size = rows×columns                 |
| json  | pg, sqlite (mysql/mssql/oracle = JSON_TABLE/OPENJSON TODO; redshift unsupported) | none (typed column list)      | 1 per chunk             | values must be JSON-serializable (no Buffer; bigint as string) |

## Tentative recommendation (for discussion)

- Keep **union** as the portable default (works everywhere, linear in rows).
- Offer **json** as the high-throughput path on Postgres (and SQLite) — it is
  dramatically better for large/wide batches and removes the cast machinery.
- Treat **case** as a niche fallback (cast-free, single dialect-agnostic
  statement) but warn against it for wide tables.
- Before any of these is safe at large `chunkSize`, the chunker needs the
  compound-select / expression-depth caps noted above.
