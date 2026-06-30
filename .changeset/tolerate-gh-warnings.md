---
"@kitlangton/stack": patch
---

Tolerate non-JSON warnings (e.g. auth expiry notices) emitted before `gh pr view` JSON output. The decoder now extracts the JSON payload from stdout instead of requiring the entire output to be valid JSON.
