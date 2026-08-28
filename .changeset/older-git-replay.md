---
"@kitlangton/stack": patch
---

Support stack repair on older Git versions, including Git 2.39, without requiring `cherry-pick --empty=drop`. Replay commits sequentially and use Git state to skip only commits that become redundant on the new parent. Preserve failures for originally empty commits and other replay errors, and report conflict paths from the branch's owning worktree.
