import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { stackState, StackState, type StoreError, StateError, UndoState } from "../domain/model.ts";
import { StackConfig } from "./Config.ts";

export interface StoreService {
  readonly read: () => Effect.Effect<StackState, StoreError>;
  readonly write: (state: StackState) => Effect.Effect<void, StoreError>;
  readonly readUndo: () => Effect.Effect<UndoState | null, StoreError>;
  readonly writeUndo: (state: UndoState) => Effect.Effect<void, StoreError>;
  readonly clearUndo: () => Effect.Effect<void, StoreError>;
}

const empty = () => stackState([]);

export class Store extends Context.Service<Store, StoreService>()("@stack/Store") {
  static readonly live = Layer.effect(
    Store,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cfg = yield* StackConfig;

      const load = <A>(file: string, miss: () => A, parse: (raw: string) => A) =>
        Effect.gen(function* () {
          const has = yield* fs
            .exists(file)
            .pipe(Effect.mapError((err) => new StateError(file, "exists", String(err))));
          if (!has) return miss();

          const raw = yield* fs
            .readFileString(file)
            .pipe(Effect.mapError((err) => new StateError(file, "read", String(err))));

          return yield* Effect.try({
            try: () => parse(raw),
            catch: (err) =>
              new StateError(
                file,
                "decode",
                `${err instanceof Error ? err.message : String(err)}\n\nThe file may be corrupt or from a future version. To recover, delete ${file} and rerun.`,
              ),
          });
        });

      const save = <A>(file: string, value: A, encode: (value: A) => unknown) =>
        Effect.gen(function* () {
          yield* fs
            .makeDirectory(path.dirname(file), { recursive: true })
            .pipe(Effect.mapError((err) => new StateError(file, "mkdir", String(err))));

          const tmp = `${file}.tmp`;
          const body = `${JSON.stringify(encode(value), null, 2)}\n`;

          yield* fs
            .writeFileString(tmp, body)
            .pipe(Effect.mapError((err) => new StateError(tmp, "write", String(err))));

          yield* fs
            .rename(tmp, file)
            .pipe(Effect.mapError((err) => new StateError(file, "rename", String(err))));
        });

      const read = Effect.fn("Store.read")(() =>
        load(cfg.store, empty, (raw) => Schema.decodeUnknownSync(StackState)(JSON.parse(raw))),
      );

      const write = Effect.fn("Store.write")((state: StackState) =>
        save(cfg.store, state, Schema.encodeSync(StackState)),
      );

      const readUndo = Effect.fn("Store.readUndo")(() =>
        load(
          cfg.journal,
          () => null,
          (raw) => Schema.decodeUnknownSync(UndoState)(JSON.parse(raw)),
        ),
      );

      const writeUndo = Effect.fn("Store.writeUndo")((state: UndoState) =>
        save(cfg.journal, state, Schema.encodeSync(UndoState)),
      );

      const clearUndo = Effect.fn("Store.clearUndo")(() =>
        fs.remove(cfg.journal).pipe(Effect.catchTag("PlatformError", () => Effect.void)),
      );

      return Store.of({ read, write, readUndo, writeUndo, clearUndo });
    }),
  );

  static readonly memory = (state = empty()) =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const ref = yield* Ref.make(state);
        const undo = yield* Ref.make<UndoState | null>(null);

        const read = Effect.fn("Store.read")(() => Ref.get(ref));
        const write = Effect.fn("Store.write")((next: StackState) => Ref.set(ref, next));
        const readUndo = Effect.fn("Store.readUndo")(() => Ref.get(undo));
        const writeUndo = Effect.fn("Store.writeUndo")((next: UndoState) => Ref.set(undo, next));
        const clearUndo = Effect.fn("Store.clearUndo")(() => Ref.set(undo, null));

        return Store.of({ read, write, readUndo, writeUndo, clearUndo });
      }),
    );
}
