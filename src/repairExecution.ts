import * as Effect from "effect/Effect";
import type { StackError } from "./domain/model.ts";
import type { RebaseBranchPlan, RetargetPullPlan } from "./repairPlan.ts";
import type { Interface as Git } from "./services/Git.ts";
import * as StackResult from "./stackResult.ts";

interface Dependencies {
  readonly checkpoint: () => Effect.Effect<void, StackError>;
  readonly step: (message: string) => Effect.Effect<void>;
}

export interface ApplyRebaseBranchDependencies extends Dependencies {
  readonly git: Pick<Git, "backup" | "replay" | "push">;
  readonly onReplayFailure: (error: StackError) => StackError;
}

export const applyRebaseBranch = Effect.fn("RepairExecution.applyRebaseBranch")(function* (
  plan: RebaseBranchPlan,
  deps: ApplyRebaseBranchDependencies,
) {
  yield* deps.checkpoint();
  yield* deps.step(`backup ${plan.branch} -> ${plan.backup}`);
  yield* deps.git.backup(plan.branch, plan.backup);
  yield* deps.step(`rebase ${plan.branch} onto ${plan.parent}`);
  yield* deps.git
    .replay(plan.branch, plan.onto, plan.commits)
    .pipe(Effect.mapError(deps.onReplayFailure));
  for (const remote of plan.pushRemotes) {
    yield* deps.step(
      StackResult.render({ _tag: "Push", mode: "apply", branch: plan.branch, remotes: [remote] }),
    );
    yield* deps.git.push(plan.branch, remote);
  }
});

export interface ApplyRetargetPullDependencies extends Dependencies {
  readonly edit: (pr: number, base: string) => Effect.Effect<void, StackError>;
  readonly message?: string;
  readonly reference: (number: number) => string;
}

export const applyRetargetPull = Effect.fn("RepairExecution.applyRetargetPull")(function* (
  plan: RetargetPullPlan,
  deps: ApplyRetargetPullDependencies,
) {
  yield* deps.checkpoint();
  yield* deps.step(deps.message ?? `retarget ${deps.reference(plan.pr)} to ${plan.base}`);
  yield* deps.edit(plan.pr, plan.base);
});

export * as RepairExecution from "./repairExecution.ts";
