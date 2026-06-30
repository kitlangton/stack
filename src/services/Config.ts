import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { branchName, type BranchName } from "../domain/model.ts";

export type Trunk = "dev" | "develop" | "main" | "master";

export const trunks: ReadonlyArray<Exclude<Trunk, "develop">> = ["dev", "main", "master"];

export const parseBlockLinkConfig = (value: string): boolean | undefined => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  return undefined;
};

export const parseTrunksConfig = (value: string): ReadonlyArray<string> =>
  value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export interface StackConfigService {
  readonly root: string;
  readonly store: string;
  readonly journal: string;
  readonly trunks: ReadonlyArray<BranchName>;
  readonly blockLink: boolean;
  readonly codeHostConcurrency: number;
  readonly codeHostWaitIntervalMillis: number;
}

export class StackConfig extends Context.Service<StackConfig, StackConfigService>()(
  "@stack/Config",
) {
  static readonly layer = (opts: {
    root: string;
    store?: string;
    journal?: string;
    trunks?: ReadonlyArray<string>;
    blockLink?: boolean | undefined;
    codeHostConcurrency?: number;
    codeHostWaitIntervalMillis?: number;
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
          blockLink: opts.blockLink ?? true,
          codeHostConcurrency: opts.codeHostConcurrency ?? 4,
          codeHostWaitIntervalMillis: opts.codeHostWaitIntervalMillis ?? 5_000,
        });
      }),
    );
}
