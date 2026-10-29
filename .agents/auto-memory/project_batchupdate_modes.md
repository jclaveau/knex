---
name: project_batchupdate_modes
description: knex.batchUpdate fork — the mode/strategy architecture (union/case/json), columnTypes strategies, per-dialect bind caps (PR #2, RFC)
metadata:
  type: project
---

`knex.batchUpdate(table, rows, key, options)` on this fork (PR #2, an RFC exploration, default branch = `feat/batch-update`). `options` = `{ mode, chunkSize, onDuplicateKey, columnTypes }` (mode listed first).

**mode** — SQL strategy, dispatched in `QueryCompiler#batchUpdate` (base switches on `single.batchUpdate.mode`):
- `union` (default) — `_batchUpdateUnion`, per-dialect: `UPDATE…FROM (SELECT…UNION ALL)` (pg/sqlite/mssql), `JOIN` (mysql), `MERGE…dual` (oracle). Needs pg casts (source params are `unknown`).
- `case` — `_batchUpdateCase` in base, universal `SET c = CASE WHEN key THEN ? … END … WHERE key OR-expanded`. No pg casts (assignment context). SQL grows rows×cols.
- `json` — `_batchUpdateJson`, per-dialect override, one JSON param/chunk: pg/crdb `jsonb_populate_recordset(null::"table", ?)` (types from the table row type: uuid/enum/text[] work; STRICT, 7.5 into int errors; `columnTypes` map/'from_db' REFUSED in json mode on pg+crdb, refusal lives in executor before the columnInfo query; redshift keeps old path/throws), sqlite `json_each(?)`+`UPDATE…FROM`, mysql/mariadb `JSON_TABLE(?,'$[*]' COLUMNS(...))`+JOIN, mssql `OPENJSON(?) WITH(...)`+`UPDATE…FROM`+rowcount, oracle `JSON_TABLE` inside MERGE. Redshift throws (no json-rowset fn). The JSON_TABLE/OPENJSON dialects REQUIRE an explicit `columnTypes` map (typed COLUMNS/WITH list, can't infer — base `_batchUpdateJsonColumnTypes` throws otherwise); path is inlined literal via `_batchUpdateJsonPath` (plain-identifier-only, JSON_TABLE/OPENJSON reject a bound path). pg infers, sqlite typeless.

**columnTypes** (union+json; rejected in case): object `{col:'type'}` | `'from_data'` (infer from JS values, default) | `'from_db'` (one `columnInfo()` query in the update txn → `{col:dbtype}`). Explicit values validated against `SAFE_DB_TYPE` (anti-injection — values interpolated literally into `?::type`). Union+`'from_db'` on pg/crdb: information_schema `data_type` gives `USER-DEFINED`/`ARRAY` (enum → text mismatch, array → `$3::ARRAY` syntax error), so jean ruled: resolve from udt_name/format_type (schema-qualified enum, `text[]`), never drop a type silently — a type failing SAFE_DB_TYPE throws naming column+type.

**pg union casts (5e5c7c11+)**: first row carries casts; all-safe-integer number column → `::bigint` (keeps btree index; `::numeric` forced Seq Scan 3910 vs Index Scan 16.95 on 200k rows), else numeric. 'from_db' casts to the catalog base type WITHOUT length (`"pg_catalog"."varchar"`, so too-long raises 22001 like `.update()`), names read through `customWrapIdentifier`, arrays detected via `typarray` join (int2vector/array domains), catalog aliases underscore-free (postProcessResponse-proof). See [[project_batchupdate_pr11_accepted_exceptions]] for settled rulings.

**Per-dialect bind cap**: each base Client declares `maxBindParameters` (pg/mysql/oracle 65535, sqlite 32766, mssql **2098** — tedious's sp_executesql eats 2 slots); variants inherit. Executor caps chunk by mode-aware per-row param count, min'd with `Client#batchUpdateRowLimit(mode)` (sqlite union→500).

**Binary auto-split**: `mode:'json'` + a Buffer column → executor splits (json for json-able cols + companion `union`/per-row for binary cols, one txn); see [[project_batchupdate_gotchas]]. Project json rows to key+jsonable cols first or the Buffer balloons into the JSON payload.

**Sweet spot / default (RFC conclusion)**: json (with auto-split) is **dominant-or-tied** in the bench — wins big where a param cap forces union to chunk (mssql wide+blob 4.4×, pg 1.4×), ties where union fits one statement (mysql/mariadb 65535) or data movement dominates (oracle per-row, crdb distributed), loses only by a hair on embedded sqlite. PR argues json-as-default-where-available; `union` kept default for now (crdb json slow at scale is the counter-case).

Benchmark: `scripts/batch-update-benchmark.js` (matrix + per-mode/per-dialect charts + blob scenario) → `scripts/batch-update-charts.js` (vega SVG/PNG, [[reference_charts_github_markdown]]) + all-dialect docker-compose CI workflow (informational). See [[project_batchupdate_gotchas]], [[reference_knex_set_based_batch_update]], [[feedback_bench_finds_bugs_gate_them]].
