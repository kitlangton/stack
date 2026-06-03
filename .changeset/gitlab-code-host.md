---
"@kitlangton/stack": minor
---

Add GitLab support. `stack` now talks to GitLab merge requests through the
`glab` CLI alongside GitHub pull requests via `gh`.

- New `CodeHostGitLab.layer` shells out to `glab mr ...` and `glab api` and
  maps GitLab's `iid`, `source_branch`,
  `target_branch`, `web_url`, `description`, and `opened|merged|closed|locked`
  state vocabulary onto the same `PullRef` / `PullMeta` shapes the rest of the
  tool already understands.
- `CodeHostGitLab.memory` mirrors `CodeHostGitHub.memory` for tests.
- `CodeHost` auto-detects exact `github.com` and `gitlab.com` remotes; an
  enterprise host is selected through `git config stack.codeHost`, with
  `STACK_CODE_HOST` available as a temporary override.
- GitLab source projects are normalized for safe repair pushes from fork MRs.
- GitLab MR enumeration decodes paginated API output as NDJSON, and immediate
  merge disables deferred auto-merge so descendant repair only starts after a landed MR.
- GitLab MR target updates use `--yes`, while description replacement and
  auto-merge use `glab api` so repair never pauses for confirmation, can clear
  a description, and reliably requests server-side auto-merge.
- `--admin` is rejected before mutation on GitLab because there is no `glab`
  equivalent of GitHub's admin merge.

Stack orchestration remains code-host independent while preserving scoped repair,
post-repair description refresh, and undo support for fork remote pushes.
