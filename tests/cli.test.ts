import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Proc from "../src/platform/proc.ts";

it.effect("skill prints the packaged instructions outside a Git repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const proc = yield* Proc.Service;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-skill-" });
    const output = yield* proc.exec(root, "bun", [path.resolve("src/cli.ts"), "skill"]);
    expect(output).toContain("name: stack");
    expect(output).toContain("stack sync");
  }).pipe(Effect.provide(Proc.live.pipe(Layer.provideMerge(NodeServices.layer)))),
);
