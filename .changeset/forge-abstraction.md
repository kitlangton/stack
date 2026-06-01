---
"@kitlangton/stack": minor
---

Introduce the `Forge` seam: the abstract pull/merge-request service layer that
GitHub support now sits behind. This is a refactor with no behaviour change for
the CLI — the same `gh` shell-outs are made, the same data flows through, and
every existing test passes unchanged.

For library consumers, the public surface changes:

- `GitHub` namespace export is removed; use `Forge` (interface, service, URL
  helpers) and `ForgeGitHub` (live + memory layers) instead.
- `GitHubError` and `GitHubDecodeError` are renamed to `ForgeError` and
  `ForgeDecodeError`. `ForgeDecodeError` now carries a `tool` field so its
  message is accurate for any forge (`gh`, `glab`, ...).
- `StackConfig.layer({ githubConcurrency, githubWaitIntervalMillis })` is
  renamed to `{ forgeConcurrency, forgeWaitIntervalMillis }`.

This unblocks a second forge backend (GitLab merge requests via `glab`) without
touching `Stack` orchestration, `Git` plumbing, or the on-disk state schema.
