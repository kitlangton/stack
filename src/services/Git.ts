import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BranchRef, branchRef, ExecError, ReplayConflictError } from "../domain/model.ts";
import * as Proc from "../platform/proc.ts";
import { StackConfig } from "./Config.ts";

export interface Worktree {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly dirty: ReadonlyArray<string>;
}

export interface Interface {
  readonly dirty: () => Effect.Effect<ReadonlyArray<string>, ExecError>;
  readonly worktrees: () => Effect.Effect<ReadonlyArray<Worktree>, ExecError>;
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
  ) => Effect.Effect<void, ExecError | ReplayConflictError>;
  readonly unmergedPaths: () => Effect.Effect<ReadonlyArray<string>, ExecError>;
  readonly release: (branch: string) => Effect.Effect<void, ExecError>;
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

    const runAt = Effect.fn("Git.runAt")(function* (
      cwd: string,
      tool: string,
      args: ReadonlyArray<string>,
      ok: ReadonlyArray<number> = [0],
    ) {
      return yield* proc.exec(cwd, tool, args, ok);
    });
    const run = Effect.fn("Git.run")(
      (tool: string, args: ReadonlyArray<string>, ok: ReadonlyArray<number> = [0]) =>
        runAt(cfg.root, tool, args, ok),
    );

    const dirtyAt = Effect.fn("Git.dirtyAt")((path: string) =>
      runAt(path, "git", ["status", "--short"]).pipe(
        Effect.map((out) => out.split("\n").filter(Boolean)),
      ),
    );

    const worktrees = Effect.fn("Git.worktrees")(function* () {
      const out = yield* run("git", ["worktree", "list", "--porcelain", "-z"]);
      const records: Array<{
        path: string;
        head: string | null;
        branch: string | null;
        prunable: boolean;
      }> = [];
      let current: {
        path: string;
        head: string | null;
        branch: string | null;
        prunable: boolean;
      } | null = null;
      for (const field of out.split("\0").filter(Boolean)) {
        if (field.startsWith("worktree ")) {
          if (current) records.push(current);
          current = {
            path: field.slice("worktree ".length),
            head: null,
            branch: null,
            prunable: false,
          };
          continue;
        }
        if (!current) continue;
        if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length);
        else if (field.startsWith("branch refs/heads/"))
          current.branch = field.slice("branch refs/heads/".length);
        else if (field === "detached") current.branch = null;
        else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
      }
      if (current) records.push(current);

      return yield* Effect.forEach(
        records.filter((record) => !record.prunable),
        (record) =>
          dirtyAt(record.path).pipe(
            Effect.map(
              (dirty): Worktree => ({
                path: record.path,
                head: record.head,
                branch: record.branch,
                dirty,
              }),
            ),
          ),
        { concurrency: "unbounded" },
      );
    });

    const checkedOutDirtyError = (branch: string, worktree: Worktree) =>
      new ExecError(
        "git",
        ["replay", branch],
        1,
        [
          `${branch} is checked out at ${worktree.path} with local changes:`,
          ...worktree.dirty.map((line) => `  ${line}`),
          "",
          `Commit, stash, or clean that worktree before repairing ${branch}.`,
        ].join("\n"),
      );

    const releaseDirtyError = (branch: string, worktree: Worktree) =>
      new ExecError(
        "git",
        ["release", branch],
        1,
        [
          `${branch} is checked out at ${worktree.path} with local changes:`,
          ...worktree.dirty.map((line) => `  ${line}`),
          "",
          `Commit, stash, or clean that worktree before releasing ${branch}.`,
        ].join("\n"),
      );

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

    const dirty = Effect.fn("Git.dirty")(() => dirtyAt(cfg.root));

    const current = Effect.fn("Git.current")(() => run("git", ["branch", "--show-current"]));
    const remote = Effect.fn("Git.remote")(() =>
      run("git", ["config", "--get", "remote.origin.url"], [0, 1]).pipe(
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
      run("git", ["config", "--get-regexp", "^remote\\..*\\.(push)?url$"], [0, 1]).pipe(
        Effect.map((out) => {
          const map = new Map<string, string>();
          for (const line of out.split("\n").filter(Boolean)) {
            const match = line.match(/^remote\.(.+)\.(push)?url\s+(.+)$/);
            if (!match) continue;
            if (match[2] === "push" || !map.has(match[1]!)) map.set(match[1]!, match[3]!);
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
    const unmergedPaths = Effect.fn("Git.unmergedPaths")(() =>
      run("git", ["diff", "--name-only", "--diff-filter=U"], [0, 1]).pipe(
        Effect.map((out) => out.split("\n").filter(Boolean)),
      ),
    );
    const replay = Effect.fn("Git.replay")(function* (
      branch: string,
      parent: string,
      commits: ReadonlyArray<string>,
    ) {
      const owner = (yield* worktrees()).find((worktree) => worktree.branch === branch) ?? null;
      if (owner && owner.dirty.length > 0) {
        return yield* Effect.fail(checkedOutDirtyError(branch, owner));
      }

      const root = owner?.path ?? cfg.root;
      const current = yield* runAt(root, "git", ["branch", "--show-current"]);
      const now = yield* Clock.currentTimeMillis;
      const temp = `stack/replay-${now}-${branch.replaceAll("/", "-")}`;
      const abortCherryPick = runAt(root, "git", ["cherry-pick", "--abort"], [0, 1, 128]).pipe(
        Effect.asVoid,
        Effect.orDie,
      );
      const deleteTemp = runAt(root, "git", ["branch", "-D", temp], [0, 1]).pipe(
        Effect.asVoid,
        Effect.orDie,
      );
      const restoreCurrent = current
        ? runAt(root, "git", ["checkout", current]).pipe(Effect.asVoid, Effect.orDie)
        : Effect.void;

      yield* Effect.gen(function* () {
        yield* runAt(root, "git", ["checkout", "-B", temp, parent]).pipe(Effect.asVoid);
        if (commits.length > 0) {
          yield* runAt(root, "git", ["cherry-pick", "--empty=drop", ...commits]).pipe(
            Effect.asVoid,
            Effect.catchTag("ExecError", (err) =>
              Effect.gen(function* () {
                const paths = yield* unmergedPaths().pipe(
                  Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
                );
                return yield* Effect.fail(
                  new ReplayConflictError(branch, parent, paths, err.stderr),
                );
              }),
            ),
          );
        }
        if (owner) {
          yield* runAt(root, "git", ["checkout", branch]).pipe(Effect.asVoid);
          yield* runAt(root, "git", ["reset", "--hard", temp]).pipe(Effect.asVoid);
        } else {
          yield* runAt(root, "git", ["branch", "-f", branch, temp]).pipe(Effect.asVoid);
        }
      }).pipe(
        Effect.ensuring(
          abortCherryPick.pipe(Effect.ensuring(restoreCurrent.pipe(Effect.ensuring(deleteTemp)))),
        ),
      );
    });
    const backup = Effect.fn("Git.backup")((branch: string, name: string) =>
      run("git", ["branch", "-f", name, branch]).pipe(Effect.asVoid),
    );
    const release = Effect.fn("Git.release")(function* (branch: string) {
      const owner =
        (yield* worktrees()).find(
          (worktree) => worktree.branch === branch && worktree.path !== cfg.root,
        ) ?? null;
      if (!owner) return;
      if (owner.dirty.length > 0) {
        return yield* Effect.fail(releaseDirtyError(branch, owner));
      }
      return yield* runAt(owner.path, "git", ["checkout", "--detach", "HEAD"]).pipe(Effect.asVoid);
    });
    const drop = Effect.fn("Git.drop")(function* (branch: string) {
      const owner =
        (yield* worktrees()).find(
          (worktree) => worktree.branch === branch && worktree.path !== cfg.root,
        ) ?? null;
      if (owner) {
        return yield* Effect.fail(
          new ExecError(
            "git",
            ["branch", "-D", branch],
            1,
            `${branch} is checked out at ${owner.path}; detach or remove that worktree before deleting the local branch.`,
          ),
        );
      }
      return yield* run("git", ["branch", "-D", branch], [0, 1]).pipe(Effect.asVoid);
    });
    const restore = Effect.fn("Git.restore")((branch: string, name: string) =>
      run("git", ["branch", "-f", branch, name]).pipe(Effect.asVoid),
    );
    const push = Effect.fn("Git.push")((branch: string, remote = "origin") =>
      remote === "origin"
        ? run("git", ["push", "--force-with-lease", "-u", remote, branch]).pipe(Effect.asVoid)
        : run("git", ["fetch", remote, "--prune"]).pipe(
            Effect.flatMap(() => run("git", ["push", "--force-with-lease", remote, branch])),
            Effect.asVoid,
          ),
    );
    return Service.of({
      fetch,
      remotes,
      dirty,
      worktrees,
      refs,
      current,
      remote,
      switch: switch_,
      head,
      base,
      commits,
      novel,
      replay,
      unmergedPaths,
      release,
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
      worktrees: () => Effect.succeed([]),
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
      unmergedPaths: () => Effect.succeed([] as ReadonlyArray<string>),
      release: () => Effect.void,
      backup: () => Effect.void,
      drop: () => Effect.void,
      restore: () => Effect.void,
      push: () => Effect.void,
    }),
  );

export * as Git from "./Git.ts";
