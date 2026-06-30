---
"@kitlangton/stack": minor
---

Replace `stack guide` with `stack skill`, which prints the full `skills/stack/SKILL.md` agent instruction set. The skill content is embedded at build time via `with { type: "text" }` import, so it works from the installed package without a separate file lookup. The `guide` command is removed — `skill` supersedes it.
