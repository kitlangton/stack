import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BranchRef, branchRef, ExecError } from "../domain/model.ts";
import * as Proc from "../platform/proc.ts";
import { StackConfig } from "./Config.ts";

export interface Interface {
  readonly dirty: () => Effect.Effect<ReadonlyArray<string>, ExecError>;
  readonly fetch: () => Effect.Effect<void, ExecError>;
  readonly remotes: () => Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly url: string }>,
    ExecError
  >;
  readonly refs: () => Effect.Effect<ReadonlyArray<BranchRef>, ExecError>;
  readonly current: () => Effect.Effect<string, ExecError>;
  readonly remote: () => Effect.Effect<Option.Option<string>, ExecError>;
  readonly switch: (branch: string) => Effect.Effect<void, ExecError>;
  readonly head: (name: string) => Effect.Effect<Option.Option<string>, ExecError>;
  readonly base: (
    branch: string,
    parent: string,
  ) => Effect.Effect<Option.Option<string>, ExecError>;
  readonly commits: (
    from: string,
    branch: string,
  ) => Effect.Effect<ReadonlyArray<string>, ExecError>;
  readonly novel: (
    parent: string,
    branch: string,
    commits: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, ExecError>;
  readonly replay: (
    branch: string,
    parent: string,
    commits: ReadonlyArray<string>,
  ) => Effect.Effect<void, ExecError>;
  readonly backup: (branch: string, name: string) => Effect.Effect<void, ExecError>;
  readonly drop: (branch: string) => Effect.Effect<void, ExecError>;
  readonly restore: (branch: string, name: string) => Effect.Effect<void, ExecError>;
  readonly push: (branch: string, remote?: string) => Effect.Effect<void, ExecError>;
}

export class Service extends Context.Service<Service, Interface>()("@stack/Git") {}

export const live = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* StackConfig;
    const proc = yield* Proc.Service;

    const run = Effect.fn("Git.run")(function* (
      tool: string,
      args: ReadonlyArray<string>,
      ok: ReadonlyArray<number> = [0],
    ) {
      return yield* proc.exec(cfg.root, tool, args, ok);
    });

    const refs = Effect.fn("Git.refs")(function* () {
      const out = yield* run("git", [
        "for-each-ref",
        "--format=%(refname:short)%00%(objectname)",
        "refs/heads",
      ]);
      return out
        .split("\n")
        .filter(Boolean)
        .map((row) => row.split("\0"))
        .filter(
          (row): row is [string, string] => row.length === 2 && Boolean(row[0]) && Boolean(row[1]),
        )
        .map(([name, head]) => branchRef({ name, head }));
    });

    const dirty = Effect.fn("Git.dirty")(() =>
      run("git", ["status", "--short"]).pipe(Effect.map((out) => out.split("\n").filter(Boolean))),
    );

    const current = Effect.fn("Git.current")(() => run("git", ["branch", "--show-current"]));
    const remote = Effect.fn("Git.remote")(() =>
      run("git", ["remote", "get-url", "origin"], [0, 1]).pipe(
        Effect.map((out) => (out ? Option.some(out) : Option.none<string>())),
      ),
    );
    const switch_ = Effect.fn("Git.switch")((branch: string) =>
      run("git", ["checkout", branch]).pipe(Effect.asVoid),
    );
    const fetch = Effect.fn("Git.fetch")(() =>
      run("git", ["fetch", "origin", "--prune"]).pipe(Effect.asVoid),
    );
    const remotes = Effect.fn("Git.remotes")(() =>
      run("git", ["remote", "-v"], [0, 1]).pipe(
        Effect.map((out) => {
          const map = new Map<string, string>();
          for (const line of out.split("\n").filter(Boolean)) {
            const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
            if (!match) continue;
            if (match[3] === "push" || !map.has(match[1]!)) map.set(match[1]!, match[2]!);
          }
          return [...map].map(([name, url]) => ({ name, url }));
        }),
      ),
    );
    const head = Effect.fn("Git.head")((name: string) =>
      run("git", ["rev-parse", "--verify", name], [0, 1]).pipe(
        Effect.map((out) => (out ? Option.some(out) : Option.none<string>())),
      ),
    );
    const base = Effect.fn("Git.base")(function* (branch: string, parent: string) {
      const out = yield* run("git", ["merge-base", branch, parent], [0, 1]);
      return out ? Option.some(out) : Option.none<string>();
    });
    const commits = Effect.fn("Git.commits")((from: string, branch: string) =>
      run("git", [
        "rev-list",
        "--reverse",
        "--first-parent",
        "--no-merges",
        `${from}..${branch}`,
      ]).pipe(Effect.map((out) => out.split("\n").filter(Boolean))),
    );
    const novel = Effect.fn("Git.novel")((
      parent: string,
      branch: string,
      commits: ReadonlyArray<string>,
    ) => {
      if (commits.length === 0) return Effect.succeed(Array.from(commits));
      return run("git", ["cherry", parent, branch]).pipe(
        Effect.map((out) => {
          const keep = new Set(
            out
              .split("\n")
              .filter((line) => line.startsWith("+ "))
              .map((line) => line.slice(2)),
          );
          return commits.filter((commit) => keep.has(commit));
        }),
      );
    });
    const replay = Effect.fn("Git.replay")(function* (
      branch: string,
      parent: string,
      commits: ReadonlyArray<string>,
    ) {
      const current = yield* run("git", ["branch", "--show-current"]);
      const now = yield* Clock.currentTimeMillis;
      const temp = `stack/replay-${now}-${branch.replaceAll("/", "-")}`;
      const abortCherryPick = run("git", ["cherry-pick", "--abort"], [0, 1, 128]).pipe(
        Effect.asVoid,
        Effect.orDie,
      );
      const deleteTemp = run("git", ["branch", "-D", temp], [0, 1]).pipe(
        Effect.asVoid,
        Effect.orDie,
      );
      const restoreCurrent = current
        ? run("git", ["checkout", current]).pipe(Effect.asVoid, Effect.orDie)
        : Effect.void;

      yield* Effect.gen(function* () {
        yield* run("git", ["checkout", "-B", temp, parent]).pipe(Effect.asVoid);
        if (commits.length > 0) {
          yield* run("git", ["cherry-pick", "--empty=drop", ...commits]).pipe(Effect.asVoid);
        }
        yield* run("git", ["branch", "-f", branch, temp]).pipe(Effect.asVoid);
      }).pipe(
        Effect.ensuring(
          abortCherryPick.pipe(Effect.ensuring(restoreCurrent.pipe(Effect.ensuring(deleteTemp)))),
        ),
      );
    });
    const backup = Effect.fn("Git.backup")((branch: string, name: string) =>
      run("git", ["branch", "-f", name, branch]).pipe(Effect.asVoid),
    );
    const drop = Effect.fn("Git.drop")((branch: string) =>
      run("git", ["branch", "-D", branch], [0, 1]).pipe(Effect.asVoid),
    );
    const restore = Effect.fn("Git.restore")((branch: string, name: string) =>
      run("git", ["branch", "-f", branch, name]).pipe(Effect.asVoid),
    );
    const push = Effect.fn("Git.push")((branch: string, remote = "origin") =>
      (remote === "origin"
        ? Effect.void
        : run("git", ["fetch", remote, "--prune"]).pipe(Effect.asVoid)
      ).pipe(
        Effect.flatMap(() => run("git", ["push", "--force-with-lease", remote, branch])),
        Effect.asVoid,
      ),
    );
    return Service.of({
      fetch,
      remotes,
      dirty,
      refs,
      current,
      remote,
      switch: switch_,
      head,
      base,
      commits,
      novel,
      replay,
      backup,
      drop,
      restore,
      push,
    });
  }),
);

export const test = (opts: {
  current?: string;
  remote?: string;
  refs?: ReadonlyArray<BranchRef>;
  bases?: Readonly<Record<string, string>>;
}) =>
  Layer.succeed(
    Service,
    Service.of({
      fetch: () => Effect.void,
      dirty: () => Effect.succeed([]),
      refs: () => Effect.succeed(opts.refs ?? []),
      remotes: () => Effect.succeed([]),
      current: () => Effect.succeed(opts.current ?? ""),
      remote: () => Effect.succeed(Option.fromNullishOr(opts.remote)),
      switch: () => Effect.void,
      head: (name: string) =>
        Effect.succeed(
          Option.fromNullishOr(
            opts.refs?.find((ref) => ref.name === name)?.head ??
              (name.startsWith("origin/")
                ? opts.refs?.find((ref) => ref.name === name.slice(7))?.head
                : undefined),
          ),
        ),
      base: (branch: string, parent: string) =>
        Effect.succeed(Option.fromNullishOr(opts.bases?.[`${branch}:${parent}`])),
      commits: () => Effect.succeed([]),
      novel: (_parent, _branch, commits) => Effect.succeed(commits),
      replay: () => Effect.void,
      backup: () => Effect.void,
      drop: () => Effect.void,
      restore: () => Effect.void,
      push: () => Effect.void,
    }),
  );
