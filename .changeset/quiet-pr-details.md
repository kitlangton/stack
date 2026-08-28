---
"@kitlangton/stack": patch
---

Read GitHub PR details through the REST API instead of version-dependent `gh pr view` JSON fields. This fixes decoding failures on older GitHub CLI versions while preserving fork repository identity and handling empty PR bodies and deleted repositories.
