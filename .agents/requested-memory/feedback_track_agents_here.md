---
name: feedback_track_agents_here
description: jclaveau/knex — jean ruled to git-track and commit `.agents/` memories here (2026-10-29), now that hhh-dev is the fork's default branch
metadata:
  author: Jean Claveau
  type: feedback
---

`.agents/` is tracked and committed in jclaveau/knex. jean, 2026-10-29: "stop
gitignoring the memories as our default branch is now hhh-dev". Until then
`.agents/` sat in `.git/info/exclude` (local only), so memories never left the box.

**Why:** hhh-dev is the fork's own integration branch
([[project_hhh_dev_default_branch]]), not upstream knex, so the memories can travel
with the repo.

**How to apply:**
- Commit `.agents/` changes with the work they describe, by explicit path.
- Never put `.agents/` in an upstream knex/knex PR: strip it from any branch
  proposed upstream.
- Same bar as everywhere: no credentials or production hostnames in a memory.
