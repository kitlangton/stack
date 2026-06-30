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
import { BranchError, DirtyWorktreeError, ExecError, MergeBaseError } from "./domain/model.ts";
import { renderStatus } from "./format.ts";
import * as Proc from "./platform/proc.ts";
import { parseBlockLinkConfig, parseTrunksConfig, StackConfig, trunks } from "./services/Config.ts";
import { CodeHost } from "./services/CodeHost.ts";
import { CodeHostGitHub } from "./services/code-host/GitHub.ts";
import { CodeHostGitLab } from "./services/code-host/GitLab.ts";
import { Git } from "./services/Git.ts";
import * as Progress from "./services/Progress.ts";
import { Stack } from "./services/Stack.ts";
import { Store } from "./services/Store.ts";

const apply = Flag.boolean("apply").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Apply the change. Without this flag the command is a dry run."),
);

const auto = Flag.boolean("auto").pipe(
  Flag.withDescription(
    "Enable code-host auto-merge for the root change, wait until it merges, then repair descendants automatically.",
  ),
);

const admin = Flag.boolean("admin").pipe(
  Flag.withDescription(
    "Use administrator privileges to merge immediately, bypassing protection rules. Requires --apply. GitHub only.",
  ),
);

const through = Flag.string("through").pipe(
  Flag.withDescription(
    "With --auto, keep merging stack roots until this branch or change number has landed.",
  ),
  Flag.optional,
);

const continueOnFailure = Flag.boolean("continue-on-failure").pipe(
  Flag.withAlias("keep-going"),
  Flag.withDescription(
    "Process every independent stack and report failures at the end instead of stopping on the first failure.",
  ),
);

const guide = `Happy path for stacked changes (GitHub PRs / GitLab MRs)

1. Open the changes with the right target branches.
   - Root change: target is trunk, for example dev or main.
   - Child change: target is the parent branch.

2. Preview what stack will infer and repair.
   stack sync

3. Apply only after the preview looks right.
   stack sync --apply

Use stack status to verify the relevant tracked stack. It hides backup branches,
focuses on the current stack instead of listing every local branch, and
includes open change details when the code host CLI (gh or glab) is available.

Code host selection: github.com and gitlab.com are detected automatically. For
enterprise hosts, run git config stack.codeHost github|gitlab. The temporary
STACK_CODE_HOST=github|gitlab environment override takes precedence.`;

const statusCommand = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const stack = yield* Stack;
    const codeHost = yield* CodeHost.Service;
    const report = yield* stack.status();
    yield* Console.log(
      renderStatus(report, {
        pretty: true,
        reference: codeHost.reference,
        requestLabel: codeHost.requestLabel,
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Show the relevant tracked stack. Use sync to preview target-branch inference and repairs.",
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
    "Show the opinionated happy path for agents and humans using stacked changes.",
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
    yield* Console.log(`track ${link.branch} onto ${link.parent} @ ${link.anchor}`);
  }),
).pipe(
  Command.withDescription(
    "Manually record stack intent only when change target branches do not already encode the stack.",
  ),
  Command.withExamples([
    {
      command: "stack track stack-c --onto stack-b",
      description: "Record that stack-c is stacked on stack-b",
    },
  ]),
);

const syncCommand = Command.make(
  "sync",
  {
    branch: Argument.string("branch").pipe(Argument.optional),
    apply,
    continueOnFailure,
  },
  Effect.fn(function* ({ branch, apply, continueOnFailure }) {
    const stack = yield* Stack;
    const branchValue = Option.getOrUndefined(branch);
    const items = yield* stack.sync({
      apply,
      continueOnFailure,
      ...(branchValue === undefined ? {} : { branch: branchValue }),
    });
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Infer stack links from code-host target branches (GitHub PRs / GitLab MRs), clean stale metadata, repair branches, retarget changes, and refresh stack links. If branch is omitted and the current branch is on a stack, sync only that stack; otherwise sync the repo. By default this is a dry run. Add --apply to mutate branches, changes, and stack metadata.",
  ),
  Command.withExamples([
    {
      command: "stack sync",
      description: "Preview inferred stack links and repairs without changing branches or changes",
    },
    {
      command: "stack sync effectify-watcher",
      description: "Preview only the stack containing effectify-watcher",
    },
    {
      command: "stack sync --apply",
      description: "Run the common stack maintenance workflow",
    },
    {
      command: "stack sync --apply --continue-on-failure",
      description: "Sync independent stacks and summarize any failures at the end",
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
    "Check local Git, code host (GitHub or GitLab), stack metadata, trunk branches, and undo journal health without changing anything.",
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
    "Merge the oldest branch in a stack, preserve a local backup branch, repair descendants, and print the next root branch. If branch is omitted, infer the root from the current branch. By default this is a dry run. Add --apply to merge immediately, --apply --admin to force with admin privileges (GitHub only), or --auto to enable code-host auto-merge and wait until it lands before repairing descendants. Add --auto --through <branch-or-change> for a bounded range.",
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
      description: "Merge the root change, repair descendants, and print the next root branch",
    },
    {
      command: "stack merge effectify-watcher --auto",
      description: "Wait for code-host merge requirements, then merge and repair descendants",
    },
    {
      command: "stack merge --auto --through effectify-format",
      description: "Auto-merge roots one at a time until the target branch has landed",
    },
    {
      command: "stack merge effectify-watcher --apply --admin",
      description: "Force-merge the root GitHub PR with admin privileges, then repair descendants",
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
    "Show the most recent applied stack mutation so you can see what changed and what `undo --apply` would restore.",
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
    "Restore the last applied mutation using backup branches and the saved metadata snapshot. By default this is a dry run. Add --apply to actually restore branches, push them, close created changes, and restore stored metadata.",
  ),
  Command.withExamples([
    {
      command: "stack undo",
      description: "Preview the rollback plan for the last applied mutation",
    },
    {
      command: "stack undo --apply",
      description:
        "Restore branch tips, target branches, and metadata from the last mutation journal",
    },
  ]),
);

const cli = Command.make("stack").pipe(
  Command.withDescription(
    "A squash-safe stacked change CLI. Use plain git for normal editing and commits, then use stack to track branch relationships, inspect the graph, sync after parent changes, merge stack roots, and undo the last mutation if needed.",
  ),
  Command.withExamples([
    {
      command: "stack guide",
      description: "Show the recommended stacked change workflow",
    },
    {
      command: "stack sync",
      description: "Preview inferred stack links from code-host target branches",
    },
    {
      command: "stack sync --apply",
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
      const root = yield* proc
        .exec(process.cwd(), "git", ["rev-parse", "--show-toplevel"])
        .pipe(
          Effect.catch((err) =>
            Console.error(err.stderr).pipe(
              Effect.flatMap(() => Effect.fail(new Error("not in a git repository"))),
            ),
          ),
        );

      const dir = yield* proc.exec(root, "git", ["rev-parse", "--git-common-dir"]);
      const git = path.isAbsolute(dir) ? dir : path.join(root, dir);
      const configuredTrunksOut = yield* proc.exec(
        root,
        "git",
        ["config", "--get", "stack.trunks"],
        [0, 1],
      );
      const configuredTrunks = parseTrunksConfig(configuredTrunksOut);
      const blockLinkOut = yield* proc.exec(
        root,
        "git",
        ["config", "--get", "stack.blockLink"],
        [0, 1],
      );
      const blockLink = parseBlockLinkConfig(blockLinkOut);

      return StackConfig.layer({
        root,
        store: path.join(git, "stack", "state.json"),
        journal: path.join(git, "stack", "undo.json"),
        trunks: configuredTrunks.length > 0 ? configuredTrunks : trunks,
        blockLink,
      });
    }),
  ).pipe(Layer.provideMerge(proc));

  const git = Git.live.pipe(Layer.provide(cfg));
  const codeHost = Layer.unwrap(
    Effect.gen(function* () {
      const proc = yield* Proc.Service;
      const cfgValue = yield* StackConfig;
      const remoteOut = yield* proc
        .exec(cfgValue.root, "git", ["config", "--get", "remote.origin.url"], [0, 1])
        .pipe(Effect.catch(() => Effect.succeed("")));
      const configuredOut = yield* proc.exec(
        cfgValue.root,
        "git",
        ["config", "--get", "stack.codeHost"],
        [0, 1],
      );
      const envValue = process.env.STACK_CODE_HOST;
      const explicitValue = envValue ?? (configuredOut || undefined);
      const explicit = CodeHost.providerFrom(explicitValue);
      if (explicitValue && !explicit) {
        return yield* Effect.fail(
          new Error(`invalid code host '${explicitValue}'; expected github or gitlab`),
        );
      }
      const detected = remoteOut ? CodeHost.detectProvider(remoteOut) : null;
      const provider = explicit ?? detected;
      if (!provider) {
        return yield* Effect.fail(
          new Error(
            "unable to determine the code host; configure it with: git config stack.codeHost github|gitlab",
          ),
        );
      }
      return provider === "gitlab" ? CodeHostGitLab.layer : CodeHostGitHub.layer;
    }),
  ).pipe(Layer.provide(cfg));
  const store = Store.live.pipe(Layer.provideMerge(cfg));
  return Stack.layer.pipe(
    Layer.provideMerge(cfg),
    Layer.provideMerge(git),
    Layer.provideMerge(codeHost),
    Layer.provideMerge(Progress.live),
    Layer.provideMerge(store),
  );
})();

const docs = Layer.mergeAll(
  Layer.succeed(Stack, {
    status: () => Effect.die("help-only"),
    adopt: () => Effect.die("help-only"),
    land: () => Effect.die("help-only"),
    links: () => Effect.die("help-only"),
    sync: () => Effect.die("help-only"),
    doctor: () => Effect.die("help-only"),
    last: () => Effect.die("help-only"),
    undo: () => Effect.die("help-only"),
  }),
  CodeHostGitHub.memory(),
);

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
