---
"@kitlangton/stack": patch
---

Fix three rendering quirks surfaced by the GitLab smoke test.

- `stack sync` against a GitLab remote now writes `!1`, `!2`, `!3` in the stack
  block inside each MR description so they render as real merge-request links
  on gitlab.com. Previously the block always used GitHub's `#N` syntax, which
  on GitLab refers to _issues_ — so the references rendered as plain text or
  links to nonexistent issues. The completed-line parser in `stackBlock`
  accepts both `#N` and `!N` so blocks written by either forge are preserved
  on rewrite. The active prefix is picked once from the detected forge in
  `Stack.layer` (auto-detected from the `origin` remote URL).
- `stack status` now labels the displayed trunk as the trunk _actually used_
  by the stack (e.g. `main` when the stack lives off `main`) instead of always
  using `cfg.trunks[0]`. The inference falls back to `cfg.trunks[0]` when no
  trunk is referenced as a parent.
- `stack merge` now reports `would switch to <actual trunk>` and switches to
  the right trunk on apply, instead of unconditionally using `cfg.trunks[0]`.
  Same fix in `stack undo`: the trunk to switch to is inferred from the
  saved `run.state.links`.

The first item is genuinely GitLab-specific; the other two were pre-existing
display bugs that affect any repo whose trunk is not `dev`.
