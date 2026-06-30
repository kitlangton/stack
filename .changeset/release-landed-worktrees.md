---
"@kitlangton/stack": patch
---

Detach clean sibling worktrees that own a landed branch before deleting it during `stack merge --apply` and `stack merge --auto` cleanup. Fails before hosted mutation when the target worktree is dirty.
