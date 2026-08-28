import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { ExecError } from "../src/domain/model.ts";
import * as Proc from "../src/platform/proc.ts";
import { StackConfig } from "../src/services/Config.ts";
import { Git } from "../src/services/Git.ts";

const scenario = (owner = false) => {
  const checked: Array<string> = [];
  const proc = Layer.succeed(Proc.Service, {
    exec: (cwd, _tool, args) =>
      Effect.sync(() => {
        if (args[0] === "worktree")
          return [
            "worktree /repo\0HEAD root\0branch refs/heads/dev\0",
            `worktree /other\0HEAD other\0branch refs/heads/${owner ? "topic" : "other"}\0`,
          ].join("\0");
        if (args[0] === "status") {
          checked.push(cwd);
          return owner && cwd === "/other" ? " M file.txt" : "";
        }
        return args[0] === "branch" && args[1] === "--show-current" ? "dev" : "";
      }),
  });
  const layer = Git.live.pipe(
    Layer.provide(StackConfig.layer({ root: "/repo" }).pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(proc),
  );
  return { checked, layer };
};

it.effect.each(["release", "drop", "replay"] as const)(
  "%s does not inspect worktree contents for unrelated branches",
  (operation) => {
    const s = scenario();
    return Effect.gen(function* () {
      const git = yield* Git.Service;
      yield* operation === "replay" ? git.replay("topic", "dev", []) : git[operation]("topic");
      expect(s.checked).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  },
);

it.effect.each(["release", "replay"] as const)(
  "%s still checks and refuses the dirty owning worktree",
  (operation) => {
    const s = scenario(true);
    return Effect.gen(function* () {
      const git = yield* Git.Service;
      const result = operation === "replay" ? git.replay("topic", "dev", []) : git.release("topic");
      expect(yield* Effect.flip(result)).toBeInstanceOf(ExecError);
      expect(s.checked).toEqual(["/other"]);
    }).pipe(Effect.provide(s.layer));
  },
);

it.effect("full worktree inspection still reads all worktree contents", () => {
  const s = scenario();
  return Effect.gen(function* () {
    const git = yield* Git.Service;
    expect(yield* git.worktrees()).toHaveLength(2);
    expect(s.checked.sort()).toEqual(["/other", "/repo"]);
  }).pipe(Effect.provide(s.layer));
});
