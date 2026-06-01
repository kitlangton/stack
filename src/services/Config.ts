import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { branchName, type BranchName } from "../domain/model.ts";

export type Trunk = "dev" | "main" | "master";

export const trunks: ReadonlyArray<Trunk> = ["dev", "main", "master"];

export interface StackConfigService {
  readonly root: string;
  readonly store: string;
  readonly journal: string;
  readonly trunks: ReadonlyArray<BranchName>;
  readonly forgeConcurrency: number;
  readonly forgeWaitIntervalMillis: number;
}

export class StackConfig extends Context.Service<StackConfig, StackConfigService>()(
  "@stack/Config",
) {
  static readonly layer = (opts: {
    root: string;
    store?: string;
    journal?: string;
    trunks?: ReadonlyArray<string>;
    forgeConcurrency?: number;
    forgeWaitIntervalMillis?: number;
  }) =>
    Layer.effect(
      StackConfig,
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return StackConfig.of({
          root: opts.root,
          store: opts.store ?? path.join(opts.root, ".git", "stack", "state.json"),
          journal: opts.journal ?? path.join(opts.root, ".git", "stack", "undo.json"),
          trunks: (opts.trunks ?? trunks).map((name) => branchName(name)),
          forgeConcurrency: opts.forgeConcurrency ?? 4,
          forgeWaitIntervalMillis: opts.forgeWaitIntervalMillis ?? 5_000,
        });
      }),
    );
}
