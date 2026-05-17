---
"@kitlangton/stack": minor
---

Add GitLab support. `stack` now talks to GitLab merge requests via the `glab`
CLI exactly as it talks to GitHub via `gh`.

- New `ForgeGitLab.layer` shells out to `glab mr ...` (list / view / merge /
  update / close / create) and maps GitLab's `iid`, `source_branch`,
  `target_branch`, `web_url`, `description`, and `opened|merged|closed|locked`
  state vocabulary onto the same `PullRef` / `PullMeta` shapes the rest of the
  tool already understands.
- `ForgeGitLab.memory` mirrors `ForgeGitHub.memory` for tests.
- `Forge.detect()` recognises github.com, gitlab.com, self-hosted hosts whose
  hostname contains `github` or `gitlab`, supports HTTPS / SSH-URL / scp-style
  remotes, and preserves nested subgroups for GitLab projects.
- The CLI picks the right forge layer at startup: explicit `STACK_FORGE=github`
  or `STACK_FORGE=gitlab` wins, otherwise the remote URL of `origin` is
  parsed, otherwise GitHub is assumed.
- `glab mr merge --auto-merge --squash --yes` is used for auto-merge (the
  current flag; `--when-pipeline-succeeds` is deprecated upstream).
- `--admin` is a no-op for GitLab — there is no `glab` equivalent of GitHub's
  admin merge.

`Stack` orchestration, the on-disk state schema, `Git` plumbing, and every
existing GitHub-targeting test pass unchanged.
