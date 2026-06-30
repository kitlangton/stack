---
"@kitlangton/stack": patch
---

Skip re-pushing branches that are already at the correct repaired tip during `stack sync --apply`. Previously, repairing a parent caused all descendants to be re-replayed and re-pushed even when their base already matched the parent's new tip, creating unnecessary CI/deploy churn on deep stacks. Dry-run previews and the pre-flight dirty-worktree gate remain conservative.
