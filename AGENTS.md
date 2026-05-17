# stack agent notes

## Intent

- `stack` is a small, local-first CLI for stacked PR repair in squash-merge repos.
- Use the latest Effect v4 beta / effect-smol APIs throughout this project.
- Normal editing and commits stay plain git.
- Stack commands are only for stack intent, sync, merge, and undo workflows.

## Safety rules

- `stack sync --dry-run` must stay non-mutating, including scoped and keep-going runs.
- History-rewriting commands need an explicit mutating mode: `--apply`, or `merge --auto` for GitHub auto-merge plus descendant repair.
- Never mutate trunk branches like `dev`, `main`, or `master`.
- Before rebasing a branch, create a local backup branch.
- `stack undo` should restore the last applied mutation from the saved journal.

## Current commands

- `status` shows the relevant tracked stack, including open PR titles when GitHub is available.
- `guide` prints the opinionated happy path for agents and humans.
- `track` records parentage for an existing branch only when PR bases do not already encode the stack.
- `sync --dry-run [branch]` previews GitHub PR-base inference, stale metadata cleanup, and repairs without mutating branches, PRs, or stack metadata using the tree summary output.
- `sync [branch]` is the common safe workflow: remove stale local links, infer clear PR-base stack links, repair branches, retarget PRs, refresh links, and show a concise tree summary. With a branch argument, sync only the stack containing that branch.
- `sync` with no branch scopes to the current stack when the current branch is stack-relevant; when off-stack, it keeps the repo-wide behavior.
- `sync --continue-on-failure` / `sync --keep-going` processes independent stacks, reports succeeded and failed stacks, preserves per-stack cleanup output, and exits nonzero if any stack failed.
- `sync` should not auto-track standalone trunk-root PRs; infer a trunk-root PR only when another open PR is based on it.
- `merge` merges the oldest branch in a stack and immediately repairs descendants; when no branch is given, it infers the root from the current branch. It retargets immediate child PRs before merge to preserve open PRs in auto-delete repos.
- `merge --auto` retargets immediate child PRs, enables GitHub auto-merge, waits for merge, then repairs descendants.
- `merge --auto --through <branch-or-pr>` repeats root auto-merge and descendant repair until the target branch or PR has landed.
- `history` explains the most recent applied sync from the undo journal.
- `undo` restores the last applied sync.

## Implementation notes

- Persist stack metadata in `.git/stack/state.json`.
- Persist undo state in `.git/stack/undo.json`.
- Prefer `Context.Service`-based Effect services and test-first changes.
- Use OpenCode-style service modules for deep seams: export `Interface`, `Service`, and adapters like `layer`, `live`, or `memory`, then import them as namespaces.
- Keep local Git behavior behind `Git` and change-request behavior behind `Forge`. Concrete forge backends live in `services/forge/github.ts` (via `gh`) and `services/forge/gitlab.ts` (via `glab`); the CLI picks the right one at startup from `STACK_FORGE` or the `origin` remote URL. Stack orchestration depends on `Forge.Service` rather than shelling out to a forge CLI directly.
- Check the local Effect source tree when available before changing Effect APIs or versions.
- Prefer `effect/Path`, `effect/FileSystem`, and `effect/unstable/process` instead of Node/Bun built-ins in app code.
- Keep logic literal and debuggable over clever abstractions.
- Default command output should be outcome-oriented: show the stack tree and changed/failed branches, not internal phases like fetch/inspect/reconcile.

## Verification

- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run format:check` and `bun run lint` when formatting or lint config is present.
- When changing CLI docs or behavior, spot-check `bun src/cli.ts --help` and relevant subcommand help.
