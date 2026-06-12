---
"@kitlangton/stack": minor
---

Add Azure DevOps support through the `azure-devops` CLI extension (`az repos pr`). Cloud `dev.azure.com` and `ssh.dev.azure.com` remotes auto-detect; on-prem hosts require `git config stack.codeHost azuredevops`. ADO pull requests map onto the existing `PullRef` / `PullMeta` shapes, use `!N` references, and reject `--admin` merge like GitLab.
