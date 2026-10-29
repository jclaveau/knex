---
name: project_hhh_dev_default_branch
description: jclaveau/knex fork — hhh-dev is the default branch (upstream master + PR #1 + PR #2 merged --no-ff), CI triggers, CodeQL not starting, no build needed
metadata:
  author: Jean Claveau
  type: project
---

`hhh-dev` = default branch of jclaveau/knex since 2026-10-24 (was `feat/batch-update`). Built from **upstream knex/knex master** (3.3.0, `e25d54bc`), not the fork's stale master; then `git merge --no-ff` of `feat/drop-index-if-exists` (PR #1, closed, re-opened upstream as knex/knex#6473 — gh can't merge a closed PR) and `feat/batch-update` (PR #2, left open with base master, not retargeted). Re-merge `feat/batch-update` into hhh-dev with `--no-ff` after new commits there, then push hhh-dev. Downstream (jclaveau/directus#631) pins hhh-dev's sha.

- Consumers install `github:jclaveau/knex#hhh-dev`: **no build needed** (plain JS, `lib/dialects/index.js` committed, types hand-written, no prepare/postinstall).
- CI: workflows only triggered on `master`; commit `8d174624` added `hhh-dev` to push/pull_request triggers of 5 workflows. Unit/Lint/Coverage/CI(37 jobs) green on it. **CodeQL never started** on hhh-dev (cause unknown: file parses, state active, default setup not-configured; last run 2026-08-30; uses deprecated `codeql-action@v2`). Proposed (not done): bump to v3 + `workflow_dispatch`.
- Worktree for the merge lacks node_modules: symlink the main tree's ([[reference_agent_worktree_no_node_modules]]).
- Always `-R jclaveau/knex` with gh ([[reference_gh_pr_merge_fork_parent_repo]]).

**Why:** jean's explicit per-step go covered only: create/push hhh-dev, merge #1+#2, change default branch; pushes/merges on the fork stay jean's call (a peer session relays the go). Auto-mode classifier blocked push + default-branch PATCH; jean ran them with `! cmd`. If blocked, stop and report, don't work around.
**How to apply:** treat hhh-dev as the integration branch; never touch fork master or open upstream PRs without a fresh ask. See [[project_batchupdate_modes]].
