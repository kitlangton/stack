# Context

## Domain Terms

- **Stack**: An ordered set of changes (GitHub PRs or GitLab MRs) where each branch is based on the previous branch, ending at a trunk branch such as `dev`.
- **Stack link**: Persisted metadata that records a branch, its parent branch, the merge-base anchor, and the associated change number (PR or MR IID).
- **Stack block**: The generated markdown block in a change description that shows stack history and the current open path.
- **Repair**: The workflow that rehomes stack descendants after a squash merge, parent branch deletion, or parent branch rewrite.
- **Undo journal**: The saved snapshot of branch backups, change target branches, and stack metadata used by `stack undo`.
- **Code host**: The hosted platform containing pull or merge requests. Currently GitHub (via `gh`) and GitLab (via `glab`). Known public hosts are selected from `origin`; enterprise hosts are configured with `git config stack.codeHost`.

## Architecture Notes

- Local Git behavior stays behind the `Git` seam.
- Pull/merge-request behavior stays behind the `CodeHost` seam; its provider-neutral `changes()` and `change()` operations map to GitHub PRs or GitLab MRs in concrete backends under `services/code-host/`.
- Provider adapters share their in-memory contract implementation through `services/code-host/Memory.ts`; new adapters supply provider properties while keeping hosted CLI quirks local.
- Stack orchestration belongs in `Stack`; markdown rendering belongs in formatting modules such as `stackBlock` and `format`.
- Checkpoint-before-mutation repair execution belongs in `repairExecution`; `Stack` supplies the journal payload and repair plan.
- Stack-block description refresh is a derived, idempotent projection of stack metadata. It is intentionally rerunnable rather than journaled as primary state.
