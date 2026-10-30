---
name: project_pg_array_threshold_pr13
description: Issue #10 — PR #13 (arrayParameterThreshold on whereIn) and PR #14 (batchInsert bind-cap chunking, pg overflow error), both merged; settled rulings; null-row insert parked as #15
metadata:
  author: Jean Claveau
  type: project
---

Issue #10 has 3 parts; PR #13 (`feat/pg-array-parameter-threshold`, base `hhh-dev`, worktree `../knex-arraythreshold`) ships ONLY part 1. Parts 2 (batchInsert chunk by distinct keys across whole batch, all dialects) and 3 (named overflow error, Postgres-only: MySQL `query()` has no bind limit) are not in it.

Settled in the PR (do not re-raise):
- Default threshold 1000 is a behaviour change (1001..65535 values now `= any($1)`); escape hatch `arrayParameterThreshold: -1`.
- Unknown option / non-object 3rd arg refused on every dialect though only pg reads it; Redshift refuses invalid client config but ignores valid one.
- `where(col,'in',vals)` has no options arg: uses client config.
- Checks live in `lib/query/in-list-options.js`; logic in `_isArrayParameterList` (`pg-querycompiler.js`).

Review findings (pr-autoreview round 1, in flight):
- 🔴 `assertInListOptions` throws before `_not()`/`_bool()` flags consumed → flag leaks to next clause (`whereNotIn(..,{bogus:1})` caught, then `.where` becomes `not`). Fix: read both flags before throwing. Same in havingIn, onIn.
- 🔴 pre-existing: joinclause `onNotIn('a',[])` early return never reads `_not()`.
- 🟡 types lack `orHavingIn`/`andHavingIn`.
- 🔵 `${options}` with a Symbol throws its own TypeError.

**Why:** CodeRabbit never reviews this fork, so 4b watch is skipped. Integration: pg 17 + CRDB; CRDB returns int as int8 strings, so pluck `text_key`.
**How to apply:** reopening PR #13 review; do not merge without explicit per-PR ask. See [[project_batchupdate_gotchas]].

## Review rulings (2026-10-29, /pr-autoreview 13)
jean ruled: empty onNotIn → `1 = 1` (fixed in this PR, not split out); invalid
arrayParameterThreshold refused on EVERY dialect (base compiler); threshold-0
message says "1 = any list of 2 or more"; Symbol options → String(); any iterable
spread REVERTED (4a50697f): jean — spreading iterables is the consumer's job, do
not re-propose. Default 1000 kept on purpose (behaviour change documented in PR body).
onNotIn fix stays in #13. The 4 nits (1001-key integ case, table drop in finally, docs
section, crdb coverage) fixed in 6540112d + 48b3cf6a.

**Second autoreview rulings (2026-10-29):** A → option b: the threshold is checked in full when the `in` list method is called (JoinClause holds the client, wrapped `on` included); the compile-time base check is gone, and the pg compiler still checks the resolved value. B → keep refusing a stray third arg (`null`, a map index): no silent errors. C → the base Client constructor checks `config.arrayParameterThreshold` against each dialect's `maxBindParameters`. jean then said "merge once done" = explicit merge ask for #13 once CI is green.

**Issue #10 parts 2 + 3 (2026-10-29, after #13 merged as ce9ef367):** pushed as two branches off hhh-dev in worktree `../knex-arraythreshold`, no PR yet (CI only runs on PRs, so Oracle untested):
- `feat/batch-insert-bind-cap` 675b1037: `chunkRowsByBindParameters` in `lib/execution/batch-insert.js`, distinct keys over whole batch; unit `test/unit/batch-insert.js` (transaction stub), integration 1000×70 in inserts.spec (sqlite skipped: 500-term compound select, out of scope). MySQL passes with and without the fix (driver fills values client side).
- `feat/pg-bind-overflow-error` 6e131fb9: pg `positionBindings` throws "N bind parameters exceed the client's maxBindParameters 65535"; runs only at toNative/execution, never toSQL.

**2026-10-30:** issue #10 parts 2+3 merged as PR #14 (merge commit 4e2ff562, CI 46/0), #10 closed. Autoreview rulings: oracledb counts one extra bind per returning column and per Buffer column (client hook `batchInsertRowBindParameters`); a null/non-object row rejects `Invalid batchInsert row N: null`; the pg overflow stays a plain `Error`. Cleanup done 2026-10-30: old branches deleted, worktree `../knex-arraythreshold` removed; core insert truncating at the first null row tracked as jclaveau/knex#15.
