---
name: project_batchupdate_bench_chart_regen
description: knex batchUpdate — how to regenerate the committed bench charts/data from a fresh all-dialect CI run
metadata:
  type: project
---

Regenerating `scripts/bench-charts/*` (data.json + SVGs + PNGs) for the
batchUpdate bench ([[project_batchupdate_modes]]) — the committed charts are a
snapshot, not built by any single CI job:

1. Push the bench change; the `batchUpdate Benchmark` workflow runs one job per
   dialect (matrix: postgres mysql mariadb mssql cockroachdb oracledb sqlite3),
   each printing a `<!-- batch-update-bench-json {...} -->` block to its log.
2. Collect the 7 blocks from the **job logs via REST** (`gh run view <run> --json
   jobs`, then `curl .../actions/jobs/<id>/logs` with `gh auth token` — `gh run
   view --log` returns 0 bytes for completed jobs, [[feedback_gh_job_logs_via_curl]]).
   Extract the line after the marker, strip the leading `…Z ` log timestamp.
3. Concatenate into `data.json` in the existing dialect order
   (postgres,mysql,mariadb,mssql,oracledb,cockroachdb,sqlite3), `prettier --write`
   it (CI lints data.json).
4. `NODE_PATH=/tmp/vegadeps/node_modules node scripts/batch-update-charts.js
   scripts/bench-charts/data.json scripts/bench-charts` (vega/vega-lite are not
   repo deps — `npm install --prefix /tmp/vegadeps vega@5 vega-lite@5` once).
5. SVG→PNG with **inkscape** `--export-type=png --export-width=1451` (matches the
   existing PNG width); GH markdown won't render raw SVG ([[reference_charts_github_markdown]]).
6. After committing, **repin the chart image SHAs in the PR #2 body** to the new
   commit (`raw.githubusercontent.com/jclaveau/knex/<sha>/scripts/bench-charts/…`)
   via REST PATCH — `gh pr edit` dies on this repo's classic Projects
   ([[feedback_gh_issue_view_quirk]]).

bash assoc-arrays / `${!a[@]}` need a `bash <<'SCRIPT'` heredoc — zsh chokes
([[feedback_zsh_bash_tool_quirks]]). The bench workflow is informational
(`continue-on-error`, never gates).
