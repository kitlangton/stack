---
"@kitlangton/stack": patch
---

User-facing polish for code-host-neutral wording.

- CLI help text, the `guide` command, and the merge failure hint now talk about
  "changes" / "target branches" / "code-host auto-merge" instead of
  "PRs" / "PR bases" / "GitHub auto-merge". GitHub-specific behaviour (admin
  merge) is still called out where it applies.
- `package.json` description and keywords mention GitLab and merge requests.
- README, AGENTS.md (and the CLAUDE.md symlink), CONTEXT.md, and the
  `skills/stack/SKILL.md` agent guide document the `CodeHost` seam, the two
  backends (gh + glab), and code-host selection. The skill now shows
  GitLab equivalents in the Happy Path section and notes that `--admin` is
  GitHub-only.
- Provider adapters normalize missing historical changes so GitLab `404 Not Found`
  responses and GitHub lookup failures trigger the same safe recreation path.
