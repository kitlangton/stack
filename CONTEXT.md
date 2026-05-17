# Context

## Domain Terms

- **Stack**: An ordered set of changes (GitHub PRs or GitLab MRs) where each branch is based on the previous branch, ending at a trunk branch such as `dev`.
- **Stack link**: Persisted metadata that records a branch, its parent branch, the merge-base anchor, and the associated change number (PR or MR IID).
- **Stack block**: The generated markdown block in a change description that shows stack history and the current open path.
- **Repair**: The workflow that rehomes stack descendants after a squash merge, parent branch deletion, or parent branch rewrite.
- **Undo journal**: The saved snapshot of branch backups, change target branches, and stack metadata used by `stack undo`.
- **Forge**: A hosted Git change-request service. Currently GitHub (via `gh`) and GitLab (via `glab`). The active forge is selected from `STACK_FORGE` or auto-detected from the `origin` remote URL.

## Architecture Notes

- Local Git behavior stays behind the `Git` seam.
- Change-request behavior stays behind the `Forge` seam; concrete backends live in `services/forge/github.ts` and `services/forge/gitlab.ts`.
- Stack orchestration belongs in `Stack`; markdown rendering belongs in formatting modules such as `stackBlock` and `format`.
