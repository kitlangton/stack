---
"@kitlangton/stack": patch
---

Recover stranded squash repair anchors: if `stack merge` persists state but aborts before descendant repair, a later `stack sync --apply` now uses the persisted anchor when it matches a `backup/landed-*` ref, so stranded descendants replay only their own commits instead of re-replaying the already-squashed parent.
