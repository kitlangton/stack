import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchRef,
  DirtyWorktreeError,
  ExecError,
  PullLabel,
  pullMeta,
  pullRef,
  stackLink,
  stackState,
  StackState,
} from "../src/domain/model.ts";
import { renderStatus } from "../src/format.ts";
import * as Proc from "../src/platform/proc.ts";
import * as StackGraph from "../src/stackGraph.ts";
import { StackConfig } from "../src/services/Config.ts";
import * as Git from "../src/services/Git.ts";
import * as GitHub from "../src/services/GitHub.ts";
import * as Progress from "../src/services/Progress.ts";
import { Stack } from "../src/services/Stack.ts";
import { Store } from "../src/services/Store.ts";

const ref = (name: string, head = name) => branchRef({ name, head });

const pr = (number: number, head: string, base: string, checks?: string) =>
  pullRef({
    number,
    head,
    base,
    url: `u${number}`,
    draft: false,
    ...(checks ? { checks } : {}),
  });

const bases = (...items: ReadonlyArray<readonly [string, string, string]>) =>
  Object.fromEntries(
    items.flatMap(([branch, parent, anchor]) => {
      const entries: Array<[string, string]> = [[`${branch}:${parent}`, anchor]];
      if (parent === "dev") entries.push([`${branch}:origin/dev`, anchor]);
      return entries;
    }),
  );

const metaFor = (pull: ReturnType<typeof pullRef>, body = "body") =>
  pullMeta({
    number: pull.number,
    title: String(pull.head),
    body,
    head: pull.head,
    base: pull.base,
    url: pull.url,
    draft: pull.draft,
    state: "OPEN",
    labels: [],
  });

const gitAndGithub = (service: Partial<Git.Interface & GitHub.Interface>) => {
  const unused = (tool: string, args: ReadonlyArray<string>) =>
    new ExecError(tool, args, 1, "unused test service");
  const defaults: Git.Interface & GitHub.Interface = {
    dirty: () => Effect.succeed([]),
    fetch: () => Effect.void,
    refs: () => Effect.succeed([]),
    current: () => Effect.succeed(""),
    remote: () => Effect.succeed(Option.none()),
    switch: () => Effect.void,
    head: () => Effect.succeed(Option.none()),
    base: () => Effect.succeed(Option.none()),
    commits: () => Effect.succeed([]),
    novel: (_parent, _branch, commits) => Effect.succeed(commits),
    replay: () => Effect.void,
    backup: () => Effect.void,
    drop: () => Effect.void,
    restore: () => Effect.void,
    push: () => Effect.void,
    auto: () => Effect.void,
    merge: () => Effect.void,
    wait: () => Effect.void,
    pulls: () => Effect.succeed([]),
    pull: (number) => Effect.fail(unused("gh", ["pr", "view", `${number}`])),
    edit: () => Effect.void,
    body: () => Effect.void,
    close: () => Effect.void,
    create: (branch, base) =>
      Effect.fail(unused("gh", ["pr", "create", branch, base])),
  };
  const impl = { ...defaults, ...service };

  return Layer.mergeAll(
    Layer.succeed(Git.Service, Git.Service.of(impl)),
    Layer.succeed(GitHub.Service, GitHub.Service.of(impl)),
  );
};

const refsHead = (
  refs: ReadonlyArray<ReturnType<typeof branchRef>>,
  name: string,
) =>
  refs.find((item) => item.name === name)?.head ??
  (name.startsWith("origin/")
    ? refs.find((item) => item.name === name.slice(7))?.head
    : undefined);

const stackTestLayer = (opts: {
  readonly refs: ReadonlyArray<ReturnType<typeof branchRef>>;
  readonly pulls?: ReadonlyArray<ReturnType<typeof pullRef>>;
  readonly bases?: Readonly<Record<string, string>>;
  readonly current?: string;
  readonly state?: StackState;
  readonly service?: Partial<Git.Interface & GitHub.Interface>;
  readonly progress?: Array<Progress.ProgressEvent>;
}) => {
  const pulls = opts.pulls ?? [];
  return Stack.layer.pipe(
    Layer.provideMerge(
      opts.progress ? Progress.memory(opts.progress) : Progress.noop,
    ),
    Layer.provideMerge(cfg),
    Layer.provideMerge(
      gitAndGithub({
        refs: () => Effect.succeed(opts.refs),
        pulls: () => Effect.succeed(pulls),
        current: () => Effect.succeed(opts.current ?? ""),
        head: (name) =>
          Effect.succeed(Option.fromNullishOr(refsHead(opts.refs, name))),
        base: (branch, parent) =>
          Effect.succeed(
            Option.fromNullishOr(opts.bases?.[`${branch}:${parent}`]),
          ),
        pull: (number) => {
          const pull = pulls.find((item) => item.number === number);
          return pull
            ? Effect.succeed(metaFor(pull))
            : Effect.fail(
                new ExecError("gh", ["pr", "view", `${number}`], 1, "not found"),
              );
        },
        ...opts.service,
      }),
    ),
    Layer.provideMerge(Store.memory(opts.state)),
  );
};

const tempDir = () =>
  Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "stack-e2e-"))),
    (path) =>
      Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(
        Effect.orDie,
      ),
  );

const mkdirp = (path: string) =>
  Effect.tryPromise(() => mkdir(path, { recursive: true }));

const put = (path: string, body: string) =>
  Effect.tryPromise(() => writeFile(path, body));

const shell = (cwd: string, tool: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const proc = yield* Proc.Service;
    return yield* proc.exec(cwd, tool, args);
  });

const commitFile = (repo: string, file: string, body: string, message: string) =>
  Effect.gen(function* () {
    yield* put(join(repo, file), body);
    yield* shell(repo, "git", ["add", file]);
    yield* shell(repo, "git", ["commit", "-m", message]);
  });

const integrationGitHub = (opts: {
  readonly repo: string;
  readonly pulls: ReadonlyArray<ReturnType<typeof pullRef>>;
  readonly metas: ReadonlyArray<ReturnType<typeof pullMeta>>;
  readonly log: Array<string>;
}) =>
  Layer.effect(
    GitHub.Service,
    Effect.gen(function* () {
      const proc = yield* Proc.Service;
      const pulls = yield* Ref.make(Array.from(opts.pulls));
      const metas = yield* Ref.make(
        new Map<number, ReturnType<typeof pullMeta>>(
          opts.metas.map((item) => [Number(item.number), item]),
        ),
      );
      let next = Math.max(0, ...opts.pulls.map((item) => item.number)) + 1;
      const record = (item: string) => Effect.sync(() => opts.log.push(item));
      const run = (args: ReadonlyArray<string>) =>
        proc.exec(opts.repo, "git", args);

      const listOpen = () => Ref.get(pulls);
      const getPull = (pr: number) =>
        Ref.get(metas).pipe(
          Effect.flatMap((items) => {
            const item = items.get(pr);
            return item
              ? Effect.succeed(item)
              : Effect.fail(new ExecError("gh", ["pr", "view", `${pr}`], 1, "not found"));
          }),
        );
      const edit = (pr: number, base: string) =>
        Effect.gen(function* () {
          yield* record(`edit ${pr} ${base}`);
          yield* Ref.update(pulls, (items) =>
            items.map((item) =>
              item.number === pr
                ? pullRef({
                    number: item.number,
                    head: item.head,
                    base,
                    url: item.url,
                    draft: item.draft,
                  })
                : item,
            ),
          );
        });
      const updateBody = (pr: number, body: string) =>
        Effect.gen(function* () {
          yield* record(`body ${pr}`);
          yield* Ref.update(metas, (items) => {
            const nextItems = new Map(items);
            const item = nextItems.get(pr);
            if (item) {
              nextItems.set(
                pr,
                pullMeta({
                  number: item.number,
                  title: item.title,
                  body,
                  head: item.head,
                  base: item.base,
                  url: item.url,
                  draft: item.draft,
                  state: item.state,
                  labels: item.labels,
                }),
              );
            }
            return nextItems;
          });
        });
      const create = (
        branch: string,
        base: string,
        title: string,
        body: string,
        labels: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          const number = next++;
          const made = pullRef({
            number,
            head: branch,
            base,
            url: `https://example.com/${number}`,
            draft: false,
          });
          yield* record(`create ${branch} ${base}`);
          yield* Ref.update(pulls, (items) => [...items, made]);
          yield* Ref.update(metas, (items) =>
            new Map(items).set(
              number,
              pullMeta({
                number,
                title,
                body,
                head: branch,
                base,
                url: made.url,
                draft: false,
                state: "OPEN",
                labels: labels.map((name) => new PullLabel({ name })),
              }),
            ),
          );
          return made;
        });
      const merge = (pr: number) =>
        Effect.gen(function* () {
          const pull = (yield* Ref.get(pulls)).find((item) => item.number === pr);
          if (!pull) {
            return yield* Effect.fail(
              new ExecError("gh", ["pr", "merge", `${pr}`], 1, "not found"),
            );
          }
          yield* record(`merge ${pr}`);
          yield* run(["checkout", String(pull.base)]);
          yield* run(["merge", "--squash", String(pull.head)]);
          yield* run(["commit", "-m", `merge ${pull.head}`]);
          yield* run(["push", "origin", String(pull.base)]);
          yield* Ref.update(pulls, (items) => items.filter((item) => item.number !== pr));
        });

      return GitHub.Service.of({
        auto: (pr) => record(`auto ${pr}`),
        merge,
        wait: (pr) => record(`wait ${pr}`),
        pulls: listOpen,
        pull: getPull,
        edit,
        body: updateBody,
        close: (pr) =>
          Ref.update(pulls, (items) => items.filter((item) => item.number !== pr)),
        create,
      });
    }),
  );

type CommitSpec = {
  readonly file: string;
  readonly body: string;
  readonly message: string;
};

type BranchSpec = {
  readonly name: string;
  readonly parent: string;
  readonly number: number;
  readonly commits: ReadonlyArray<CommitSpec>;
};

const realStack = (opts: {
  readonly branches: ReadonlyArray<BranchSpec>;
  readonly base?: ReadonlyArray<CommitSpec>;
  readonly current?: string;
  readonly state?: StackState;
}) =>
  Effect.gen(function* () {
    const root = yield* tempDir();
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    const log: Array<string> = [];
    const heads = new Map<string, string>();

    yield* shell(root, "git", ["init", "--bare", origin]);
    yield* mkdirp(repo);
    yield* shell(repo, "git", ["init", "-b", "dev"]);
    yield* shell(repo, "git", ["config", "user.email", "stack@example.com"]);
    yield* shell(repo, "git", ["config", "user.name", "Stack Test"]);
    yield* shell(repo, "git", ["remote", "add", "origin", origin]);

    for (const commit of opts.base ?? [
      { file: "base.txt", body: "base\n", message: "base" },
    ]) {
      yield* commitFile(repo, commit.file, commit.body, commit.message);
    }
    yield* shell(repo, "git", ["push", "-u", "origin", "dev"]);
    heads.set("dev", yield* shell(repo, "git", ["rev-parse", "dev"]));

    for (const branch of opts.branches) {
      yield* shell(repo, "git", ["checkout", "-b", branch.name, branch.parent]);
      for (const commit of branch.commits) {
        yield* commitFile(repo, commit.file, commit.body, commit.message);
      }
      yield* shell(repo, "git", ["push", "-u", "origin", branch.name]);
      heads.set(branch.name, yield* shell(repo, "git", ["rev-parse", branch.name]));
    }

    yield* shell(repo, "git", ["checkout", opts.current ?? opts.branches.at(-1)?.name ?? "dev"]);

    const cfgLayer = StackConfig.layer({ root: repo, trunks: ["dev"] }).pipe(
      Layer.provide(NodeServices.layer),
    );
    const layer = Stack.layer.pipe(
      Layer.provideMerge(Progress.noop),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Proc.live),
      Layer.provideMerge(cfgLayer),
      Layer.provideMerge(Git.live.pipe(Layer.provide(cfgLayer))),
      Layer.provideMerge(
        integrationGitHub({
          repo,
          log,
          pulls: opts.branches.map((branch) =>
            pullRef({
              number: branch.number,
              head: branch.name,
              base: branch.parent,
              url: `u${branch.number}`,
              draft: false,
            }),
          ),
          metas: opts.branches.map((branch) =>
            pullMeta({
              number: branch.number,
              title: branch.name,
              body: `Stacked on ${branch.parent}.`,
              head: branch.name,
              base: branch.parent,
              url: `u${branch.number}`,
              draft: false,
              state: "OPEN",
              labels: [],
            }),
          ),
        }),
      ),
      Layer.provideMerge(
        Store.memory(
          opts.state ??
            new StackState({
              version: 1,
              links: opts.branches.map((branch) =>
                stackLink({
                  branch: branch.name,
                  parent: branch.parent,
                  anchor: heads.get(branch.parent)!,
                  pr: branch.number,
                }),
              ),
            }),
        ),
      ),
    );

    return {
      repo,
      log,
      heads,
      layer,
      git: (args: ReadonlyArray<string>) => shell(repo, "git", args),
    };
  });

const cfg = StackConfig.layer({ root: "/tmp/stack", trunks: ["dev"] }).pipe(
  Layer.provide(NodeServices.layer),
);

const platform = Proc.live.pipe(Layer.provideMerge(NodeServices.layer));

const make = (state = new StackState({ version: 1, links: [] })) =>
  Stack.layer.pipe(
    Layer.provideMerge(Progress.noop),
    Layer.provideMerge(cfg),
    Layer.provideMerge(
      Git.test({
        current: "effectify-format",
        remote: "git@github.com:kit/stack.git",
        refs: [
          branchRef({ name: "dev", head: "aaa" }),
          branchRef({ name: "effectify-watcher", head: "bbb" }),
          branchRef({
            name: "effectify-file-watcher-service",
            head: "ccc",
          }),
          branchRef({ name: "effectify-vcs", head: "ddd" }),
          branchRef({ name: "effectify-env-filetime", head: "eee" }),
          branchRef({ name: "effectify-format", head: "fff" }),
        ],
        bases: {
          "effectify-format:effectify-env-filetime": "eee",
          "effectify-env-filetime:effectify-vcs": "ddd",
        },
      }),
    ),
    Layer.provideMerge(
      GitHub.memory({
        pulls: [
          pullRef({
            number: 17544,
            head: "effectify-watcher",
            base: "dev",
            url: "u1",
            draft: false,
          }),
          pullRef({
            number: 17601,
            head: "effectify-file-watcher-service",
            base: "effectify-watcher",
            url: "u2",
            draft: false,
          }),
          pullRef({
            number: 17634,
            head: "effectify-vcs",
            base: "effectify-file-watcher-service",
            url: "u3",
            draft: false,
          }),
          pullRef({
            number: 17640,
            head: "effectify-env-filetime",
            base: "effectify-vcs",
            url: "u4",
            draft: false,
          }),
          pullRef({
            number: 17675,
            head: "effectify-format",
            base: "effectify-env-filetime",
            url: "u5",
            draft: false,
          }),
        ],
      }),
    ),
    Layer.provideMerge(Store.memory(state)),
  );

const makeSync = () => {
  const seen: Array<string> = [];
  const bodies = new Map<number, string>();
  const refs = new Map([
    ["dev", branchRef({ name: "dev", head: "dev-2" })],
    ["stack-b", branchRef({ name: "stack-b", head: "stack-b-1" })],
    ["stack-c", branchRef({ name: "stack-c", head: "stack-c-1" })],
  ]);
  let pulls = [
    pullRef({
      number: 3,
      head: "stack-c",
      base: "stack-b",
      url: "u3",
      draft: false,
    }),
  ];
  const bases = new Map([
    ["stack-b:dev", "dev-1"],
    ["stack-c:stack-b", "stack-b-1"],
  ]);
  const metas = new Map([
    [
      3,
      pullMeta({
        number: 3,
        title: "stack-c",
        body: `## Summary
- child body

<!-- stack:links:start -->
old stack block
Merged
<!-- stack:links:end -->

Footer
`,
        head: "stack-c",
        base: "stack-b",
        url: "u3",
        draft: false,
        state: "OPEN",
        labels: [],
      }),
    ],
    [
      4,
      pullMeta({
        number: 4,
        title: "stack-a",
        body: "## Summary\n- root body\n",
        head: "stack-a",
        base: "dev",
        url: "u4",
        draft: false,
        state: "OPEN",
        labels: [],
      }),
    ],
    [
      5,
      pullMeta({
        number: 5,
        title: "fix+refactor(vcs): old title",
        body: "## Summary\n- old body\n\nStacked on #5.\n",
        head: "stack-b",
        base: "stack-a",
        url: "u5",
        draft: false,
        state: "OPEN",
        labels: [new PullLabel({ name: "beta" })],
      }),
    ],
  ]);

  return {
    seen,
    bodies,
    layer: Stack.layer.pipe(
      Layer.provideMerge(Progress.noop),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        StackConfig.layer({ root: "/tmp/stack", trunks: ["dev"] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(
        gitAndGithub({
          dirty: () => Effect.succeed([]),
          fetch: () => Effect.sync(() => void seen.push("fetch")),
          auto: () => Effect.void,
          merge: (pr: number) => Effect.sync(() => void seen.push(`merge ${pr}`)),
          wait: () => Effect.void,
          refs: () => Effect.succeed(Array.from(refs.values())),
          pulls: () => Effect.succeed(pulls),
          pull: (pr: number) => Effect.succeed(metas.get(pr)!),
          current: () => Effect.succeed("stack-c"),
          switch: (branch: string) =>
            Effect.sync(() => void seen.push(`switch ${branch}`)),
          head: (name: string) =>
            Effect.succeed(
              Option.fromNullishOr(
                refs.get(name)?.head ??
                  (name.startsWith("origin/")
                    ? refs.get(name.slice(7))?.head
                    : undefined),
              ),
            ),
          base: (branch: string, parent: string) =>
            Effect.succeed(
              Option.fromNullishOr(bases.get(`${branch}:${parent}`)),
            ),
          commits: (branch: string, parent: string) =>
            Effect.succeed(
              parent === "origin/dev" && branch === "stack-b"
                ? ["b1"]
                : parent === "stack-b" && branch === "stack-c"
                  ? ["c1"]
                  : [],
            ),
          novel: (_parent: string, _branch: string, commits: ReadonlyArray<string>) => Effect.succeed(commits),
          backup: (branch: string, name: string) =>
            Effect.sync(() => void seen.push(`backup ${branch} ${name}`)),
          drop: (branch: string) => Effect.sync(() => void seen.push(`drop ${branch}`)),
          restore: (branch: string, name: string) =>
            Effect.sync(() => void seen.push(`restore ${branch} ${name}`)),
          replay: (branch: string, parent: string, commits: ReadonlyArray<string>) =>
            Effect.sync(() => {
              seen.push(`rebase ${branch} ${parent}`);
              refs.set(
                branch,
                branchRef({ name: branch, head: `${branch}-2` }),
              );
              bases.set(`${branch}:${parent}`, refs.get(parent)?.head ?? "");
            }),
          push: (branch: string) => Effect.sync(() => void seen.push(`push ${branch}`)),
          edit: (pr: number, base: string) =>
            Effect.sync(() => {
              seen.push(`edit ${pr} ${base}`);
              pulls = pulls.map((pull) =>
                pull.number === pr
                  ? pullRef({
                      number: pull.number,
                      head: pull.head,
                      base,
                      url: pull.url,
                      draft: pull.draft,
                    })
                  : pull,
              );
            }),
          body: (pr: number, body: string) =>
            Effect.sync(() => {
              seen.push(`body ${pr} ${body.includes("### [Stack]")}`);
              bodies.set(pr, body);
              const current = metas.get(pr)!;
              metas.set(
                pr,
                pullMeta({
                  number: current.number,
                  title: current.title,
                  body,
                  head: current.head,
                  base: current.base,
                  url: current.url,
                  draft: current.draft,
                  state: current.state,
                  labels: current.labels,
                }),
              );
            }),
          close: (pr: number) => Effect.sync(() => void seen.push(`close ${pr}`)),
          create: (branch: string, base: string, title: string, body: string, labels: ReadonlyArray<string>) =>
            Effect.sync(() => {
              const pull = pullRef({
                number: 6,
                head: branch,
                base,
                url: "u6",
                draft: false,
              });
              seen.push(`create ${branch} ${base} ${title}`);
              seen.push(body);
              seen.push(`labels ${labels.join(",")}`);
              pulls = [...pulls, pull];
              metas.set(
                pull.number,
                pullMeta({
                  number: pull.number,
                  title,
                  body,
                  head: branch,
                  base,
                  url: pull.url,
                  draft: pull.draft,
                  state: "OPEN",
                  labels: labels.map((name) => new PullLabel({ name })),
                }),
              );
              return pull;
            }),
        }),
      ),
      Layer.provideMerge(
        Store.memory(
          new StackState({
            version: 1,
            links: [
              stackLink({
                branch: "stack-a",
                parent: "dev",
                anchor: "dev-1",
                pr: 4,
              }),
              stackLink({
                branch: "stack-b",
                parent: "stack-a",
                anchor: "stack-a-1",
                pr: 5,
              }),
              stackLink({
                branch: "stack-c",
                parent: "stack-b",
                anchor: "stack-b-1",
                pr: 3,
              }),
            ],
          }),
        ),
      ),
    ),
  };
};

const makeLand = (
  dirty: ReadonlyArray<string> = [],
  currentBranch = "stack-a",
  progress: Array<Progress.ProgressEvent> | null = null,
) => {
  const seen: Array<string> = [];
  const refs = new Map([
    ["dev", branchRef({ name: "dev", head: "dev-2" })],
    ["stack-a", branchRef({ name: "stack-a", head: "stack-a-1" })],
    ["stack-b", branchRef({ name: "stack-b", head: "stack-b-1" })],
    ["stack-c", branchRef({ name: "stack-c", head: "stack-c-1" })],
  ]);
  let pulls = [
    pullRef({
      number: 4,
      head: "stack-a",
      base: "dev",
      url: "u4",
      draft: false,
    }),
    pullRef({
      number: 5,
      head: "stack-b",
      base: "stack-a",
      url: "u5",
      draft: false,
    }),
    pullRef({
      number: 3,
      head: "stack-c",
      base: "stack-b",
      url: "u3",
      draft: false,
    }),
  ];
  const bases = new Map([
    ["stack-a:dev", "dev-1"],
    ["stack-b:stack-a", "stack-a-1"],
    ["stack-c:stack-b", "stack-b-1"],
    ["stack-b:dev", "dev-1"],
  ]);
  let merged = false;

  return {
    seen,
    layer: Stack.layer.pipe(
      Layer.provideMerge(progress ? Progress.memory(progress) : Progress.noop),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        StackConfig.layer({ root: "/tmp/stack", trunks: ["dev"] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(
        gitAndGithub({
          dirty: () => Effect.succeed(Array.from(dirty)),
          fetch: () => Effect.sync(() => void seen.push("fetch")),
          auto: (pr: number) =>
            Effect.sync(() => {
              seen.push(`auto ${pr}`);
              merged = true;
              pulls = pulls.filter((pull) => pull.number !== pr);
            }),
          merge: (pr: number, opts?: { readonly admin?: boolean }) =>
            Effect.sync(() => {
              seen.push(`${opts?.admin ? "admin " : ""}merge ${pr}`);
              pulls = pulls.filter((pull) => pull.number !== pr);
            }),
          wait: (pr: number) =>
            Effect.sync(
              () => void seen.push(`wait ${pr} ${merged ? "merged" : "open"}`),
            ),
          refs: () => Effect.succeed(Array.from(refs.values())),
          pulls: () => Effect.succeed(pulls),
          pull: (pr: number) =>
            Effect.succeed(
              pullMeta({
                number: pr,
                title: "fix+refactor(vcs): old title",
                body: "## Summary\n- old body\n\nStacked on #4.\n",
                head: "stack-a",
                base: "dev",
                url: "u4",
                draft: false,
                state: "OPEN",
                labels: [new PullLabel({ name: "beta" })],
              }),
            ),
          current: () => Effect.succeed(currentBranch),
          switch: (branch: string) =>
            Effect.sync(() => void seen.push(`switch ${branch}`)),
          head: (name: string) =>
            Effect.succeed(
              Option.fromNullishOr(
                refs.get(name)?.head ??
                  (name.startsWith("origin/")
                    ? refs.get(name.slice(7))?.head
                    : undefined),
              ),
            ),
          base: (branch: string, parent: string) =>
            Effect.succeed(
              Option.fromNullishOr(bases.get(`${branch}:${parent}`)),
            ),
          commits: (branch: string, parent: string) =>
            Effect.succeed(
              parent === "dev" && branch === "stack-b"
                ? ["b1"]
                : parent === "stack-b" && branch === "stack-c"
                  ? ["c1"]
                  : [],
            ),
          novel: (_parent: string, _branch: string, commits: ReadonlyArray<string>) => Effect.succeed(commits),
          replay: (branch: string, parent: string, _commits: ReadonlyArray<string>) =>
            Effect.sync(() => {
              seen.push(`rebase ${branch} ${parent}`);
              refs.set(
                branch,
                branchRef({ name: branch, head: `${branch}-2` }),
              );
              bases.set(`${branch}:${parent}`, refs.get(parent)?.head ?? "");
            }),
          backup: (branch: string, name: string) =>
            Effect.sync(() => void seen.push(`backup ${branch} ${name}`)),
          drop: (branch: string) => Effect.sync(() => void seen.push(`drop ${branch}`)),
          restore: () => Effect.void,
          push: (branch: string) => Effect.sync(() => void seen.push(`push ${branch}`)),
          edit: (pr: number, base: string) =>
            Effect.sync(() => {
              seen.push(`edit ${pr} ${base}`);
              pulls = pulls.map((pull) =>
                pull.number === pr
                  ? pullRef({
                      number: pull.number,
                      head: pull.head,
                      base,
                      url: pull.url,
                      draft: pull.draft,
                    })
                  : pull,
              );
            }),
          body: (pr: number, body: string) =>
            Effect.sync(
              () => void seen.push(`body ${pr} ${body.includes("### [Stack]")}`),
            ),
          close: () => Effect.void,
          create: (branch: string, base: string, title: string, body: string, labels: ReadonlyArray<string>) =>
            Effect.sync(() => {
              const pull = pullRef({
                number: 6,
                head: branch,
                base,
                url: "u6",
                draft: false,
              });
              seen.push(`create ${branch} ${base} ${title}`);
              seen.push(body);
              seen.push(`labels ${labels.join(",")}`);
              pulls = [...pulls, pull];
              return pull;
            }),
        }),
      ),
      Layer.provideMerge(
        Store.memory(
          new StackState({
            version: 1,
            links: [
              stackLink({
                branch: "stack-a",
                parent: "dev",
                anchor: "dev-1",
                pr: 4,
              }),
              stackLink({
                branch: "stack-b",
                parent: "stack-a",
                anchor: "stack-a-1",
                pr: 5,
              }),
              stackLink({
                branch: "stack-c",
                parent: "stack-b",
                anchor: "stack-b-1",
                pr: 3,
              }),
            ],
          }),
        ),
      ),
    ),
  };
};

const makeSyncNovel = () => {
  const seen: Array<string> = [];
  const refs = new Map([
    ["dev", branchRef({ name: "dev", head: "dev-2" })],
    ["stack-b", branchRef({ name: "stack-b", head: "stack-b-1" })],
    ["stack-c", branchRef({ name: "stack-c", head: "stack-c-1" })],
  ]);
  let pulls = [
    pullRef({
      number: 3,
      head: "stack-c",
      base: "stack-b",
      url: "u3",
      draft: false,
    }),
  ];

  return {
    seen,
    layer: Stack.layer.pipe(
      Layer.provideMerge(Progress.noop),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        StackConfig.layer({ root: "/tmp/stack", trunks: ["dev"] }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(
        gitAndGithub({
          dirty: () => Effect.succeed([]),
          fetch: () => Effect.sync(() => void seen.push("fetch")),
          auto: () => Effect.void,
          merge: () => Effect.void,
          wait: () => Effect.void,
          refs: () => Effect.succeed(Array.from(refs.values())),
          pulls: () => Effect.succeed(pulls),
          pull: (pr: number) =>
            Effect.succeed(
              pullMeta({
                number: pr,
                title: "fix+refactor(vcs): old title",
                body: "## Summary\n- old body\n\nStacked on #5.\n",
                head: "stack-b",
                base: "stack-a",
                url: "u5",
                draft: false,
                state: "OPEN",
                labels: [new PullLabel({ name: "beta" })],
              }),
            ),
          current: () => Effect.succeed("stack-c"),
          switch: () => Effect.void,
          head: (name: string) =>
            Effect.succeed(
              Option.fromNullishOr(
                refs.get(name)?.head ??
                  (name.startsWith("origin/")
                    ? refs.get(name.slice(7))?.head
                    : undefined),
              ),
            ),
          base: (branch: string, parent: string) =>
            Effect.succeed(
              Option.fromNullishOr(
                branch === "stack-b" && parent === "origin/dev"
                  ? "dev-1"
                  : branch === "stack-c" &&
                      parent.startsWith("backup/stack-sync-")
                    ? "old-base"
                    : branch === "stack-c" && parent === "stack-b"
                      ? "stack-b-1"
                      : undefined,
              ),
            ),
          commits: (from: string, branch: string) =>
            Effect.succeed(
              from === "dev-1" && branch === "stack-b"
                ? ["b1", "b2"]
                : from === "old-base" && branch === "stack-c"
                  ? ["b1", "b2", "c1"]
                  : [],
            ),
          novel: (parent: string, branch: string, commits: ReadonlyArray<string>) =>
            Effect.succeed(
              parent === "stack-b" && branch === "stack-c"
                ? commits.filter((commit) => commit === "c1")
                : commits,
            ),
          replay: (branch: string, parent: string, commits: ReadonlyArray<string>) =>
            Effect.sync(() => {
              seen.push(`rebase ${branch} ${parent} ${commits.join(",")}`);
              refs.set(
                branch,
                branchRef({ name: branch, head: `${branch}-2` }),
              );
            }),
          backup: () => Effect.void,
          drop: () => Effect.void,
          restore: () => Effect.void,
          push: () => Effect.void,
          edit: (pr: number, base: string) =>
            Effect.sync(() => {
              pulls = pulls.map((pull) =>
                pull.number === pr
                  ? pullRef({
                      number: pull.number,
                      head: pull.head,
                      base,
                      url: pull.url,
                      draft: pull.draft,
                    })
                  : pull,
              );
            }),
          body: () => Effect.void,
          close: () => Effect.void,
          create: (branch: string, base: string) =>
            Effect.succeed(
              pullRef({
                number: 6,
                head: branch,
                base,
                url: "u6",
                draft: false,
              }),
            ),
        }),
      ),
      Layer.provideMerge(
        Store.memory(
          new StackState({
            version: 1,
            links: [
              stackLink({
                branch: "stack-a",
                parent: "dev",
                anchor: "stack-a-1",
                pr: 5,
              }),
              stackLink({
                branch: "stack-b",
                parent: "stack-a",
                anchor: "stack-a-1",
                pr: 5,
              }),
              stackLink({
                branch: "stack-c",
                parent: "stack-b",
                anchor: "stack-b-1",
                pr: 3,
              }),
            ],
          }),
        ),
      ),
    ),
  };
};

describe("StackGraph", () => {
  it("builds status nodes from explicit and inferred parents", () => {
    const graph = StackGraph.make({
      state: stackState([
        stackLink({ branch: "stack-a", parent: "dev", anchor: "dev", pr: 1 }),
      ]),
      refs: [ref("dev"), ref("stack-a", "a"), ref("stack-b", "b")],
      pulls: [pr(1, "stack-a", "dev"), pr(2, "stack-b", "stack-a")],
      trunks: ["dev"],
      current: "stack-b",
    });

    const explicit = graph.report.nodes.find((item) => item.branch === "stack-a");
    const inferred = graph.report.nodes.find((item) => item.branch === "stack-b");

    expect(explicit?.source).toBe("explicit");
    expect(inferred?.parent).toBe("stack-a");
    expect(inferred?.source).toBe("inferred");
    expect(inferred?.issues).toContain("inferred-parent");
  });

  it("answers topology questions from one graph", () => {
    const state = stackState([
      stackLink({ branch: "stack-a", parent: "dev", anchor: "dev", pr: 1 }),
      stackLink({ branch: "stack-b", parent: "stack-a", anchor: "a", pr: 2 }),
      stackLink({ branch: "stack-c", parent: "stack-a", anchor: "a", pr: 3 }),
    ]);
    const graph = StackGraph.make({
      state,
      refs: [
        ref("dev"),
        ref("stack-a", "a"),
        ref("stack-b", "b"),
        ref("stack-c", "c"),
      ],
      pulls: [
        pr(1, "stack-a", "dev"),
        pr(2, "stack-b", "stack-a"),
        pr(3, "stack-c", "stack-a"),
      ],
      trunks: ["dev"],
      current: "stack-b",
    });

    expect(graph.rootOf("stack-b")).toBe("stack-a");
    expect(graph.rank("stack-b")).toBe(2);
    expect(graph.explicitChainFor("stack-b")).toEqual(["stack-a", "stack-b"]);
    expect(graph.wouldCreateCycle("stack-a", "stack-b")).toBe(true);
  });
});

describe("Git", () => {
  it.effect("replay restores current branch and deletes temp branch after failure", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.gen(function* () {
            calls.push([tool, ...args]);
            if (args[0] === "branch" && args[1] === "--show-current") {
              return "stack-c";
            }
            if (args[0] === "cherry-pick" && args[1] !== "--abort") {
              return yield* Effect.fail(new ExecError(tool, args, 1, "conflict"));
            }
            return "";
          }),
      }),
    );

    return Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);
      const git = yield* Git.Service;

      const error = yield* Effect.flip(git.replay("stack-b", "dev", ["b1"]));

      expect(error).toBeInstanceOf(ExecError);
      const temp = calls[1]?.[3];
      expect(temp).toBe("stack/replay-1700000000000-stack-b");
      expect(calls).toEqual([
        ["git", "branch", "--show-current"],
        ["git", "checkout", "-B", temp, "dev"],
        ["git", "cherry-pick", "--empty=drop", "b1"],
        ["git", "cherry-pick", "--abort"],
        ["git", "checkout", "stack-c"],
        ["git", "branch", "-D", temp],
      ]);
    }).pipe(
      Effect.provide(
        Git.live.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc)),
      ),
    );
  });
});

describe("GitHub", () => {
  it.effect("wait polls with the configured interval", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let views = 0;
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            views += 1;
            return JSON.stringify({
              state: "OPEN",
              mergedAt: views === 1 ? null : "2026-01-01T00:00:00Z",
            });
          }),
      }),
    );
    const cfgLayer = StackConfig.layer({
      root: "/tmp/stack",
      trunks: ["dev"],
      githubWaitIntervalMillis: 1_000,
    }).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const github = yield* GitHub.Service;
      const fiber = yield* github.wait(4).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      expect(calls).toHaveLength(1);

      yield* TestClock.adjust("999 millis");
      expect(calls).toHaveLength(1);

      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      expect(calls).toHaveLength(2);
    }).pipe(
      Effect.provide(
        GitHub.layer.pipe(Layer.provideMerge(cfgLayer), Layer.provideMerge(proc)),
      ),
    );
  });
});

describe("Stack", () => {
  it.effect("status uses local stack metadata without inferring from GitHub", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      const report = yield* stack.status();
      const node = report.nodes.find(
        (item) => item.branch === "effectify-format",
      );
      expect(node?.parent).toBeNull();
      expect(node?.source).toBe("root");
      expect(node?.issues).toEqual([]);
    }).pipe(Effect.provide(make())),
  );

  it.effect("adopt stores explicit parent and anchor", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const link = yield* stack.adopt(
        "effectify-format",
        "effectify-env-filetime",
      );
      expect(link.anchor).toBe("eee");

      const state = yield* store.read();
      expect(state.links).toHaveLength(1);
      expect(state.links[0]?.branch).toBe("effectify-format");
      expect(state.links[0]?.parent).toBe("effectify-env-filetime");
    }).pipe(Effect.provide(make())),
  );

  it.effect("adopt rejects trunk, self-parent, and cyclic links", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;

      yield* store.write(
        new StackState({
          version: 1,
          links: [
            stackLink({
              branch: "effectify-env-filetime",
              parent: "effectify-format",
              anchor: "fff",
              pr: 17640,
            }),
          ],
        }),
      );

      const trunk = yield* Effect.flip(
        stack.adopt("dev", "effectify-watcher"),
      );
      expect(String(trunk)).toContain("cannot track trunk branch");

      const self = yield* Effect.flip(
        stack.adopt("effectify-format", "effectify-format"),
      );
      expect(String(self)).toContain("cannot be its own parent");

      const cycle = yield* Effect.flip(
        stack.adopt("effectify-format", "effectify-env-filetime"),
      );
      expect(String(cycle)).toContain("would create a cycle");
    }).pipe(Effect.provide(make())),
  );

  it.effect("status prefers explicit metadata once adopted", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.adopt("effectify-format", "effectify-env-filetime");
      const report = yield* stack.status();
      const node = report.nodes.find(
        (item) => item.branch === "effectify-format",
      );
      expect(node?.source).toBe("explicit");
      expect(node?.issues).toEqual([]);
    }).pipe(Effect.provide(make())),
  );

  it.effect("sync tracks obvious PR-base stacks and journals metadata", () => {
    const refs = [
      ref("dev", "aaa"),
      ref("standalone", "alone"),
      ref("effectify-watcher", "bbb"),
      ref("effectify-file-watcher-service", "ccc"),
      ref("effectify-vcs", "ddd"),
      ref("effectify-env-filetime", "eee"),
      ref("effectify-format", "fff"),
    ];
    const layer = stackTestLayer({
      current: "effectify-format",
      refs,
      pulls: [
        pr(1, "standalone", "dev"),
        pr(17544, "effectify-watcher", "dev"),
        pr(17601, "effectify-file-watcher-service", "effectify-watcher"),
        pr(17634, "effectify-vcs", "effectify-file-watcher-service"),
        pr(17640, "effectify-env-filetime", "effectify-vcs"),
        pr(17675, "effectify-format", "effectify-env-filetime"),
      ],
      bases: bases(
        ["standalone", "dev", "aaa"],
        ["effectify-watcher", "dev", "aaa"],
        ["effectify-file-watcher-service", "effectify-watcher", "bbb"],
        ["effectify-vcs", "effectify-file-watcher-service", "ccc"],
        ["effectify-env-filetime", "effectify-vcs", "ddd"],
        ["effectify-format", "effectify-env-filetime", "eee"],
      ),
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const items = yield* stack.sync();
      const state = yield* store.read();
      const undo = yield* store.readUndo();

      expect(items).toContain("infer link: effectify-watcher -> dev @ aaa");
      expect(items).toContain(
        "infer link: effectify-format -> effectify-env-filetime @ eee",
      );
      expect(state.links.map((link) => String(link.branch))).toEqual([
        "effectify-env-filetime",
        "effectify-file-watcher-service",
        "effectify-format",
        "effectify-vcs",
        "effectify-watcher",
      ]);
      expect(
        state.links.find((link) => link.branch === "standalone"),
      ).toBeUndefined();
      expect(undo?.state.links).toEqual([]);
      expect(undo?.actions).toContain("infer link: effectify-watcher -> dev @ aaa");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync dry-run previews inferred links without storing metadata", () => {
    const events: Array<Progress.ProgressEvent> = [];
    const refs = [
      ref("dev", "aaa"),
      ref("effectify-watcher", "bbb"),
      ref("effectify-file-watcher-service", "ccc"),
    ];
    const layer = stackTestLayer({
      current: "effectify-file-watcher-service",
      refs,
      pulls: [
        pr(17544, "effectify-watcher", "dev"),
        pr(17601, "effectify-file-watcher-service", "effectify-watcher"),
      ],
      bases: bases(
        ["effectify-watcher", "dev", "aaa"],
        ["effectify-file-watcher-service", "effectify-watcher", "bbb"],
      ),
      progress: events,
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const items = yield* stack.sync({ dryRun: true });
      const state = yield* store.read();
      const undo = yield* store.readUndo();

      expect(items).toContain("infer link: effectify-watcher -> dev @ aaa");
      expect(items).toContain(
        "infer link: effectify-file-watcher-service -> effectify-watcher @ bbb",
      );
      expect(items).toContain("would update PR body: #17544 Stack block");
      expect(state.links).toEqual([]);
      expect(undo).toBeNull();
      expect(events).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync dry-run previews stale metadata reconciliation", () => {
    const layer = stackTestLayer({
      current: "stack-b",
      refs: [ref("dev", "aaa"), ref("stack-b", "bbb")],
      pulls: [pr(2, "stack-b", "dev")],
      bases: bases(["stack-b", "dev", "aaa"]),
      state: new StackState({
        version: 1,
        links: [
          stackLink({ branch: "stale", parent: "dev", anchor: "aaa", pr: null }),
          stackLink({ branch: "stack-b", parent: "stale", anchor: "old", pr: 2 }),
        ],
      }),
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const items = yield* stack.sync({ dryRun: true });
      const state = yield* store.read();

      expect(items).toContain(
        "would remove stale link: stale (no open PR and no open child PR depends on it)",
      );
      expect(items).toContain("would update link: stack-b stale -> dev @ aaa");
      expect(state.links.map((link) => String(link.branch))).toEqual([
        "stale",
        "stack-b",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync restores the current branch when link refresh fails", () => {
    const seen: Array<string> = [];
    const refs = [
      ref("dev", "dev-1"),
      ref("stack-a", "a-1"),
      ref("stack-b", "b-1"),
    ];
    const layer = stackTestLayer({
      current: "stack-b",
      refs,
      pulls: [pr(1, "stack-a", "dev"), pr(2, "stack-b", "stack-a")],
      bases: bases(["stack-a", "dev", "dev-1"], ["stack-b", "stack-a", "a-1"]),
      service: {
        switch: (branch) => Effect.sync(() => void seen.push(`switch ${branch}`)),
        body: (number) =>
          Effect.fail(
            new ExecError("gh", ["pr", "edit", `${number}`], 1, "boom"),
          ),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const failed = yield* stack.sync().pipe(
        Effect.flip,
        Effect.map((err) => String(err)),
      );

      expect(failed).toContain("gh pr edit");
      expect(seen).toContain("switch stack-b");
    }).pipe(Effect.provide(layer));
  });

  it.effect("status flags missing parents after branch deletion", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      yield* store.write(
        new StackState({
          version: 1,
          links: [
            stackLink({
              branch: "effectify-format",
              parent: "gone-parent",
              anchor: "eee",
              pr: 17675,
            }),
          ],
        }),
      );
      const report = yield* stack.status();
      const node = report.nodes.find(
        (item) => item.branch === "effectify-format",
      );
      expect(node?.issues).toContain("missing-parent");
    }).pipe(Effect.provide(make())),
  );

  it.effect("renderStatus prints a readable tree", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.adopt("effectify-format", "effectify-env-filetime");
      const view = renderStatus(yield* stack.status());
      expect(view).toContain("└─ effectify-format 👈 current");
      expect(view).toContain("PR: #17675 https://github.com/kit/stack/pull/17675");
      expect(view).toContain("effectify-env-filetime");
      expect(view).not.toContain("inferred-parent");
    }).pipe(Effect.provide(make())),
  );

  it("renderStatus focuses on the current stack and hides backup branches", () => {
    const graph = StackGraph.make({
      state: stackState([
        stackLink({ branch: "stack-a", parent: "dev", anchor: "dev", pr: 1 }),
        stackLink({ branch: "stack-b", parent: "stack-a", anchor: "a", pr: 2 }),
        stackLink({ branch: "other", parent: "dev", anchor: "dev", pr: 3 }),
        stackLink({ branch: "backup/stack-sync-old-stack-b", parent: "dev", anchor: "dev", pr: null }),
      ]),
      refs: [
        ref("dev"),
        ref("stack-a", "a"),
        ref("stack-b", "b"),
        ref("other", "o"),
        ref("backup/stack-sync-old-stack-b", "old"),
      ],
      pulls: [
        pr(1, "stack-a", "dev", "ci passed 3/3"),
        pr(2, "stack-b", "stack-a", "ci failed 1/3"),
        pr(3, "other", "dev"),
      ],
      trunks: ["dev"],
      current: "stack-b",
    });

    const view = renderStatus(graph.report);
    expect(view).toContain("└─ stack-a");
    expect(view).toContain("PR: #1 u1");
    expect(view).toContain("CI: ci passed 3/3");
    expect(view).toContain("└─ stack-b 👈 current");
    expect(view).toContain("PR: #2 u2");
    expect(view).toContain("Base: stack-a");
    expect(view).toContain("CI: ci failed 1/3");
    expect(view).not.toContain("other");
    expect(view).not.toContain("backup/stack-sync-old-stack-b");
  });

  it.effect("doctor reports repository health without mutating", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      const items = yield* stack.doctor();

      expect(items).toContain("ok current branch: effectify-format");
      expect(items).toContain("ok worktree clean");
      expect(items).toContain("ok trunk branch: dev");
      expect(items).toContain("ok open PRs visible: 5");
      expect(items).toContain("ok stack metadata: 0 link(s)");
      expect(items).toContain("ok undo journal: none");
    }).pipe(Effect.provide(make())),
  );

  it.effect("repair fixes a missing parent and recreates the child pr", () => {
    const test = makeSync();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const items = yield* stack.repair(true);
      const state = yield* store.read();

      expect(items).toContain("reparent stack-b: stack-a -> dev");
      expect(
        items.some((item) =>
          item.startsWith("backup stack-b -> backup/stack-sync-"),
        ),
      ).toBe(true);
      expect(items).toContain("rebase stack-b onto dev");
      expect(items).toContain("create pr #6 for stack-b -> dev");
      expect(
        items.some((item) =>
          item.startsWith("backup stack-c -> backup/stack-sync-"),
        ),
      ).toBe(true);
      expect(items).toContain("rebase stack-c onto stack-b");
      expect(test.seen[0]).toBe("fetch");
      expect(
        test.seen[1]?.startsWith("backup stack-b backup/stack-sync-"),
      ).toBe(true);
      expect(test.seen[2]).toBe("rebase stack-b origin/dev");
      expect(test.seen[3]).toBe("push stack-b");
      expect(test.seen[4]).toBe(
        "create stack-b dev fix+refactor(vcs): old title",
      );
      expect(test.seen[5]).toContain(
        "Restacked from #5 onto `dev` after parent merge.",
      );
      expect(test.seen[6]).toBe("labels beta");
      expect(
        test.seen[7]?.startsWith("backup stack-c backup/stack-sync-"),
      ).toBe(true);
      expect(test.seen[8]).toBe("rebase stack-c stack-b");
      expect(test.seen[9]).toBe("push stack-c");
      expect(
        state.links.find((item) => item.branch === "stack-b")?.parent,
      ).toBe("dev");
      expect(state.links.find((item) => item.branch === "stack-b")?.pr).toBe(6);
      expect(
        state.links.find((item) => item.branch === "stack-c")?.anchor,
      ).toBe("stack-b-2");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("repair is dry-run by default", () => {
    const test = makeSync();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const items = yield* stack.repair();
      const state = yield* store.read();
      const undo = yield* store.readUndo();

      expect(items).toContain("would reparent stack-b: stack-a -> dev");
      expect(items).toContain("would rebase stack-b onto dev");
      expect(items).toContain("would create pr for stack-b -> dev");
      expect(test.seen).toEqual(["fetch"]);
      expect(
        state.links.find((item) => item.branch === "stack-b")?.parent,
      ).toBe("stack-a");
      expect(undo).toBeNull();
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "repair filters already-upstream parent commits before replay",
    () => {
      const test = makeSyncNovel();

      return Effect.gen(function* () {
        const stack = yield* Stack;
        const items = yield* stack.repair(true);

        expect(items).toContain("rebase stack-b onto dev");
        expect(items).toContain("rebase stack-c onto stack-b");
        expect(test.seen).toContain("rebase stack-c stack-b c1");
        expect(test.seen).not.toContain("rebase stack-c stack-b b1,b2,c1");
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect(
    "sync uses stored child anchor after squash-merged parent is removed",
    () => {
      const seen: Array<string> = [];
      const pulls = [pr(2, "child", "dev")];
      const layer = stackTestLayer({
        current: "child",
        refs: [ref("dev", "dev-squash"), ref("child", "child-head")],
        pulls,
        bases: bases(["child", "dev", "dev-squash"]),
        state: stackState([
          stackLink({ branch: "parent", parent: "dev", anchor: "dev-old", pr: 1 }),
          stackLink({ branch: "child", parent: "parent", anchor: "parent-anchor", pr: 2 }),
        ]),
        service: {
          commits: (from: string, branch: string) =>
            Effect.succeed(
              branch === "child" && from === "parent-anchor"
                ? ["child-only"]
                : branch === "child" && from === "dev-squash"
                  ? ["parent-1", "parent-2", "child-only"]
                  : [],
            ),
          novel: (_parent: string, _branch: string, commits: ReadonlyArray<string>) => Effect.succeed(commits),
          replay: (branch: string, parent: string, commits: ReadonlyArray<string>) =>
            Effect.sync(() => seen.push(`rebase ${branch} ${parent} ${commits.join(",")}`)),
        },
      });

      return Effect.gen(function* () {
        const stack = yield* Stack;
        yield* stack.sync({ dryRun: false });

        expect(seen).toContain("rebase child origin/dev child-only");
        expect(seen).not.toContain("rebase child origin/dev parent-1,parent-2,child-only");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("undo restores the last applied mutation", () => {
    const test = makeSync();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      yield* stack.repair(true);
      const items = yield* stack.undo(true);
      const state = yield* store.read();
      const undo = yield* store.readUndo();

      expect(
        items.some(
          (item) =>
            item === "switch to dev" ||
            item.startsWith("restore stack-b from backup/stack-sync-"),
        ),
      ).toBe(true);
      expect(items).toContain("switch to dev");
      expect(items).toContain("push stack-b");
      expect(items).toContain("close #6");
      expect(items).toContain("restore stack metadata");
      expect(test.seen).toContain("switch dev");
      expect(
        test.seen.some((item) =>
          item.startsWith("restore stack-b backup/stack-sync-"),
        ),
      ).toBe(true);
      expect(test.seen).toContain("close 6");
      expect(
        state.links.find((item) => item.branch === "stack-b")?.parent,
      ).toBe("stack-a");
      expect(undo).toBeNull();
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("last reports the most recent applied mutation", () => {
    const test = makeSync();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.repair(true);
      const items = yield* stack.last();

      expect(items[0]?.startsWith("last mutation: ")).toBe(true);
      expect(items).toContain("rebase stack-b onto dev");
      expect(items).toContain("create pr #6 for stack-b -> dev");
      expect(items).toContain("undo with: stack undo --apply");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("links updates open PR descriptions with a stack block", () => {
    const test = makeSync();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const items = yield* stack.links(true);

      expect(items).toContain("update PR body: #3 Stack block");
      expect(test.seen).toContain("body 3 true");
      const body = test.bodies.get(3) ?? "";
      expect(body).toContain("## Summary\n- child body");
      expect(body).toContain("Footer");
      expect(body.match(/<!-- stack:links:start -->/g)).toHaveLength(1);
      expect(body.match(/<!-- stack:links:end -->/g)).toHaveLength(1);
      expect(body).not.toContain("old stack block");
      expect(body).toContain("### [Stack](https://github.com/kitlangton/stack)");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "links render the stack as chronological GitHub checkboxes",
    () => {
      const test = makeSync();

      return Effect.gen(function* () {
        const stack = yield* Stack;
        yield* stack.links(true);

        const body = test.bodies.get(3) ?? "";
        expect(body).not.toContain("Base:");
        expect(body).not.toContain("Earlier in Stack");
        expect(body).not.toContain("Current / Remaining");
        expect(body).not.toContain("\nMerged\n");
        expect(body).toContain("1. #4");
        expect(body).toContain("2. #5");
        expect(body).toContain("3. **#3** 👈 current");
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("links render the current path through a forked stack", () => {
    const bodies = new Map<number, string>();
    const pulls = [
      pullRef({ number: 1, head: "stack-a", base: "dev", url: "u1", draft: false }),
      pullRef({ number: 2, head: "stack-b", base: "stack-a", url: "u2", draft: false }),
      pullRef({ number: 3, head: "stack-c", base: "stack-a", url: "u3", draft: false }),
    ];
    const metas = new Map(
      pulls.map((pull) => [
        Number(pull.number),
        pullMeta({
          number: pull.number,
          title: String(pull.head),
          body: `body ${pull.head}`,
          head: pull.head,
          base: pull.base,
          url: pull.url,
          draft: pull.draft,
          state: "OPEN",
          labels: [],
        }),
      ]),
    );
    const layer = Stack.layer.pipe(
      Layer.provideMerge(Progress.noop),
      Layer.provideMerge(cfg),
      Layer.provideMerge(
        gitAndGithub({
          dirty: () => Effect.succeed([]),
          fetch: () => Effect.void,
          auto: () => Effect.void,
          merge: () => Effect.void,
          wait: () => Effect.void,
          refs: () =>
            Effect.succeed([
              branchRef({ name: "dev", head: "dev" }),
              branchRef({ name: "stack-a", head: "a" }),
              branchRef({ name: "stack-b", head: "b" }),
              branchRef({ name: "stack-c", head: "c" }),
            ]),
          pulls: () => Effect.succeed(pulls),
          pull: (pr: number) => Effect.succeed(metas.get(pr)!),
          current: () => Effect.succeed("stack-b"),
          switch: () => Effect.void,
          head: () => Effect.succeed(Option.none()),
          base: () => Effect.succeed(Option.none()),
          commits: () => Effect.succeed([]),
          novel: (_parent, _branch, commits) => Effect.succeed(commits),
          replay: () => Effect.void,
          backup: () => Effect.void,
          drop: () => Effect.void,
          restore: () => Effect.void,
          push: () => Effect.void,
          edit: () => Effect.void,
          body: (pr: number, body: string) =>
            Effect.sync(() => void bodies.set(pr, body)),
          close: () => Effect.void,
          create: () =>
            Effect.fail(new ExecError("gh", ["pr", "create"], 1, "unused")),
        }),
      ),
      Layer.provideMerge(
        Store.memory(
          new StackState({
            version: 1,
            links: [
              stackLink({ branch: "stack-a", parent: "dev", anchor: "dev", pr: 1 }),
              stackLink({ branch: "stack-b", parent: "stack-a", anchor: "a", pr: 2 }),
              stackLink({ branch: "stack-c", parent: "stack-a", anchor: "a", pr: 3 }),
            ],
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.links(true);
      const body = bodies.get(2) ?? "";
      expect(body).toContain("1. #1");
      expect(body).toContain("2. **#2** 👈 current");
      expect(body).not.toContain("stack-c");
    }).pipe(Effect.provide(layer));
  });

  it.effect("links preserve merged history from the previous stack block", () => {
    const bodies = new Map<number, string>();
    const old = `<!-- stack:links:start -->
### Stack

- [x] #1 \`stack-a\`
- [ ] #2
- [ ] **#3** 👈 current
<!-- stack:links:end -->`;
    const pulls = [pr(2, "stack-b", "dev"), pr(3, "stack-c", "stack-b")];
    const layer = stackTestLayer({
      current: "stack-c",
      refs: [ref("dev"), ref("stack-b"), ref("stack-c")],
      pulls,
      state: new StackState({
        version: 1,
        links: [
          stackLink({ branch: "stack-b", parent: "dev", anchor: "dev", pr: 2 }),
          stackLink({ branch: "stack-c", parent: "stack-b", anchor: "b", pr: 3 }),
        ],
      }),
      service: {
        pull: (number) => {
          const pull = pulls.find((item) => item.number === number)!;
          return Effect.succeed(metaFor(pull, number === 3 ? old : "body"));
        },
        body: (number, body) => Effect.sync(() => void bodies.set(number, body)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.links(true);

      const body = bodies.get(3) ?? "";
      expect(body).toContain("1. #1");
      expect(body).toContain("2. #2");
      expect(body).toContain("3. **#3** 👈 current");
    }).pipe(Effect.provide(layer));
  });

  it.effect("links drop unchecked replaced PR history from the previous stack block", () => {
    const bodies = new Map<number, string>();
    const old = `<!-- stack:links:start -->
### Stack

- [x] #1
- [ ] #2
- [ ] **#3** 👈 current
<!-- stack:links:end -->`;
    const pulls = [pr(4, "stack-b", "dev")];
    const layer = stackTestLayer({
      current: "stack-b",
      refs: [ref("dev"), ref("stack-b")],
      pulls,
      state: new StackState({
        version: 1,
        links: [
          stackLink({ branch: "stack-b", parent: "dev", anchor: "dev", pr: 4 }),
        ],
      }),
      service: {
        pull: (number) =>
          Effect.succeed(metaFor(pulls.find((item) => item.number === number)!, old)),
        body: (number, body) => Effect.sync(() => void bodies.set(number, body)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.links(true);

      const body = bodies.get(4) ?? "";
      expect(body).toContain("1. #1");
      expect(body).not.toContain("#2");
      expect(body).not.toContain("#3");
      expect(body).toContain("2. **#4** 👈 current");
    }).pipe(Effect.provide(layer));
  });

  it.effect("links preserve numbered stack history from the previous stack block", () => {
    const bodies = new Map<number, string>();
    const old = `<!-- stack:links:start -->
### Stack

1. #1
2. #2
3. **#3** 👈 current
<!-- stack:links:end -->`;
    const pulls = [pr(4, "stack-b", "dev")];
    const layer = stackTestLayer({
      current: "stack-b",
      refs: [ref("dev"), ref("stack-b")],
      pulls,
      state: new StackState({
        version: 1,
        links: [
          stackLink({ branch: "stack-b", parent: "dev", anchor: "dev", pr: 4 }),
        ],
      }),
      service: {
        pull: (number) =>
          Effect.succeed(metaFor(pulls.find((item) => item.number === number)!, old)),
        body: (number, body) => Effect.sync(() => void bodies.set(number, body)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.links(true);

      const body = bodies.get(4) ?? "";
      expect(body).toContain("1. #1");
      expect(body).toContain("2. #2");
      expect(body).toContain("3. #3");
      expect(body).toContain("4. **#4** 👈 current");
    }).pipe(Effect.provide(layer));
  });

  it.effect("land plans and applies a root merge", () => {
    const planTest = makeLand();
    const doneTest = makeLand();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const plan = yield* stack.land("stack-a");
      expect(plan).toContain("would merge #4 (stack-a)");
      expect(
        plan.some((item) =>
          item.startsWith("would backup stack-a -> backup/landed-"),
        ),
      ).toBe(true);
    })
      .pipe(Effect.provide(planTest.layer))
      .pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const stack = yield* Stack;
            const done = yield* stack.land("stack-a", { apply: true });
            expect(done).toContain("switch to dev");
            expect(done).toContain("merge #4 (stack-a)");
            expect(done).toContain("retarget #5 (stack-b) to dev before merge");
            expect(done).toContain("reparent stack-b: stack-a -> dev");
            expect(done).toContain("next root: stack-b");
            expect(done).toContain("Stack");
            expect(done.join("\n")).toContain("└─ stack-b #5");
            expect(doneTest.seen[0]).toBe("switch dev");
            expect(
              doneTest.seen[1]?.startsWith("backup stack-a backup/landed-"),
            ).toBe(true);
            expect(doneTest.seen[2]).toBe("edit 5 dev");
            expect(doneTest.seen[3]).toBe("merge 4");
            expect(doneTest.seen[4]).toBe("drop stack-a");
            expect(doneTest.seen[5]).toBe("fetch");
          }).pipe(Effect.provide(doneTest.layer)),
        ),
      );
  });

  it.effect("land infers the root from the current stack branch", () => {
    const test = makeLand([], "stack-c");

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const plan = yield* stack.land();
      expect(plan).toContain("would merge #4 (stack-a)");
      expect(plan).toContain("next root: stack-b");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land infers the only stack root when current branch is off-stack", () => {
    const test = makeLand([], "dev");

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const plan = yield* stack.land();
      expect(plan).toContain("would merge #4 (stack-a)");
      expect(plan).toContain("next root: stack-b");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land auto enables auto-merge and waits before repair", () => {
    const test = makeLand();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const done = yield* stack.land("stack-a", { auto: true });
      expect(done).toContain("enable auto-merge #4 (stack-a)");
      expect(done).toContain("wait for #4 to merge");
      expect(done).toContain("retarget #5 (stack-b) to dev before merge");
      expect(done).toContain("reparent stack-b: stack-a -> dev");
      expect(done).toContain("next root: stack-b");
      expect(test.seen[0]).toBe("switch dev");
      expect(test.seen[1]?.startsWith("backup stack-a backup/landed-")).toBe(
        true,
      );
      expect(test.seen[2]).toBe("edit 5 dev");
      expect(test.seen[3]).toBe("auto 4");
      expect(test.seen[4]).toBe("wait 4 merged");
      expect(test.seen[5]).toBe("drop stack-a");
      expect(test.seen[6]).toBe("fetch");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land can force merge with admin privileges", () => {
    const test = makeLand();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const done = yield* stack.land("stack-a", { apply: true, admin: true });

      expect(done).toContain("admin merge #4 (stack-a)");
      expect(test.seen[3]).toBe("admin merge 4");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land rejects admin without apply", () => {
    const test = makeLand();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const error = yield* Effect.flip(
        stack.land("stack-a", { admin: true }),
      );

      expect(String(error)).toContain("use --admin only with --apply");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land auto emits progress while waiting for merge", () => {
    const events: Array<Progress.ProgressEvent> = [];
    const test = makeLand([], "stack-a", events);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.land("stack-a", { auto: true });

      expect(events.map((event) => Progress.render(event))).toEqual([
        "→ switch to dev",
        expect.stringMatching(/^→ backup stack-a -> backup\/landed-/),
        "→ retarget #5 (stack-b) to dev before merge",
        "→ enable auto-merge #4 (stack-a)",
        "… waiting for #4 to merge",
        "→ drop local stack-a",
        expect.stringMatching(/^→ backup stack-b -> backup\/stack-sync-/),
        "→ rebase stack-b onto dev",
        "→ push stack-b",
        expect.stringMatching(/^→ backup stack-c -> backup\/stack-sync-/),
        "→ rebase stack-c onto stack-b",
        "→ push stack-c",
        "→ update #5 stack block",
        "→ update #3 stack block",
      ]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("repair rebases descendants when an older PR branch changes", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const origin = join(root, "origin.git");
      const repo = join(root, "repo");

      yield* shell(root, "git", ["init", "--bare", origin]);
      yield* mkdirp(repo);
      yield* shell(repo, "git", ["init", "-b", "dev"]);
      yield* shell(repo, "git", ["config", "user.email", "stack@example.com"]);
      yield* shell(repo, "git", ["config", "user.name", "Stack Test"]);
      yield* shell(repo, "git", ["remote", "add", "origin", origin]);

      yield* commitFile(repo, "base.txt", "base\n", "base");
      yield* shell(repo, "git", ["push", "-u", "origin", "dev"]);
      const dev = yield* shell(repo, "git", ["rev-parse", "dev"]);

      yield* shell(repo, "git", ["checkout", "-b", "stack-b"]);
      yield* commitFile(repo, "b.txt", "b1\n", "b1");
      yield* shell(repo, "git", ["push", "-u", "origin", "stack-b"]);
      const oldStackB = yield* shell(repo, "git", ["rev-parse", "stack-b"]);

      yield* shell(repo, "git", ["checkout", "-b", "stack-c"]);
      yield* commitFile(repo, "c.txt", "c\n", "c");
      yield* shell(repo, "git", ["push", "-u", "origin", "stack-c"]);

      yield* shell(repo, "git", ["checkout", "stack-b"]);
      yield* commitFile(repo, "b2.txt", "b2\n", "b2");
      yield* shell(repo, "git", ["push", "origin", "stack-b"]);

      const cfgLayer = StackConfig.layer({ root: repo, trunks: ["dev"] }).pipe(
        Layer.provide(NodeServices.layer),
      );
      const layer = Stack.layer.pipe(
        Layer.provideMerge(Progress.noop),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Proc.live),
        Layer.provideMerge(cfgLayer),
        Layer.provideMerge(Git.live.pipe(Layer.provide(cfgLayer))),
        Layer.provideMerge(
          GitHub.memory({
            pulls: [
              pullRef({
                number: 2,
                head: "stack-b",
                base: "dev",
                url: "u2",
                draft: false,
              }),
              pullRef({
                number: 3,
                head: "stack-c",
                base: "stack-b",
                url: "u3",
                draft: false,
              }),
            ],
          }),
        ),
        Layer.provideMerge(
          Store.memory(
            new StackState({
              version: 1,
              links: [
                stackLink({ branch: "stack-b", parent: "dev", anchor: dev, pr: 2 }),
                stackLink({
                  branch: "stack-c",
                  parent: "stack-b",
                  anchor: oldStackB,
                  pr: 3,
                }),
              ],
            }),
          ),
        ),
      );

      const items = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        return yield* stack.repair(true);
      }).pipe(Effect.provide(layer));

      expect(items).not.toContain("rebase stack-b onto dev");
      expect(items).toContain("rebase stack-c onto stack-b");
      expect(yield* shell(repo, "git", ["merge-base", "stack-c", "stack-b"])).toBe(
        yield* shell(repo, "git", ["rev-parse", "stack-b"]),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.effect("repair is idempotent after repairing a moved parent", () =>
    Effect.gen(function* () {
      const scenario = yield* realStack({
        branches: [
          {
            name: "stack-b",
            parent: "dev",
            number: 2,
            commits: [{ file: "b.txt", body: "b1\n", message: "b1" }],
          },
          {
            name: "stack-c",
            parent: "stack-b",
            number: 3,
            commits: [{ file: "c.txt", body: "c\n", message: "c" }],
          },
        ],
      });

      yield* scenario.git(["checkout", "stack-b"]);
      yield* commitFile(scenario.repo, "b2.txt", "b2\n", "b2");
      yield* scenario.git(["push", "origin", "stack-b"]);

      const result = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const first = yield* stack.repair(true);
        const second = yield* stack.repair(true);
        return { first, second };
      }).pipe(Effect.provide(scenario.layer));

      expect(result.first).toContain("rebase stack-c onto stack-b");
      expect(result.second).not.toContain("rebase stack-c onto stack-b");
      expect(result.second).toContain("stack links are current");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("sync infers stack links in a real git repository", () =>
    Effect.gen(function* () {
      const scenario = yield* realStack({
        current: "stack-c",
        state: new StackState({ version: 1, links: [] }),
        branches: [
          {
            name: "standalone",
            parent: "dev",
            number: 1,
            commits: [{ file: "alone.txt", body: "alone\n", message: "alone" }],
          },
          {
            name: "stack-a",
            parent: "dev",
            number: 2,
            commits: [{ file: "a.txt", body: "a\n", message: "a" }],
          },
          {
            name: "stack-b",
            parent: "stack-a",
            number: 3,
            commits: [{ file: "b.txt", body: "b\n", message: "b" }],
          },
          {
            name: "stack-c",
            parent: "stack-b",
            number: 4,
            commits: [{ file: "c.txt", body: "c\n", message: "c" }],
          },
        ],
      });

      const result = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const store = yield* Store;
        const items = yield* stack.sync();
        const state = yield* store.read();
        const undo = yield* store.readUndo();
        return { items, state, undo };
      }).pipe(Effect.provide(scenario.layer));

      expect(result.items).toContain(
        `infer link: stack-a -> dev @ ${scenario.heads.get("dev")}`,
      );
      expect(result.items).toContain(
        `infer link: stack-b -> stack-a @ ${scenario.heads.get("stack-a")}`,
      );
      expect(result.items).toContain(
        `infer link: stack-c -> stack-b @ ${scenario.heads.get("stack-b")}`,
      );
      expect(result.state.links.map((link) => String(link.branch))).toEqual([
        "stack-a",
        "stack-b",
        "stack-c",
      ]);
      expect(result.undo?.state.links).toEqual([]);
      expect(yield* scenario.git(["branch", "--show-current"])).toBe("stack-c");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("repair keeps backup and undo journal when replay conflicts", () =>
    Effect.gen(function* () {
      const scenario = yield* realStack({
        base: [{ file: "conflict.txt", body: "base\n", message: "base" }],
        branches: [
          {
            name: "stack-b",
            parent: "dev",
            number: 2,
            commits: [{ file: "conflict.txt", body: "b1\n", message: "b1" }],
          },
          {
            name: "stack-c",
            parent: "stack-b",
            number: 3,
            commits: [{ file: "conflict.txt", body: "c\n", message: "c" }],
          },
        ],
      });

      yield* scenario.git(["checkout", "stack-b"]);
      yield* commitFile(scenario.repo, "conflict.txt", "b2\n", "b2");
      yield* scenario.git(["push", "origin", "stack-b"]);

      const result = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const store = yield* Store;
        let failed = false;
        yield* stack.repair(true).pipe(
          Effect.catch(() => Effect.sync(() => {
            failed = true;
          })),
        );
        const undo = yield* store.readUndo();
        return { failed, undo };
      }).pipe(Effect.provide(scenario.layer));

      const backups = yield* scenario.git([
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/backup",
      ]);

      expect(result.failed).toBe(true);
      expect(result.undo).not.toBeNull();
      expect(backups).toContain("stack-c");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("undo restores real branch tips after an applied repair", () =>
    Effect.gen(function* () {
      const scenario = yield* realStack({
        branches: [
          {
            name: "stack-b",
            parent: "dev",
            number: 2,
            commits: [{ file: "b.txt", body: "b1\n", message: "b1" }],
          },
          {
            name: "stack-c",
            parent: "stack-b",
            number: 3,
            commits: [{ file: "c.txt", body: "c\n", message: "c" }],
          },
        ],
      });
      const original = scenario.heads.get("stack-c")!;

      yield* scenario.git(["checkout", "stack-b"]);
      yield* commitFile(scenario.repo, "b2.txt", "b2\n", "b2");
      yield* scenario.git(["push", "origin", "stack-b"]);

      const result = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        yield* stack.repair(true);
        const repaired = yield* scenario.git(["rev-parse", "stack-c"]);
        yield* stack.undo(true);
        const restored = yield* scenario.git(["rev-parse", "stack-c"]);
        return { repaired, restored };
      }).pipe(Effect.provide(scenario.layer));

      expect(result.repaired).not.toBe(original);
      expect(result.restored).toBe(original);
    }).pipe(Effect.provide(platform)),
  );

  it.effect("land apply refuses a dirty worktree before merging", () => {
    const test = makeLand([" M foo.ts", "?? scratch/"]);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      let err = "";
      yield* stack.land("stack-a", { apply: true }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            err =
              cause instanceof DirtyWorktreeError
                ? cause.message
                : String(cause);
          }),
        ),
      );
      expect(err).toContain("worktree is dirty");
      expect(test.seen).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land repairs descendants in a real git repository", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const origin = join(root, "origin.git");
      const repo = join(root, "repo");
      const log: Array<string> = [];

      yield* shell(root, "git", ["init", "--bare", origin]);
      yield* mkdirp(repo);
      yield* shell(repo, "git", ["init", "-b", "dev"]);
      yield* shell(repo, "git", ["config", "user.email", "stack@example.com"]);
      yield* shell(repo, "git", ["config", "user.name", "Stack Test"]);
      yield* shell(repo, "git", ["remote", "add", "origin", origin]);

      yield* commitFile(repo, "base.txt", "base\n", "base");
      yield* shell(repo, "git", ["push", "-u", "origin", "dev"]);
      const dev = yield* shell(repo, "git", ["rev-parse", "dev"]);

      yield* shell(repo, "git", ["checkout", "-b", "stack-a"]);
      yield* commitFile(repo, "a.txt", "a\n", "a");
      yield* shell(repo, "git", ["push", "-u", "origin", "stack-a"]);
      const stackA = yield* shell(repo, "git", ["rev-parse", "stack-a"]);

      yield* shell(repo, "git", ["checkout", "-b", "stack-b"]);
      yield* commitFile(repo, "b.txt", "b\n", "b");
      yield* shell(repo, "git", ["push", "-u", "origin", "stack-b"]);
      const stackB = yield* shell(repo, "git", ["rev-parse", "stack-b"]);

      yield* shell(repo, "git", ["checkout", "-b", "stack-c"]);
      yield* commitFile(repo, "c.txt", "c\n", "c");
      yield* shell(repo, "git", ["push", "-u", "origin", "stack-c"]);

      const cfgLayer = StackConfig.layer({ root: repo, trunks: ["dev"] }).pipe(
        Layer.provide(NodeServices.layer),
      );
      const layer = Stack.layer.pipe(
        Layer.provideMerge(Progress.noop),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Proc.live),
        Layer.provideMerge(cfgLayer),
        Layer.provideMerge(Git.live.pipe(Layer.provide(cfgLayer))),
        Layer.provideMerge(
          integrationGitHub({
            repo,
            log,
            pulls: [
              pullRef({
                number: 1,
                head: "stack-a",
                base: "dev",
                url: "u1",
                draft: false,
              }),
              pullRef({
                number: 2,
                head: "stack-b",
                base: "stack-a",
                url: "u2",
                draft: false,
              }),
              pullRef({
                number: 3,
                head: "stack-c",
                base: "stack-b",
                url: "u3",
                draft: false,
              }),
            ],
            metas: [
              pullMeta({
                number: 1,
                title: "stack-a",
                body: "Stacked on #0.",
                head: "stack-a",
                base: "dev",
                url: "u1",
                draft: false,
                state: "OPEN",
                labels: [],
              }),
              pullMeta({
                number: 2,
                title: "stack-b",
                body: "Stacked on #1.",
                head: "stack-b",
                base: "stack-a",
                url: "u2",
                draft: false,
                state: "OPEN",
                labels: [],
              }),
              pullMeta({
                number: 3,
                title: "stack-c",
                body: "Stacked on #2.",
                head: "stack-c",
                base: "stack-b",
                url: "u3",
                draft: false,
                state: "OPEN",
                labels: [],
              }),
            ],
          }),
        ),
        Layer.provideMerge(
          Store.memory(
            new StackState({
              version: 1,
              links: [
                stackLink({ branch: "stack-a", parent: "dev", anchor: dev, pr: 1 }),
                stackLink({
                  branch: "stack-b",
                  parent: "stack-a",
                  anchor: stackA,
                  pr: 2,
                }),
                stackLink({
                  branch: "stack-c",
                  parent: "stack-b",
                  anchor: stackB,
                  pr: 3,
                }),
              ],
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const store = yield* Store;
        const items = yield* stack.land("stack-a", { apply: true });
        const state = yield* store.read();
        return { items, state };
      }).pipe(Effect.provide(layer));

      expect(log).toContain("merge 1");
      expect(log).toContain("edit 2 dev");
      expect(result.items).toContain("rebase stack-b onto dev");
      expect(result.items).toContain("rebase stack-c onto stack-b");
      expect(result.items).toContain("next root: stack-b");
      expect(result.state.links.find((item) => item.branch === "stack-b")?.parent).toBe("dev");
      expect(yield* shell(repo, "git", ["merge-base", "stack-b", "dev"])).toBe(
        yield* shell(repo, "git", ["rev-parse", "dev"]),
      );
      expect(yield* shell(repo, "git", ["merge-base", "stack-c", "stack-b"])).toBe(
        yield* shell(repo, "git", ["rev-parse", "stack-b"]),
      );
    }).pipe(Effect.provide(platform)),
  );
});
