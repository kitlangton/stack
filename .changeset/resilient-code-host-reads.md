---
"@kitlangton/stack": patch
---

Retry recognized transient GitHub and GitLab read failures up to twice with jittered exponential backoff, without retrying mutations. Do not retain failed GitLab source-project lookups in the cache. Reuse known GitLab titles, avoid rereading already-titled history, and preserve historical stack entries if optional title enrichment fails.

Drain subprocess stdout and stderr concurrently to prevent hangs when a child fills its stderr pipe before closing stdout.
