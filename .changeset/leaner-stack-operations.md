---
"@kitlangton/stack": patch
---

Allow `stack skill` to print instructions outside a Git repository. Avoid scanning unrelated worktree contents during branch-specific Git operations, read state files without a separate existence check, and read independent local status information concurrently. Preserve dirty-worktree preflight and undo checkpoint behavior while simplifying internal bookkeeping and shared GitLab model handling.
