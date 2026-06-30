# stack agent notes

## Intent

- `stack` is a small, local-first CLI for stacked PR/MR repair in squash-merge repos.
- Use the latest Effect v4 beta / effect-smol APIs throughout this project.
- Normal editing and commits stay plain git.
- Stack commands are only for stack inspection, intent, sync, merge, and undo workflows.

## Safety rules

- Bare `stack sync` must stay non-mutating, including scoped and keep-going runs.
- Mutating commands need an explicit mode: `--apply`, or `merge --auto` for code-host auto-merge plus descendant repair.
- Never mutate configured trunk branches like `dev`, `main`, or `master`.
- Before rebasing a branch, create a local backup branch.
- Before repair mutates Git or a hosted change, save an undo checkpoint. Merge child retargets use a pre-merge recovery journal; after the root lands, descendant repair starts from a post-merge baseline that never retargets children back onto the landed branch.
- `stack undo` should restore the last applied mutation from the saved journal.

## Current commands

- `status` shows the relevant tracked stack, including open change titles when the code host is available.
- `guide` prints the opinionated happy path for agents and humans.
- `doctor` checks Git, code-host access, stack metadata, trunks, and undo journal health without mutating anything.
- `track` records parentage for an existing branch only when change target branches do not already encode the stack.
- `sync [branch]` previews target-branch inference, stale metadata cleanup, and repairs without mutating branches, requests, or stack metadata using the tree summary output.
- `sync --apply [branch]` applies the common maintenance workflow: remove stale local links, infer clear target-branch stack links, repair branches, retarget requests, refresh links, and show a concise tree summary. With a branch argument, sync only the stack containing that branch.
- `sync` with no branch scopes to the current stack when the current branch is stack-relevant; when off-stack, it keeps the repo-wide behavior.
- `sync --apply --continue-on-failure` / `sync --apply --keep-going` processes independent stacks, reports succeeded and failed stacks, preserves per-stack cleanup output, and exits nonzero if any stack failed.
- `sync` should not auto-track standalone trunk-root requests; infer a trunk-root request only when another open request is based on it.
- `merge` merges the oldest branch in a stack and immediately repairs descendants; when no branch is given, it infers the root from the current branch. It retargets immediate child requests before merge to preserve open work in auto-delete repos.
- `merge --auto` retargets immediate child requests, enables code-host auto-merge, waits for merge, then repairs descendants.
- `merge --auto --through <branch-or-change>` repeats root auto-merge and descendant repair until the target branch or request has landed.
- `history` explains the most recent applied mutation from the undo journal.
- `undo` restores the last applied mutation.

## Implementation notes

- Persist stack metadata in `.git/stack/state.json`.
- Persist undo state in `.git/stack/undo.json`.
- User preferences live in `git config stack.*` (read at startup in the CLI `live` layer), not in `state.json`. Current keys: `stack.codeHost`, `stack.trunks`, and `stack.blockLink` (default true; set false to render a plain `### Stack` heading without the attribution link).
- Prefer `Context.Service`-based Effect services and test-first changes.
- Use OpenCode-style service modules for deep seams: export `Interface`, `Service`, adapters like `layer`, `live`, or `memory`, and a namespace self-reexport such as `export * as CodeHost from "./CodeHost.ts"`; consumers import that named namespace directly from the module file.
- Keep local Git behavior behind `Git` and pull/merge-request behavior behind `CodeHost`. Concrete backends live in `services/code-host/GitHub.ts` (via `gh`) and `services/code-host/GitLab.ts` (via `glab`), while their in-memory contract behavior is shared through `services/code-host/Memory.ts`; the CLI picks one backend at startup from `STACK_CODE_HOST`, `git config stack.codeHost`, or an unambiguous `origin` host. Stack orchestration depends on `CodeHost.Service` rather than shelling out to a host CLI directly.
- Check the local Effect source tree when available before changing Effect APIs or versions.
- Prefer `effect/Path`, `effect/FileSystem`, and `effect/unstable/process` instead of Node/Bun built-ins in app code.
- Keep logic literal and debuggable over clever abstractions.
- Default command output should be outcome-oriented: show the stack tree and changed/failed branches, not internal phases like fetch/inspect/reconcile.

## Verification

- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run format:check` and `bun run lint` when formatting or lint config is present.
- When changing CLI docs or behavior, spot-check `bun src/cli.ts --help` and relevant subcommand help.
