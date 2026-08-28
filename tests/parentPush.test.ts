import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import {
  ExecError,
  pullRef,
  stackLink,
  stackState,
  StateError,
  UndoState,
} from "../src/domain/model.ts";
import * as Proc from "../src/platform/proc.ts";
import { StackConfig } from "../src/services/Config.ts";
import { CodeHostGitHub } from "../src/services/code-host/GitHub.ts";
import { CodeHost } from "../src/services/CodeHost.ts";
import { Git } from "../src/services/Git.ts";
import * as Progress from "../src/services/Progress.ts";
import { Stack } from "../src/services/Stack.ts";
import { Store, type StoreService } from "../src/services/Store.ts";

const platform = Proc.live.pipe(Layer.provideMerge(NodeServices.layer));

const scenario = (
  opts: {
    fork?: boolean;
    second?: boolean;
    remoteChild?: boolean;
    service?: (git: Git.Interface) => Partial<Git.Interface>;
    store?: (store: StoreService) => Partial<StoreService>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const proc = yield* Proc.Service;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-parent-push-" });
    const repo = `${root}/repo`;
    yield* fs.makeDirectory(repo);
    const git = (args: ReadonlyArray<string>) => proc.exec(repo, "git", args);
    yield* git(["init", "--bare", `${root}/origin.git`]);
    yield* git(["init", "-b", "dev"]);
    yield* git(["config", "user.name", "Stack Test"]);
    yield* git(["config", "user.email", "stack@example.com"]);
    yield* git(["config", "commit.gpgsign", "false"]);
    yield* git(["remote", "add", "origin", `${root}/origin.git`]);
    const commit = (file: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(`${repo}/${file}`, `${file}\n`);
        yield* git(["add", file]);
        yield* git(["commit", "-m", file]);
      });
    yield* commit("base");
    const trunk = yield* git(["rev-parse", "HEAD"]);
    yield* git(["checkout", "-b", "parent"]);
    yield* commit("parent1");
    const parent = yield* git(["rev-parse", "HEAD"]);
    yield* git(["checkout", "-b", "child"]);
    yield* commit("child");
    const child = yield* git(["rev-parse", "HEAD"]);
    yield* git(["push", "origin", "dev", "parent", "child"]);
    yield* git(["checkout", "parent"]);
    yield* commit("parent2");
    const tip = yield* git(["rev-parse", "HEAD"]);
    if (opts.remoteChild) yield* git(["branch", "-D", "child"]);
    if (opts.second) {
      yield* git(["branch", "other-parent", tip]);
      yield* git(["branch", "other-child", child]);
      yield* git([
        "push",
        "origin",
        `${parent}:refs/heads/other-parent`,
        `${child}:refs/heads/other-child`,
      ]);
    }
    const cfg = StackConfig.layer({ root: repo, trunks: ["dev"] }).pipe(
      Layer.provide(NodeServices.layer),
    );
    if (opts.fork) {
      yield* git(["init", "--bare", `${root}/fork.git`]);
      yield* git(["remote", "add", "fork", `${root}/fork.git`]);
      yield* git(["push", "fork", `${trunk}:refs/heads/parent`]);
    }
    const adapter = yield* Git.Service.asEffect().pipe(
      Effect.provide(Git.live.pipe(Layer.provide(cfg))),
    );
    const state = stackState([
      stackLink({ branch: "parent", parent: "dev", anchor: trunk, pr: 1 }),
      ...(opts.remoteChild
        ? []
        : [stackLink({ branch: "child", parent: "parent", anchor: parent, pr: 2 })]),
      ...(opts.second
        ? [
            stackLink({ branch: "other-parent", parent: "dev", anchor: trunk, pr: 3 }),
            stackLink({ branch: "other-child", parent: "other-parent", anchor: parent, pr: 4 }),
          ]
        : []),
    ]);
    const store = yield* Store.asEffect().pipe(Effect.provide(Store.memory(state)));
    const host = yield* CodeHost.Service.asEffect().pipe(
      Effect.provide(
        CodeHostGitHub.memory({
          pulls: [
            pullRef({
              number: 1,
              head: "parent",
              base: "dev",
              url: "u1",
              draft: false,
              headRepository: opts.fork ? "contributor/project" : null,
            }),
            pullRef({ number: 2, head: "child", base: "parent", url: "u2", draft: false }),
            ...(opts.second
              ? [
                  pullRef({
                    number: 3,
                    head: "other-parent",
                    base: "dev",
                    url: "u3",
                    draft: false,
                  }),
                  pullRef({
                    number: 4,
                    head: "other-child",
                    base: "other-parent",
                    url: "u4",
                    draft: false,
                  }),
                ]
              : []),
          ],
        }),
      ),
    );
    const layer = Stack.layer.pipe(
      Layer.provideMerge(Progress.noop),
      Layer.provideMerge(Layer.succeed(Git.Service, { ...adapter, ...opts.service?.(adapter) })),
      Layer.provideMerge(cfg),
      Layer.provideMerge(
        Layer.succeed(CodeHost.Service, {
          ...host,
          repository: (url) =>
            url.endsWith("/fork.git") ? "contributor/project" : "upstream/project",
        }),
      ),
      Layer.provideMerge(Layer.succeed(Store, { ...store, ...opts.store?.(store) })),
    );
    return { git, layer, child, tip, parent, trunk, commit, root, repo, adapter, store, state };
  });

it.effect("scoped sync publishes an ahead parent along with its repaired child", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    const lines = yield* Effect.gen(function* () {
      const stack = yield* Stack;
      return yield* stack.sync({ apply: true, branch: "child" });
    }).pipe(Effect.provide(s.layer));
    expect(yield* s.git(["rev-parse", "origin/child"])).not.toBe(s.child);
    expect(yield* s.git(["merge-base", "origin/child", "parent"])).toBe(s.tip);
    expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.tip);
    expect(
      yield* s.git(["--git-dir", `${s.root}/origin.git`, "merge-base", "child", "parent"]),
    ).toBe(s.tip);
    expect(lines.join("\n")).toContain("parent #1 pushed");
  }).pipe(Effect.provide(platform)),
);

it.effect("undo restores the remote parent without rolling back its existing local commits", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      yield* stack.sync({ apply: true, branch: "child" });
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.tip);
      const journal = yield* store.readUndo();
      expect(journal?.version).toBe(2);
      expect(journal).toMatchObject({
        remoteUpdates: [{ branch: "parent", remote: "origin", before: s.parent, after: s.tip }],
      });
      expect(Schema.decodeUnknownSync(UndoState)(JSON.parse(JSON.stringify(journal)))).toEqual(
        journal,
      );
      yield* stack.undo(true);
      expect(yield* s.git(["rev-parse", "parent"])).toBe(s.tip);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.parent);
      expect(yield* s.git(["rev-parse", "child"])).toBe(s.child);
      expect(yield* s.git(["rev-parse", "origin/child"])).toBe(s.child);
      expect(yield* store.readUndo()).toBeNull();
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect(
  "preview includes parent publication without fetching or mutating refs or the journal",
  () =>
    Effect.gen(function* () {
      const s = yield* scenario({
        service: () => ({
          fetch: () => Effect.fail(new ExecError("git", ["fetch"], 1, "preview must not fetch")),
        }),
      });
      const refs = yield* s.git(["show-ref"]);
      const lines = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        return yield* stack.sync({ branch: "child" });
      }).pipe(Effect.provide(s.layer));
      expect(lines.join("\n")).toContain("parent #1 would push");
      expect(yield* s.git(["show-ref"])).toBe(refs);
      expect(yield* s.store.read()).toEqual(s.state);
      expect(yield* s.store.readUndo()).toBeNull();
    }).pipe(Effect.provide(platform)),
);

it.effect("publication and undo preserve different fork and origin parent tips", () =>
  Effect.gen(function* () {
    const s = yield* scenario({ fork: true });
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true, branch: "child" });
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "fork"))).toBe(s.tip);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.tip);
      expect((yield* s.store.readUndo())?.remoteUpdates).toEqual([
        { branch: "parent", remote: "fork", before: s.trunk, after: s.tip },
        { branch: "parent", remote: "origin", before: s.parent, after: s.tip },
      ]);
      yield* stack.undo(true);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "fork"))).toBe(s.trunk);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.parent);
      expect(yield* s.git(["rev-parse", "parent"])).toBe(s.tip);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("undo removes a newly published remote parent without deleting the local branch", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    yield* s.git(["push", "origin", ":refs/heads/parent"]);
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true, branch: "child" });
      expect((yield* s.store.readUndo())?.remoteUpdates?.[0]?.before).toBeNull();
      yield* stack.undo(true);
      expect(Option.isNone(yield* s.adapter.remoteHead("parent", "origin"))).toBe(true);
      expect(yield* s.git(["rev-parse", "parent"])).toBe(s.tip);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("refuses a diverged remote parent before changing its child", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    yield* s.git(["checkout", "dev"]);
    yield* s.commit("remote-only");
    const remote = yield* s.git(["rev-parse", "HEAD"]);
    yield* s.git(["push", "--force", "origin", "HEAD:refs/heads/parent"]);
    yield* s.git(["checkout", "parent"]);
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      const error = yield* Effect.flip(stack.sync({ apply: true, branch: "child" }));
      expect(error.message).toContain("remote tip is not an ancestor");
      expect(yield* s.git(["rev-parse", "child"])).toBe(s.child);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("child", "origin"))).toBe(s.child);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(remote);
      expect(yield* s.store.readUndo()).toBeNull();
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("undo refuses remote parent changes before restoring any local branches", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true, branch: "child" });
      const child = yield* s.git(["rev-parse", "child"]);
      yield* s.commit("later-parent");
      yield* s.git(["push", "origin", "parent"]);
      const refs = yield* s.git(["show-ref"]);
      const error = yield* Effect.flip(stack.undo(true));
      expect(error.message).toContain("remote tip changed since sync");
      expect(yield* s.git(["show-ref"])).toBe(refs);
      expect(yield* s.git(["rev-parse", "child"])).toBe(child);
      expect(yield* s.store.readUndo()).not.toBeNull();
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("checkpoint failure prevents parent publication and descendant repair", () =>
  Effect.gen(function* () {
    const s = yield* scenario({
      store: () => ({
        writeUndo: () => Effect.fail(new StateError("undo.json", "write", "test failure")),
      }),
    });
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      expect((yield* Effect.flip(stack.sync({ apply: true, branch: "child" })))._tag).toBe(
        "StateError",
      );
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.parent);
      expect(yield* s.git(["rev-parse", "child"])).toBe(s.child);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("undo accepts a checkpointed parent push that never happened", () =>
  Effect.gen(function* () {
    const s = yield* scenario({
      service: () => ({
        pushRef: () => Effect.fail(new ExecError("git", ["push"], 1, "test failure")),
      }),
    });
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* Effect.flip(stack.sync({ apply: true, branch: "child" }));
      expect((yield* s.store.readUndo())?.remoteUpdates).toHaveLength(1);
      yield* stack.undo(true);
      expect(yield* s.store.readUndo()).toBeNull();
      expect(yield* s.git(["rev-parse", "parent"])).toBe(s.tip);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.parent);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it("still decodes version 1 undo journals", () => {
  const journal = {
    version: 1,
    at: "before-upgrade",
    state: { version: 1, links: [] },
    entries: [],
    actions: [],
  };
  expect(Schema.decodeUnknownSync(UndoState)(journal)).toEqual(journal);
});

it.effect("journals and undoes publication even when no descendant needs repair", () =>
  Effect.gen(function* () {
    const s = yield* scenario();
    yield* s.git(["rebase", "parent", "child"]);
    yield* s.git(["push", "--force-with-lease", "origin", "child"]);
    const child = yield* s.git(["rev-parse", "child"]);
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true, branch: "child" });
      const journal = yield* s.store.readUndo();
      expect(journal?.entries).toEqual([]);
      expect(journal?.remoteUpdates).toHaveLength(1);
      yield* stack.undo(true);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.parent);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("child", "origin"))).toBe(child);
      expect(yield* s.git(["rev-parse", "parent"])).toBe(s.tip);
      expect(yield* s.git(["rev-parse", "child"])).toBe(child);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("sync does not republish a parent whose remote is already current", () =>
  Effect.gen(function* () {
    let pushes = 0;
    const s = yield* scenario({
      service: (git) => ({
        pushRef: (update) =>
          Effect.gen(function* () {
            pushes += 1;
            yield* git.pushRef(update);
          }),
      }),
    });
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true, branch: "child" });
      expect(pushes).toBe(1);
      yield* stack.sync({ apply: true, branch: "child" });
      expect(pushes).toBe(1);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("scoped parent publication leaves another stack and trunk unchanged", () =>
  Effect.gen(function* () {
    const s = yield* scenario({ second: true });
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true, branch: "child" });
      expect(Option.getOrNull(yield* s.adapter.remoteHead("other-parent", "origin"))).toBe(
        s.parent,
      );
      expect(Option.getOrNull(yield* s.adapter.remoteHead("other-child", "origin"))).toBe(s.child);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("dev", "origin"))).toBe(s.trunk);
      expect(yield* s.git(["rev-parse", "other-child"])).toBe(s.child);
      expect((yield* s.store.readUndo())?.remoteUpdates?.map((update) => update.branch)).toEqual([
        "parent",
      ]);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("keep-going retains earlier publications in every later checkpoint and undo", () =>
  Effect.gen(function* () {
    const checkpoints: Array<UndoState> = [];
    const s = yield* scenario({
      second: true,
      store: (store) => ({
        writeUndo: (run) =>
          Effect.gen(function* () {
            checkpoints.push(run);
            yield* store.writeUndo(run);
          }),
      }),
      service: (git) => ({
        pushRef: (update) =>
          update.branch === "parent"
            ? Effect.fail(new ExecError("git", ["push"], 1, "test failure"))
            : git.pushRef(update),
      }),
    });
    yield* s.git(["checkout", "dev"]);
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      const error = yield* Effect.flip(stack.sync({ apply: true, continueOnFailure: true }));
      expect(error.message).toContain("1 stack synced, 1 stack failed");
      const later = checkpoints.filter((run) =>
        run.remoteUpdates?.some((update) => update.branch === "parent"),
      );
      expect(later.length).toBeGreaterThan(0);
      for (const run of later) {
        expect(run.remoteUpdates?.map((update) => update.branch)).toEqual([
          "other-parent",
          "parent",
        ]);
      }
      yield* stack.undo(true);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("other-parent", "origin"))).toBe(
        s.parent,
      );
      expect(Option.getOrNull(yield* s.adapter.remoteHead("other-child", "origin"))).toBe(s.child);
      expect(yield* s.git(["rev-parse", "other-parent"])).toBe(s.tip);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("undo can resume after restoring only one remote", () =>
  Effect.gen(function* () {
    let undoing = false;
    let failed = false;
    const s = yield* scenario({
      fork: true,
      service: (git) => ({
        pushRef: (update) => {
          if (undoing && update.remote === "origin" && !failed) {
            failed = true;
            return Effect.fail(new ExecError("git", ["push"], 1, "test interruption"));
          }
          return git.pushRef(update);
        },
      }),
    });
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true, branch: "child" });
      undoing = true;
      yield* Effect.flip(stack.undo(true));
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "fork"))).toBe(s.trunk);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.tip);
      expect(yield* s.store.readUndo()).not.toBeNull();
      yield* stack.undo(true);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.parent);
      expect(yield* s.git(["rev-parse", "parent"])).toBe(s.tip);
      expect(yield* s.store.readUndo()).toBeNull();
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("publishes a tracked parent whose open child is only on the remote", () =>
  Effect.gen(function* () {
    const s = yield* scenario({ remoteChild: true });
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true, branch: "parent" });
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.tip);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("child", "origin"))).toBe(s.child);
      expect(Option.isNone(yield* s.adapter.head("child"))).toBe(true);
      yield* stack.undo(true);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.parent);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("unknown push-destination commits give a reconciliation error without mutation", () =>
  Effect.gen(function* () {
    const s = yield* scenario({ fork: true });
    const unknown = yield* s.git([
      "-c",
      "user.name=Stack Test",
      "-c",
      "user.email=stack@example.com",
      "--git-dir",
      `${s.root}/fork.git`,
      "commit-tree",
      `${s.trunk}^{tree}`,
      "-p",
      s.trunk,
      "-m",
      "only on fork",
    ]);
    yield* s.git(["--git-dir", `${s.root}/fork.git`, "update-ref", "refs/heads/parent", unknown]);
    expect(Option.isNone(yield* s.adapter.head(`${unknown}^{commit}`))).toBe(true);
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      const error = yield* Effect.flip(stack.sync({ apply: true, branch: "child" }));
      expect(error.message).toContain("fetch and reconcile it first");
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "fork"))).toBe(unknown);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.parent);
      expect(yield* s.git(["rev-parse", "child"])).toBe(s.child);
      expect(yield* s.store.readUndo()).toBeNull();
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("undo restores the first publication when the second destination fails", () =>
  Effect.gen(function* () {
    const s = yield* scenario({
      fork: true,
      service: (git) => ({
        pushRef: (update) =>
          update.remote === "origin"
            ? Effect.fail(new ExecError("git", ["push"], 1, "test failure"))
            : git.pushRef(update),
      }),
    });
    yield* Effect.gen(function* () {
      const stack = yield* Stack;
      yield* Effect.flip(stack.sync({ apply: true, branch: "child" }));
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "fork"))).toBe(s.tip);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "origin"))).toBe(s.parent);
      expect((yield* s.store.readUndo())?.remoteUpdates).toHaveLength(2);
      yield* stack.undo(true);
      expect(Option.getOrNull(yield* s.adapter.remoteHead("parent", "fork"))).toBe(s.trunk);
      expect(yield* s.git(["rev-parse", "parent"])).toBe(s.tip);
      expect(yield* s.git(["rev-parse", "child"])).toBe(s.child);
      expect(yield* s.store.readUndo()).toBeNull();
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);
