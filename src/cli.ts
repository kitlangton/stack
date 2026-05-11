#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };
import {
  BranchError,
  DirtyWorktreeError,
  ExecError,
  MergeBaseError,
} from "./domain/model.ts";
import { renderStatus } from "./format.ts";
import * as Proc from "./platform/proc.ts";
import { StackConfig, trunks } from "./services/Config.ts";
import * as Git from "./services/Git.ts";
import * as GitHub from "./services/GitHub.ts";
import * as Progress from "./services/Progress.ts";
import { Stack } from "./services/Stack.ts";
import { Store } from "./services/Store.ts";

const apply = Flag.boolean("apply").pipe(
  Flag.withAlias("y"),
  Flag.withDescription(
    "Apply the change. Without this flag the command is a dry run.",
  ),
);

const auto = Flag.boolean("auto").pipe(
  Flag.withDescription(
    "Enable GitHub auto-merge for the root PR, wait until it merges, then repair descendants automatically.",
  ),
);

const admin = Flag.boolean("admin").pipe(
  Flag.withDescription(
    "Use GitHub administrator privileges to merge immediately. Requires --apply.",
  ),
);

const through = Flag.string("through").pipe(
  Flag.withDescription(
    "With --auto, keep merging stack roots until this branch or PR number has landed.",
  ),
  Flag.optional,
);

const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Preview the sync workflow without changing branches or PRs."),
);

const guide = `Happy path for stacked PRs

1. Create PRs with the right GitHub bases.
   - Root PR: base is trunk, for example dev or main.
   - Child PR: base is the parent branch.

2. Preview what stack will infer and repair.
   stack sync --dry-run

3. Apply only after the preview looks right.
   stack sync

Use stack status to verify the relevant local tracked stack. It does not call
GitHub, hides backup branches, and focuses on the current stack instead of
listing every local branch.`;

const statusCommand = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const stack = yield* Stack;
    const report = yield* stack.status();
    yield* Console.log(renderStatus(report, { pretty: true }));
  }),
).pipe(
  Command.withDescription(
    "Show the local tracked stack without calling GitHub. Use sync --dry-run to preview PR-base inference.",
  ),
);

const guideCommand = Command.make(
  "guide",
  {},
  Effect.fn(function* () {
    yield* Console.log(guide);
  }),
).pipe(
  Command.withDescription(
    "Show the opinionated happy path for agents and humans using stacked PRs.",
  ),
);

const trackCommand = Command.make(
  "track",
  {
    branch: Argument.string("branch"),
    onto: Flag.string("onto").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("Parent branch this branch is stacked on"),
    ),
  },
  Effect.fn(function* ({ branch, onto }) {
    const stack = yield* Stack;
    const link = yield* stack.adopt(branch, onto);
    yield* Console.log(
      `track ${link.branch} onto ${link.parent} @ ${link.anchor}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Manually record stack intent only when PR bases do not already encode the stack.",
  ),
  Command.withExamples([
    {
      command: "stack track stack-c --onto stack-b",
      description: "Record that stack-c is stacked on stack-b",
    },
  ]),
);

const repairCommand = Command.make(
  "repair",
  { apply },
  Effect.fn(function* ({ apply }) {
    const stack = yield* Stack;
    const items = yield* stack.repair(apply);
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Repair an already-tracked stack after squash merges or branch deletion. By default this is a dry run. Add --apply to actually run it.",
  ),
  Command.withExamples([
    {
      command: "stack repair",
      description: "Preview repairs from local stack metadata",
    },
    {
      command: "stack repair --apply",
      description:
        "Apply the planned repair using backups, rebases, pushes, and PR updates",
    },
  ]),
);

const syncCommand = Command.make(
  "sync",
  { dryRun },
  Effect.fn(function* ({ dryRun }) {
    const stack = yield* Stack;
    const items = yield* stack.sync({ dryRun });
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Infer stack links from GitHub PR bases, clean stale metadata, repair branches, retarget PRs, and refresh stack links. Add --dry-run to preview without changing anything.",
  ),
  Command.withExamples([
    {
      command: "stack sync --dry-run",
      description: "Preview inferred stack links and repairs without changing branches or PRs",
    },
    {
      command: "stack sync",
      description: "Run the common stack maintenance workflow",
    },
  ]),
);

const doctorCommand = Command.make(
  "doctor",
  {},
  Effect.fn(function* () {
    const stack = yield* Stack;
    const items = yield* stack.doctor();
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Check local Git, GitHub, stack metadata, trunk branches, and undo journal health without changing anything.",
  ),
);

const mergeCommand = Command.make(
  "merge",
  {
    branch: Argument.string("branch").pipe(Argument.optional),
    apply,
    auto,
    admin,
    through,
  },
  Effect.fn(function* ({ branch, apply, auto, admin, through }) {
    const stack = yield* Stack;
    const throughValue = Option.getOrUndefined(through);
    const items = yield* stack.land(Option.getOrUndefined(branch), {
      apply,
      auto,
      admin,
      ...(throughValue === undefined ? {} : { through: throughValue }),
    });
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Merge the oldest branch in a stack, preserve a local backup branch, repair descendants, and print the next root branch. If branch is omitted, infer the root from the current branch. By default this is a dry run. Add --apply to merge immediately, --apply --admin to force with admin privileges, or --auto to enable GitHub auto-merge and wait until it lands before repairing descendants. Add --auto --through <branch-or-pr> to repeat through a bounded range.",
  ),
  Command.withExamples([
    {
      command: "stack merge",
      description: "Preview merge + repair for the inferred root of the current stack",
    },
    {
      command: "stack merge effectify-watcher",
      description: "Preview merge + repair for the root branch of a stack",
    },
    {
      command: "stack merge effectify-watcher --apply",
      description:
        "Merge the root PR, repair descendants, and print the next root branch",
    },
    {
      command: "stack merge effectify-watcher --auto",
      description:
        "Wait for GitHub requirements, then merge and repair descendants",
    },
    {
      command: "stack merge --auto --through effectify-format",
      description:
        "Auto-merge roots one at a time until the target branch has landed",
    },
    {
      command: "stack merge effectify-watcher --apply --admin",
      description:
        "Force-merge the root PR with admin privileges, then repair descendants",
    },
  ]),
);

const historyCommand = Command.make(
  "history",
  {},
  Effect.fn(function* () {
    const stack = yield* Stack;
    const items = yield* stack.last();
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Show the most recent applied stack repair so you can see what changed and what `undo --apply` would restore.",
  ),
);

const undoCommand = Command.make(
  "undo",
  { apply },
  Effect.fn(function* ({ apply }) {
    const stack = yield* Stack;
    const items = yield* stack.undo(apply);
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Restore the last applied mutation using backup branches and the saved metadata snapshot. By default this is a dry run. Add --apply to actually restore branches, push them, close created PRs, and restore stored metadata.",
  ),
  Command.withExamples([
    {
      command: "stack undo",
      description: "Preview the rollback plan for the last applied mutation",
    },
    {
      command: "stack undo --apply",
      description:
        "Restore branch tips, PR bases, and metadata from the last mutation journal",
    },
  ]),
);

const cli = Command.make("stack").pipe(
  Command.withDescription(
    "A squash-safe stacked PR CLI. Use plain git for normal editing and commits, then use stack to track branch relationships, inspect the graph, repair after squash merges, merge stack roots, and undo the last mutation if needed.",
  ),
  Command.withExamples([
    {
      command: "stack guide",
      description: "Show the recommended stacked PR workflow",
    },
    {
      command: "stack sync --dry-run",
      description: "Preview inferred stack links from PR bases",
    },
    {
      command: "stack sync",
      description: "Run the previewed stack maintenance",
    },
  ]),
  Command.withSubcommands([
    statusCommand,
    guideCommand,
    trackCommand,
    syncCommand,
    doctorCommand,
    mergeCommand,
    repairCommand,
    historyCommand,
    undoCommand,
  ]),
);

export const runCli = (argv: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: pkg.version })(argv);

const live = (() => {
  const proc = Proc.live;
  const cfg = Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const proc = yield* Proc.Service;
      const root = yield* proc.exec(process.cwd(), "git", [
        "rev-parse",
        "--show-toplevel",
      ]).pipe(
        Effect.catch((err) =>
          Console.error(err.stderr).pipe(
            Effect.flatMap(() =>
              Effect.fail(new Error("not in a git repository")),
            ),
          ),
        ),
      );

      const dir = yield* proc.exec(root, "git", [
        "rev-parse",
        "--git-common-dir",
      ]);
      const git = path.isAbsolute(dir) ? dir : path.join(root, dir);

      return StackConfig.layer({
        root,
        store: path.join(git, "stack", "state.json"),
        journal: path.join(git, "stack", "undo.json"),
        trunks,
      });
    }),
  ).pipe(Layer.provideMerge(proc));

  const git = Git.live.pipe(Layer.provide(cfg));
  const github = GitHub.layer.pipe(Layer.provide(cfg));
  const store = Store.live.pipe(Layer.provideMerge(cfg));
  return Stack.layer.pipe(
    Layer.provideMerge(cfg),
    Layer.provideMerge(git),
    Layer.provideMerge(github),
    Layer.provideMerge(Progress.live),
    Layer.provideMerge(store),
  );
})();

const docs = Layer.succeed(Stack, {
  status: () => Effect.die("help-only"),
  adopt: () => Effect.die("help-only"),
  land: () => Effect.die("help-only"),
  links: () => Effect.die("help-only"),
  sync: () => Effect.die("help-only"),
  repair: () => Effect.die("help-only"),
  doctor: () => Effect.die("help-only"),
  last: () => Effect.die("help-only"),
  undo: () => Effect.die("help-only"),
});

const isShowHelp = (err: unknown): err is CliError.ShowHelp =>
  CliError.isCliError(err) && err._tag === "ShowHelp";

if (import.meta.main) {
  const help = process.argv
    .slice(2)
    .some((arg) => arg === "--help" || arg === "-h" || arg === "--version");

  const app = help
    ? runCli(process.argv.slice(2)).pipe(Effect.provide(docs))
    : runCli(process.argv.slice(2)).pipe(Effect.provide(live));

  const main = pipe(
    app,
    Effect.provide(NodeServices.layer),
    Effect.catchIf(isShowHelp, (err) =>
      Effect.sync(() => {
        process.exitCode = err.errors.length ? 1 : 0;
      }),
    ),
    Effect.tapError((err) =>
      Console.error(
        err instanceof ExecError && err.stderr
          ? `${err.message}\n${err.stderr}`
          : err instanceof DirtyWorktreeError ||
              err instanceof BranchError ||
              err instanceof MergeBaseError ||
              err instanceof Error
            ? err.message
            : String(err),
      ),
    ),
    Effect.catch(() => Effect.sync(() => process.exit(1))),
  );

  NodeRuntime.runMain(main);
}
