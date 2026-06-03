# @kitlangton/stack

## 0.3.0

### Minor Changes

- c343c36: Standardize mutating command syntax: bare `stack sync` now previews changes and `stack sync --apply` performs repairs, matching the existing `merge` and `undo` workflows. Clarify the agent-first workflow in the README and bundled stack skill, preserve the ASCII stack logo, and keep the CLI reference as a concise final section.

## 0.2.0

### Minor Changes

- c12b921: Introduce the internal `CodeHost` seam so stack orchestration can operate on
  GitHub pull requests and GitLab merge requests through provider adapters.

  The CLI now selects a provider at startup and uses host-neutral concurrency and
  polling configuration internally. Repair plumbing also records request source
  repositories and pushed remotes so fork-backed repairs can be recreated and
  undone safely. Provider adapters normalize missing historical changes before
  orchestration decides whether to recreate them, and enumerate open changes
  exhaustively so stale-metadata decisions never depend on arbitrary list caps.
  Provider adapters also share one in-memory contract implementation so additional
  hosts can reuse the same lifecycle behavior without copying adapter test seams.
  The new seam names hosted requests as changes internally while preserving the
  existing persisted `pr` keys and exported pull-shaped models for compatibility.
  GitLab source-project enrichment is cached per adapter layer, including concurrent
  lookups for fork-backed requests.

- c12b921: Add GitLab support. `stack` now talks to GitLab merge requests through the
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

### Patch Changes

- c12b921: User-facing polish for code-host-neutral wording.

  - CLI help text, the `guide` command, and the merge failure hint now talk about
    "changes" / "target branches" / "code-host auto-merge" instead of
    "PRs" / "PR bases" / "GitHub auto-merge". GitHub-specific behaviour (admin
    merge) is still called out where it applies.
  - `package.json` description and keywords mention GitLab and merge requests.
  - README, AGENTS.md (and the CLAUDE.md symlink), CONTEXT.md, and the
    `skills/stack/SKILL.md` agent guide document the `CodeHost` seam, the two
    backends (gh + glab), and code-host selection. The skill now shows
    GitLab equivalents in the Happy Path section and notes that `--admin` is
    GitHub-only.
  - Provider adapters normalize missing historical changes so GitLab `404 Not Found`
    responses and GitHub lookup failures trigger the same safe recreation path.

- c12b921: Fix three rendering quirks surfaced by the GitLab smoke test.

  - `stack sync` against a GitLab remote now writes `!1`, `!2`, `!3` in the stack
    block inside each MR description so they render as real merge-request links
    on gitlab.com. Previously the block always used GitHub's `#N` syntax, which
    on GitLab refers to _issues_ — so the references rendered as plain text or
    links to nonexistent issues. The completed-line parser in `stackBlock`
    accepts both `#N` and `!N` so blocks written by either code host are
    preserved on rewrite. The selected `CodeHost` adapter supplies native
    reference rendering, including for explicitly configured enterprise hosts.
  - GitLab stack blocks now include MR titles beside `!N` references, including
    completed history when the MR can still be read, because GitLab only exposes
    the title on hover for bare `!N` autolinks. GitHub keeps the compact `#N`
    format.
  - `stack status` now labels the displayed trunk as the trunk _actually used_
    by the stack (e.g. `main` when the stack lives off `main`) instead of always
    using `cfg.trunks[0]`. The inference falls back to `cfg.trunks[0]` when no
    trunk is referenced as a parent.
  - `stack merge` now reports `would switch to <actual trunk>` and switches to
    the right trunk on apply, instead of unconditionally using `cfg.trunks[0]`.
    Same fix in `stack undo`: the trunk to switch to is inferred from the
    saved `run.state.links`.

  The first item is genuinely GitLab-specific; the other two were pre-existing
  display bugs that affect any repo whose trunk is not `dev`.

- 1b4221c: Scope repair, final merge diagrams, and stack-block refreshes to the selected stack, update blocks for requests recreated during repair, keep sync dry-runs free of fetch mutations, use tracked change identities when fork heads share a branch name, and checkpoint repair mutations so failed merge and sync attempts can be undone safely.
- 1be576f: Limit the final merge repair diagram to the selected stack.
- 5510fb4: Upgrade toolchain: TypeScript 6.0, vitest 4.1, oxlint 1.66, oxfmt 0.51.

## 0.1.5

### Patch Changes

- Scope `stack sync` to the current or requested stack, and add keep-going sync for independent stacks.

## 0.1.4

### Patch Changes

- Improve sync output, remove the public repair command, and add oxlint/oxfmt checks.

## 0.1.3

### Patch Changes

- Add `stack merge --auto --through <branch-or-pr>` for bounded auto-merge ranges.

## 0.1.2

### Patch Changes

- Initial public release.
