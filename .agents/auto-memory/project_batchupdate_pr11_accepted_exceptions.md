---
name: project_batchupdate_pr11_accepted_exceptions
description: jclaveau/knex PR #11 (feat/batch-update → hhh-dev, successor of closed #2) — design rule, settled review points NOT to re-raise, open item 31, per-DBMS issues #5-#9
metadata:
  author: Jean Claveau
  type: project
---

PR #11 replaces #2 (closed with pointer comment, jean: "so we stop messing with this work"). Knex PRs target `hhh-dev`, never master. Latest head 2d9b80f9. Never merge without per-PR ask. CodeRabbit is NOT active on this fork → no re-review to watch; PR has 0 threads/reviews.

**Design rule (jean-approved after "align with knex's global design")**: batchUpdate must behave like one `.where(key).update(rest)` per row; where set-based SQL can't, it REFUSES loudly, never differs silently. Knex binds values as-is, lets the DB decide, refuses only what it can't compile, treats Raw as a value, never casts/dedupes. Test for any finding: "differs from `.update()` per row AND silent?" — loud DB-limit errors (oracle ORA-01461, mixed JS types) = expected, document only.

**Settled — do NOT re-raise**
- null/undefined key → refused (not `is null`: a key identifies one row). Key column mixing JS types (`1` and `'1'`) → refused, no String() normalisation.
- Raw/subquery/function in `json` mode → refused (also nested, walked like JSON.stringify: follows toJSON, skips functions). union/case carry it, cast as `(raw)::type` when a type is known.
- Buffer key in `json` → reroute to union (catalog types), same quiet reroute as Buffer columns.
- #23 pre-stringified JSON string in json mode: docs only (Directus keeps json fields out of json batches).
- Out-of-range int4/smallint key (`3e9`) silently matches 0 rows: docs only (pg 17: `[0]` vs 22003; CRDB `integer` is int8 so no difference). A catalog query per batch rejected.
- Item 30 (mysql json + Buffer key + 'from_db' no longer validates columns): accepted, types were never used. Item 36 try/catch test style: kept. json raw guard stricter than the reroute, `'t\tas\tx'` alias regex: dropped (loud).
- Redshift 'from_db' fails loudly (no `typarray`, PG 8.0.2 pg_type): comment on #9, unverified.
- Oracle Buffer key json=per-row vs union/case=MERGE inconsistency: comment on #7, needs live oracledb.
- Key identity (28 A, 32 A): array/plain-object single key → JSON with sorted properties; class instance/Raw/QueryBuilder key → by reference.

- Finding 31 A DONE (bafabb95): raw/subquery/class instance in a COMPOSITE key → bare numeric reference id (no tag); Date/Buffer/array/plain stay by value.
- `case` mode is NOT deprecated (jean asked, then chose B after data): slower than json everywhere since the 0c32392c CI run (crdb 50000×3: json 1.35 s, case 5.8 s, union 129 s; the old "15× faster on crdb" claim is gone), still beats union on pg/crdb/oracle large batches, and only mode where a raw reads the target row (`age + 1`). Docs say when to pick it (5e9a85b4). Do not re-propose deprecation.
- SQLite composite-key `case`: WHERE is an OR chain, expr depth = rows + keys + 1, limit 1000 → default chunk 1000 failed. Fixed via `batchUpdateRowLimit(mode, keyCount)`; single-key case unaffected (flat IN). Cap first 500 (13426d9a), then jean ruled "go for the faster the bench says": small cap (<25 optimal per bench sweep), pinned by a test, comment links the bench. Reading the runtime depth limit REJECTED (no driver API; error-text probe not worth it).

- Autoreview 2026-10-29, jean ruled A on all three: (1) `SAFE_DB_TYPE` = one name word + `(n,m)` + fixed type-keyword list (c9638203). (2) pg union never casts a raw by an INFERRED type, only columnTypes/'from_db'; inferred cast moves to the column's first bound value; CRDB now throws "unsupported binary operator" on `? * 1.5` among ints instead of rounding — accepted as loud (21359198). (3) empty batch compiles once so `.returning()` refusals match non-empty (f5c18f68). Kept as is: sqlite+pg timing tests flake risk (pg one also runs on pgnative).

- Autoreview round 2 (2026-10-29): fixed e487fe11 (null uncast before a raw), f7aa0130 ('from_db' under postProcessResponse names), f4b004a2 (bench chunk counts, docs). Rulings, done in bf3e280c: #1 A Uint8Array = binary (`ArrayBuffer.isView`); #4 A Infinity/NaN in composite/array/object key → refused; #8 go `(max)`, `(n char|byte)`; #11 A `\` refused in quoted type. Still open: #5 `'last'` drops an earlier duplicate's column (jean: undefined ≠ null; merge per column proposed); #12 ruled A over the whole file: the PR's batchUpdate integration tests assert raw rows, an `if (isCockroachDB)` / `if (isPgBased)` (count) picks the literal; upstream `assertNumber` tests near l.200 left alone.

**OLD OPEN**: tuning the SQLite composite-case cap from the small-cap bench sweep (keys × columns grid, CPU median) — in progress at handoff; check `git log` for the final value.

Per-DBMS out-of-scope issues on the fork: #5 MySQL/MariaDB, #6 MSSQL, #7 Oracle, #8 SQLite, #9 CI bench/type tests. Related: [[project_batchupdate_modes]], [[project_hhh_dev_default_branch]].

**Why:** a fresh review session would re-flag these. **How to apply:** check this list before filing a finding on PR #11.
