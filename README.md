# stack

```ts
╭───STACK───╮
dev
└─ #101
   └─ #102
      └─ #103
╰───────────╯
```

Squash-safe stacked PR/MR repair for coding agents working in GitHub or GitLab
repos that squash-merge and delete branches.

`stack` is agent-first. Humans can run it directly, but the happy path is: let
the agent do normal code work with plain `git`, then use `stack` for stack
inspection, repair, merge, and undo workflows.

## Install

```bash
npm install -g @kitlangton/stack
```

Install the agent skill too:

```bash
npx skills add kitlangton/stack --skill stack
```

Install and authenticate the matching host CLI:

```bash
gh auth login      # GitHub
glab auth login    # GitLab
```

## Agent Happy Path

1. Create stacked changes using normal git branches.
2. Open the root PR/MR against trunk, for example `main` or `dev`.
3. Open each child PR/MR against its parent branch.
4. Preview the stack:

```bash
stack sync
```

5. Apply the safe maintenance workflow:

```bash
stack sync --apply
```

6. Merge from the root when ready:

```bash
stack merge
stack merge --apply
```

Use `stack merge --auto` when the code host should wait for merge requirements,
then repair descendants automatically after the root lands.

## What It Does

`stack sync --apply` is the common maintenance workflow:

- Infers stack links from PR/MR target branches.
- Records stack intent in `.git/stack/state.json`.
- Repairs descendants after parent branches move or land.
- Retargets PRs/MRs when needed.
- Refreshes stack blocks in descriptions.
- Saves `.git/stack/undo.json` before mutations.

GitHub stack blocks use compact `#101` references. GitLab blocks use `!101`
references plus titles because bare GitLab MR links only show titles on hover.

If a repair fails, run:

```bash
stack history
stack undo
stack undo --apply
```

## GitHub And GitLab

Provider selection is automatic for public hosts:

- `github.com` uses `gh`.
- `gitlab.com` uses `glab`.

For enterprise hosts, configure the repo once:

```bash
git config stack.codeHost github  # or: gitlab
```

Use `STACK_CODE_HOST=github|gitlab` for a one-off override.

## Trunk Branches

By default, `stack` treats `dev`, `main`, and `master` as trunk branches. Repos
that use another trunk, such as `develop`, can configure the trunk list:

```bash
git config stack.trunks dev,develop,main,master
```

## Stack Block Heading

Each stack block has a heading that links back to this project. To render a
plain `### Stack` heading without the attribution link — for example in
enterprise repos where external links trip compliance checks — set:

```bash
git config stack.blockLink false
```

The linked heading stays on by default. This is repo-local; use
`git config --global stack.blockLink false` to apply it everywhere.

## Example Output

```text
Sync preview

● main
└─ ● stack-a #101
   └─ ● stack-b #102

Would update PRs: #101, #102

Apply:
  stack sync
```

```text
→ retarget #102 (stack-b) to main before merge
→ merge #101 (stack-a)
→ rebase stack-b onto main
→ push stack-b
→ update #102 stack block
```

## CLI Reference

```bash
stack status             # inspect the relevant local stack
stack guide              # print the agent/human happy path
stack sync               # preview inference, repairs, and description updates
stack sync --apply       # apply the previewed maintenance workflow
stack sync <branch>      # preview only the stack containing branch
stack sync --apply <branch>
                         # apply only the stack containing branch
stack sync --apply --keep-going
                         # process independent stacks and report failures
stack doctor             # inspect repo, host, metadata, and journal health
stack merge              # dry-run the next root merge
stack merge --apply      # merge root and repair descendants
stack merge --auto       # wait for host requirements, then merge and repair
stack merge --auto --through <branch-or-change>
                         # auto-merge roots through a bounded target
stack history            # show the last saved mutation journal
stack undo               # preview undo
stack undo --apply       # restore branch tips, request targets, and metadata
```
