import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { stackState, StateError } from "../src/domain/model.ts";
import { StackConfig } from "../src/services/Config.ts";
import { Store } from "../src/services/Store.ts";

it.effect.each(["missing", "valid", "corrupt", "denied"] as const)(
  "Store reads %s files directly without an existence check",
  (kind) =>
    Effect.gen(function* () {
      const reads: Array<string> = [];
      const fs = FileSystem.layerNoop({
        exists: () => Effect.die("read the file directly"),
        readFileString: (file) =>
          Effect.gen(function* () {
            reads.push(file);
            if (kind === "valid") return '{"version":1,"links":[]}';
            if (kind === "corrupt") return "invalid json";
            return yield* Effect.fail(
              PlatformError.systemError({
                _tag: kind === "missing" ? "NotFound" : "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: file,
              }),
            );
          }),
      });
      const layer = Store.live.pipe(
        Layer.provide(StackConfig.layer({ root: "/repo" })),
        Layer.provide(fs),
        Layer.provide(Path.layer),
      );
      yield* Effect.gen(function* () {
        const store = yield* Store;
        if (kind === "missing" || kind === "valid") {
          expect(yield* store.read()).toEqual(stackState([]));
          if (kind === "missing") expect(yield* store.readUndo()).toBeNull();
        } else {
          const error = yield* Effect.flip(store.read());
          expect(error).toBeInstanceOf(StateError);
          expect(String(error)).toContain(kind === "corrupt" ? "decode" : "read");
        }
      }).pipe(Effect.provide(layer));
      expect(reads).toHaveLength(kind === "missing" ? 2 : 1);
    }),
);
