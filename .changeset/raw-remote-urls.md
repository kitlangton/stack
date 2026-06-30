---
"@kitlangton/stack": patch
---

Read raw configured remote URLs (`remote.origin.url`) instead of rewrite-expanded output, so repository and code-host detection stays correct under Git `insteadOf` rewrites and custom SSH host aliases.
