---
"@kitlangton/stack": minor
---

Repair branches that are checked out in other worktrees by replaying them from their owning clean worktree instead of force-moving the ref. Sync and merge now fail before any mutation when a branch needing repair is checked out in a dirty worktree, and refuse to delete a local branch that is checked out elsewhere.
