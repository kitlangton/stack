# stack

```ts
╭───STACK───╮
dev
└─ #101
   └─ #102
      └─ #103
╰───────────╯
```

Squash-safe stacked PRs / MRs for GitHub and GitLab repos that squash-merge and
delete branches.

`stack` preserves stack intent locally, infers obvious relationships from PR /
MR target branches, and repairs descendants after parent changes or merges so
open changes keep their comments, reviews, and context.

Works against GitHub (via the `gh` CLI) and GitLab (via the `glab` CLI).
Install and authenticate the matching CLI before running `stack`. The
`github.com` and `gitlab.com` hosts are detected automatically from `origin`. For an
enterprise host, configure the repository once with `git config stack.codeHost
github` or `git config stack.codeHost gitlab`; use `STACK_CODE_HOST` as a
temporary override.

## Install

```bash
npm install -g @kitlangton/stack
```

Install the agent skill too, so coding agents know the safe workflow:

```bash
npx skills add kitlangton/stack --skill stack
```

## Example Workflow

An agent splits one cleanup into two PRs. The second PR is based on the first, so
GitHub knows the stack but Git will forget that relationship after squash merge.

```bash
gh pr create --base dev --head cleanup/schema-source
gh pr create --base cleanup/schema-source --head cleanup/openapi-output

stack sync --dry-run
```

The preview summarizes the resulting stack:

```text
Sync preview

● dev
└─ ● cleanup/schema-source #101
   └─ ● cleanup/openapi-output #102

Would update PRs: #101, #102

Apply:
  stack sync
```

Then sync it:

```bash
stack sync
```

`stack sync` records the inferred links, refreshes each PR body, and prints a
concise summary:

```text
Synced stack

● dev
└─ ● cleanup/schema-source #101
   └─ ● cleanup/openapi-output #102

Updated PRs: #101, #102

Undo:
  stack undo --apply
```

Each PR/MR gets a stack block in its description. GitHub blocks stay compact
with native `#101` references. GitLab blocks use native `!101` references plus
titles, because bare GitLab MR autolinks only show the title on hover.

When the first PR is ready, the agent previews and merges the root:

```bash
stack merge
stack merge --apply
```

Before merging, `stack` retargets child PRs away from the root branch. That keeps
GitHub auto-delete from closing descendants, then `stack` rebases/pushes the
remaining branches and refreshes stack blocks.

```text
→ retarget #102 (cleanup/openapi-output) to dev before merge
→ merge #101 (cleanup/schema-source)
→ rebase cleanup/openapi-output onto dev
→ push cleanup/openapi-output
→ update #102 stack block
```

The child PR keeps its comments and reviews. Its stack block becomes history plus
the current PR. On GitLab, the same block includes MR titles beside each `!N`.

```md
### [Stack](https://github.com/kitlangton/stack)

1. #101
2. **#102** 👈 current
```

## Commands

```bash
stack status             # local tracked stack plus available host details
stack sync --dry-run     # preview target-branch inference and repairs
stack sync               # record inferred links, repair, and refresh descriptions
stack sync <branch>      # sync only the stack containing branch
stack sync --keep-going  # process independent stacks and report failures at end
stack merge              # dry-run the next root merge
stack merge --apply      # merge root and repair descendants
stack merge --auto       # wait for host requirements, then merge and repair
stack merge --auto --through <branch-or-change>
                          # auto-merge roots one at a time through a target
```

When a parent change branch changes, run `stack sync --dry-run` and then `stack sync`.
From a stack branch, bare `stack sync` scopes to that stack; from off-stack it
keeps the repo-wide behavior. Use `stack sync <branch>` to force one stack, or
`stack sync --continue-on-failure` / `stack sync --keep-going` to process
independent stacks and summarize any failures at the end.

If a descendant replay conflicts, `stack` aborts the failed cherry-pick, restores
your starting branch, keeps backups and an undo journal, and prints the branch to
repair manually before rerunning `stack sync`.
