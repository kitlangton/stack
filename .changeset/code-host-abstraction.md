---
"@kitlangton/stack": minor
---

Introduce the internal `CodeHost` seam so stack orchestration can operate on
GitHub pull requests and GitLab merge requests through provider adapters.

The CLI now selects a provider at startup and uses host-neutral concurrency and
polling configuration internally. Repair plumbing also records request source
repositories and pushed remotes so fork-backed repairs can be recreated and
undone safely. Provider adapters normalize missing historical changes before
orchestration decides whether to recreate them, and enumerate open changes
exhaustively so stale-metadata decisions never depend on arbitrary list caps.
Provider adapters also share one in-memory contract implementation so additional
hosts can reuse the same lifecycle behavior without copying adapter test seams.
The new seam names hosted requests as changes internally while preserving the
existing persisted `pr` keys and exported pull-shaped models for compatibility.
GitLab source-project enrichment is cached per adapter layer, including concurrent
lookups for fork-backed requests.
