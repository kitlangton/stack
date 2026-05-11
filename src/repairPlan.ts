import type { Mode, StackResultItem } from "./stackResult.ts";

export interface RebaseBranchPlan {
  readonly branch: string;
  readonly parent: string;
  readonly onto: string;
  readonly backup: string;
  readonly commits: ReadonlyArray<string>;
}

export interface RetargetPullPlan {
  readonly pr: number;
  readonly base: string;
}

export interface CreatePullPlan {
  readonly branch: string;
  readonly base: string;
  readonly pr: number | null;
}

export const rebaseBranch = (
  plan: RebaseBranchPlan,
  mode: Mode,
): ReadonlyArray<StackResultItem> => [
  { _tag: "Backup", mode, branch: plan.branch, backup: plan.backup },
  { _tag: "Rebase", mode, branch: plan.branch, parent: plan.parent },
  { _tag: "Push", mode, branch: plan.branch },
];

export const retargetPull = (plan: RetargetPullPlan, mode: Mode): StackResultItem => ({
  _tag: "RetargetPull",
  mode,
  pr: plan.pr,
  base: plan.base,
});

export const createPull = (plan: CreatePullPlan, mode: Mode): StackResultItem => ({
  _tag: "CreatePull",
  mode,
  branch: plan.branch,
  base: plan.base,
  pr: plan.pr,
});
