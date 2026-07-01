---
"@kitlangton/stack": patch
---

Write `state.json` and `undo.json` atomically via tmp+rename so a crash mid-write cannot corrupt stack metadata. When a cherry-pick fails during repair, surface the conflicting file paths before aborting so the user knows which files need attention. Corrupt state files now include a recovery hint in the error message.
