---
"@kitlangton/stack": patch
---

Publish locally ahead stack parents before repairing descendants during sync. Check the actual push destinations, require fast-forward ancestry, and use explicit leases so concurrent remote changes are not overwritten.

Journal remote-only updates separately so undo can restore different fork/origin tips, including previously absent refs, without discarding existing local parent commits. Keep-going checkpoints retain recovery data from earlier stacks. Journals with remote updates use version 2; existing version 1 journals remain readable.
