---
"@kitlangton/stack": patch
---

User-facing polish for forge-neutral wording.

- CLI help text, the `guide` command, and the merge failure hint now talk about
  "changes" / "target branches" / "forge-native auto-merge" instead of
  "PRs" / "PR bases" / "GitHub auto-merge". GitHub-specific behaviour (admin
  merge) is still called out where it applies.
- `package.json` description and keywords mention GitLab and merge requests.
- README, AGENTS.md (and the CLAUDE.md symlink), CONTEXT.md, and the
  `skills/stack/SKILL.md` agent guide document the `Forge` seam, the two
  backends (gh + glab), and the `STACK_FORGE` override. The skill now shows
  GitLab equivalents in the Happy Path section and notes that `--admin` is
  GitHub-only.
- `missingPull` regex now also matches `404` so GitLab "404 Not Found" errors
  short-circuit correctly during description rewrite.
