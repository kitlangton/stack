import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import { ExecError, ReplayConflictError } from "../src/domain/model.ts";
import * as Proc from "../src/platform/proc.ts";
import { StackConfig } from "../src/services/Config.ts";
import { Git } from "../src/services/Git.ts";

const platform = Proc.live.pipe(Layer.provideMerge(NodeServices.layer));

const scenario = (override?: (proc: Proc.Interface) => Proc.Interface) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const proc = yield* Proc.Service;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-git-replay-" });
    const command = (args: ReadonlyArray<string>, ok?: ReadonlyArray<number>) =>
      proc.exec(root, "git", args, ok);
    yield* command(["init", "-b", "dev"]);
    yield* command(["config", "user.name", "Stack Test"]);
    yield* command(["config", "user.email", "stack@example.com"]);
    yield* command(["config", "commit.gpgsign", "false"]);
    const commit = (file: string, content: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(`${root}/${file}`, content);
        yield* command(["add", file]);
        yield* command(["commit", "-m", file]);
        return yield* command(["rev-parse", "HEAD"]);
      });
    yield* commit("base.txt", "base\n");
    yield* command(["checkout", "-b", "topic"]);
    const first = yield* commit("first.txt", "first\n");
    const redundant = yield* commit("shared.txt", "shared\n");
    const last = yield* commit("last.txt", "last\n");
    yield* command(["checkout", "dev"]);
    const parent = yield* commit("shared.txt", "shared\n");
    // Keep the compatibility regression active even on CI's newer Git.
    const calls: Array<ReadonlyArray<string>> = [];
    const compatible = Proc.Service.of({
      exec: (cwd, tool, args, ok) => {
        calls.push(args);
        return args.includes("--empty=drop")
          ? Effect.fail(
              new ExecError(tool, args, 129, "usage: git cherry-pick [<options>] <commit>..."),
            )
          : proc.exec(cwd, tool, args, ok);
      },
    });
    const layer = Git.live.pipe(
      Layer.provide(StackConfig.layer({ root })),
      Layer.provide(Layer.succeed(Proc.Service, override?.(compatible) ?? compatible)),
    );
    const clean = Effect.gen(function* () {
      expect(yield* command(["branch", "--show-current"])).toBe("dev");
      expect(yield* command(["status", "--porcelain"])).toBe("");
      expect(yield* command(["branch", "--list", "stack/replay-*"])).toBe("");
      expect(yield* command(["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"], [0, 1])).toBe(
        "",
      );
      expect(yield* command(["rev-parse", "dev"])).toBe(parent);
    });
    return { root, command, commit, first, redundant, last, parent, layer, calls, clean };
  });

it.effect("replay works without --empty=drop and skips only the redundant middle commit", () =>
  Effect.gen(function* () {
    const s = yield* scenario((proc) => ({
      exec: (cwd, tool, args, ok) =>
        proc
          .exec(cwd, tool, args, ok)
          .pipe(Effect.mapError((err) => new ExecError(tool, args, err.code, "opaque diagnostic"))),
    }));
    yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      yield* git.replay("topic", "dev", [s.first, s.redundant, s.last]);
    }).pipe(Effect.provide(s.layer));
    expect(yield* s.command(["log", "--format=%s", "dev..topic"])).toBe("last.txt\nfirst.txt");
    expect(yield* s.command(["diff", "topic", s.last])).toBe("");
    expect(yield* s.command(["merge-base", "topic", "dev"])).toBe(s.parent);
    expect(s.calls).toContainEqual(["cherry-pick", "--skip"]);
    yield* s.clean;
  }).pipe(Effect.provide(platform)),
);

it.effect("replay still stops on a commit that was originally empty", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    yield* s.command(["checkout", "topic"]);
    yield* s.command(["commit", "--allow-empty", "-m", "originally empty"]);
    const tip = yield* s.command(["rev-parse", "HEAD"]);
    yield* s.command(["checkout", "dev"]);
    const error = yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      return yield* Effect.flip(git.replay("topic", "dev", [s.first, tip, s.last]));
    }).pipe(Effect.provide(s.layer));
    expect(error).toBeInstanceOf(ReplayConflictError);
    expect(s.calls).not.toContainEqual(["cherry-pick", "--skip"]);
    expect(yield* s.command(["rev-parse", "topic"])).toBe(tip);
    yield* s.clean;
  }).pipe(Effect.provide(platform)),
);

it.effect("replay reports conflicts from the owning worktree without moving the branch", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    const sibling = `${s.root}/worktree`;
    yield* s.command(["worktree", "add", sibling, "topic"]);
    yield* s.command(["checkout", "-b", "conflicting", "dev"]);
    yield* s.commit("shared.txt", "conflicting\n");
    yield* s.command(["checkout", "dev"]);
    const error = yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      return yield* Effect.flip(git.replay("topic", "conflicting", [s.first, s.redundant, s.last]));
    }).pipe(Effect.provide(s.layer));
    expect(error).toBeInstanceOf(ReplayConflictError);
    if (error instanceof ReplayConflictError) expect(error.paths).toEqual(["shared.txt"]);
    expect(s.calls).not.toContainEqual(["cherry-pick", "--skip"]);
    expect(yield* s.command(["rev-parse", "topic"])).toBe(s.last);
    expect(yield* s.command(["-C", sibling, "branch", "--show-current"])).toBe("topic");
    expect(yield* s.command(["-C", sibling, "status", "--porcelain"])).toBe("");
    expect(yield* s.command(["-C", sibling, "branch", "--list", "stack/replay-*"])).toBe("");
  }).pipe(Effect.provide(platform)),
);

it.effect("replay does not skip a commit whose commit hook fails", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    const fs = yield* FileSystem.FileSystem;
    const hook = `${s.root}/.git/hooks/prepare-commit-msg`;
    yield* fs.writeFileString(hook, "#!/bin/sh\nprintf 'hook failed\\n' >&2\nexit 1\n");
    yield* fs.chmod(hook, 0o755);
    const error = yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      return yield* Effect.flip(git.replay("topic", "dev", [s.first, s.last]));
    }).pipe(Effect.provide(s.layer));
    expect(error).toBeInstanceOf(ReplayConflictError);
    expect(error.stderr).toContain("hook failed");
    expect(s.calls).not.toContainEqual(["cherry-pick", "--skip"]);
    expect(yield* s.command(["rev-parse", "topic"])).toBe(s.last);
    yield* s.clean;
  }).pipe(Effect.provide(platform)),
);

it.effect("replay stops and cleans up if skipping a redundant commit fails", () =>
  Effect.gen(function* () {
    let attempted = false;
    const s = yield* scenario((proc) => ({
      exec: (cwd, tool, args, ok) => {
        if (args[0] === "cherry-pick" && args[1] === "--skip") {
          attempted = true;
          return Effect.fail(new ExecError(tool, args, 1, "skip failed"));
        }
        return proc.exec(cwd, tool, args, ok);
      },
    }));
    const error = yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      return yield* Effect.flip(git.replay("topic", "dev", [s.first, s.redundant, s.last]));
    }).pipe(Effect.provide(s.layer));
    expect(attempted).toBe(true);
    expect(error.stderr).toBe("skip failed");
    expect(s.calls).not.toContainEqual(["cherry-pick", "--no-rerere-autoupdate", s.last]);
    expect(yield* s.command(["rev-parse", "topic"])).toBe(s.last);
    yield* s.clean;
  }).pipe(Effect.provide(platform)),
);

it.effect("replay does not mistake an auto-staged rerere resolution for a redundant commit", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    yield* s.command(["config", "rerere.enabled", "true"]);
    yield* s.command(["config", "rerere.autoupdate", "true"]);
    yield* s.command(["checkout", "-b", "conflicting", "dev"]);
    const target = yield* s.commit("shared.txt", "conflicting\n");
    yield* s.command(["cherry-pick", s.redundant], [1]);
    yield* s.command(["checkout", "--ours", "shared.txt"]);
    yield* s.command(["add", "shared.txt"]);
    yield* s.command(["rerere"]);
    yield* s.command(["cherry-pick", "--abort"]);
    // The learned resolution now makes a failed pick look clean with autoupdate.
    yield* s.command(["cherry-pick", s.redundant], [1]);
    expect(yield* s.command(["status", "--porcelain"])).toBe("");
    yield* s.command(["cherry-pick", "--abort"]);
    yield* s.command(["checkout", "dev"]);
    const error = yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      return yield* Effect.flip(git.replay("topic", "conflicting", [s.first, s.redundant, s.last]));
    }).pipe(Effect.provide(s.layer));
    expect(error).toBeInstanceOf(ReplayConflictError);
    if (error instanceof ReplayConflictError) expect(error.paths).toEqual(["shared.txt"]);
    expect(s.calls).not.toContainEqual(["cherry-pick", "--skip"]);
    expect(yield* s.command(["rev-parse", "topic"])).toBe(s.last);
    expect(yield* s.command(["rev-parse", "conflicting"])).toBe(target);
    yield* s.clean;
  }).pipe(Effect.provide(platform)),
);
