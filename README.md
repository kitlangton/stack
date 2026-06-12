# stack

```ts
╭───STACK───╮
dev
└─ #101
   └─ #102
      └─ #103
╰───────────╯
```

Squash-safe stacked PR/MR repair for coding agents working in GitHub, GitLab, or
Azure DevOps repos that squash-merge and delete branches.

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
az login           # Azure DevOps
az extension add --name azure-devops
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

GitHub stack blocks use compact `#101` references. GitLab and Azure DevOps blocks
use `!101` references (`#` links to work items in ADO descriptions). GitLab also
includes titles because bare MR links only show titles on hover.

If a repair fails, run:

```bash
stack history
stack undo
stack undo --apply
```

## GitHub, GitLab, And Azure DevOps

Provider selection is automatic for public hosts:

- `github.com` uses `gh`.
- `gitlab.com` uses `glab`.
- `dev.azure.com`, `ssh.dev.azure.com`, and legacy `{org}.visualstudio.com` use `az repos pr`.

For enterprise or on-prem hosts, configure the repo once:

```bash
git config stack.codeHost github      # or: gitlab, azuredevops
```

Use `STACK_CODE_HOST=github|gitlab|azuredevops` for a one-off override. Azure DevOps
Server and other custom hosts are not auto-detected; set `stack.codeHost` to
`azuredevops` and authenticate with `az login` plus `AZURE_DEVOPS_EXT_PAT` when needed.

Azure DevOps limitations: `az repos pr` does not expose fork source repositories, so
`headRepository` stays empty and fork-backed repair push routing is unavailable.
`--admin` merge is not supported. On-prem and custom ADO hosts require an explicit
`stack.codeHost` setting. Labels on recreate are applied through Azure DevOps REST
after create when the installed `az`/`azure-devops` version supports label APIs;
otherwise creation succeeds without labels. `stack doctor` checks `az`, the
`azure-devops` extension, and pull-request access before sync or merge.

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
