import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchRef,
  CodeHostChangeNotFoundError,
  DirtyWorktreeError,
  ExecError,
  PullLabel,
  pullMeta,
  pullRef,
  stackLink,
  StackOperationError,
  stackState,
  StackState,
} from "../src/domain/model.ts";
import { renderStatus } from "../src/format.ts";
import * as Proc from "../src/platform/proc.ts";
import { RepairExecution } from "../src/repairExecution.ts";
import * as StackBlock from "../src/stackBlock.ts";
import * as StackGraph from "../src/stackGraph.ts";
import { StackConfig } from "../src/services/Config.ts";
import { CodeHost } from "../src/services/CodeHost.ts";
import { CodeHostGitHub } from "../src/services/code-host/GitHub.ts";
import { CodeHostGitLab } from "../src/services/code-host/GitLab.ts";
import { Git } from "../src/services/Git.ts";
import { GitHub } from "../src/services/GitHub.ts";
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
    headRepository: pull.headRepository,
    base: pull.base,
    url: pull.url,
    draft: pull.draft,
    state: "OPEN",
    labels: [],
  });

const gitAndCodeHost = (service: Partial<Git.Interface & CodeHost.Interface>) => {
  const unused = (tool: string, args: ReadonlyArray<string>) =>
    new ExecError(tool, args, 1, "unused test service");
  const defaults: Git.Interface & CodeHost.Interface = {
    dirty: () => Effect.succeed([]),
    fetch: () => Effect.void,
    remotes: () => Effect.succeed([]),
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
    provider: "github",
    capabilities: { adminMerge: true },
    requestLabel: "PR",
    reference: (number) => `#${number}`,
    repository: CodeHost.repositoryFor,
    changeUrlBase: () => null,
    auto: () => Effect.void,
    merge: () => Effect.void,
    wait: () => Effect.void,
    changes: () => Effect.succeed([]),
    change: (number) => Effect.fail(new CodeHostChangeNotFoundError(number)),
    edit: () => Effect.void,
    body: () => Effect.void,
    close: () => Effect.void,
    create: (branch, base) => Effect.fail(unused("gh", ["pr", "create", branch, base])),
  };
  const impl = { ...defaults, ...service };

  return Layer.mergeAll(
    Layer.succeed(Git.Service, Git.Service.of(impl)),
    Layer.succeed(CodeHost.Service, CodeHost.Service.of(impl)),
  );
};

const refsHead = (refs: ReadonlyArray<ReturnType<typeof branchRef>>, name: string) =>
  refs.find((item) => item.name === name)?.head ??
  (name.startsWith("origin/") ? refs.find((item) => item.name === name.slice(7))?.head : undefined);

const stackTestLayer = (opts: {
  readonly refs: ReadonlyArray<ReturnType<typeof branchRef>>;
  readonly pulls?: ReadonlyArray<ReturnType<typeof pullRef>>;
  readonly bases?: Readonly<Record<string, string>>;
  readonly current?: string;
  readonly state?: StackState;
  readonly service?: Partial<Git.Interface & CodeHost.Interface>;
  readonly progress?: Array<Progress.ProgressEvent>;
}) => {
  const pulls = opts.pulls ?? [];
  return Stack.layer.pipe(
    Layer.provideMerge(opts.progress ? Progress.memory(opts.progress) : Progress.noop),
    Layer.provideMerge(cfg),
    Layer.provideMerge(
      gitAndCodeHost({
        refs: () => Effect.succeed(opts.refs),
        changes: () => Effect.succeed(pulls),
        current: () => Effect.succeed(opts.current ?? ""),
        head: (name) => Effect.succeed(Option.fromNullishOr(refsHead(opts.refs, name))),
        base: (branch, parent) =>
          Effect.succeed(Option.fromNullishOr(opts.bases?.[`${branch}:${parent}`])),
        change: (number) => {
          const pull = pulls.find((item) => item.number === number);
          return pull
            ? Effect.succeed(metaFor(pull))
            : Effect.fail(new CodeHostChangeNotFoundError(number));
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
      Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie),
  );

const mkdirp = (path: string) => Effect.tryPromise(() => mkdir(path, { recursive: true }));

const put = (path: string, body: string) => Effect.tryPromise(() => writeFile(path, body));

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
    CodeHost.Service,
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
      const run = (args: ReadonlyArray<string>) => proc.exec(opts.repo, "git", args);

      const listOpen = () => Ref.get(pulls);
      const getPull = (pr: number) =>
        Ref.get(metas).pipe(
          Effect.flatMap((items) => {
            const item = items.get(pr);
            return item ? Effect.succeed(item) : Effect.fail(new CodeHostChangeNotFoundError(pr));
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

      return CodeHost.Service.of({
        provider: "github",
        capabilities: { adminMerge: true },
        requestLabel: "PR",
        reference: (number) => `#${number}`,
        repository: CodeHost.repositoryFor,
        changeUrlBase: () => null,
        auto: (pr) => record(`auto ${pr}`),
        merge,
        wait: (pr) => record(`wait ${pr}`),
        changes: listOpen,
        change: getPull,
        edit,
        body: updateBody,
        close: (pr) => Ref.update(pulls, (items) => items.filter((item) => item.number !== pr)),
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

    for (const commit of opts.base ?? [{ file: "base.txt", body: "base\n", message: "base" }]) {
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
      CodeHostGitHub.memory({
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
            title: "Format stack output",
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

const makeSync = (codeHost: Partial<CodeHost.Interface> = {}) => {
  const seen: Array<string> = [];
  const bodies = new Map<number, string>();
  const refs = new Map([
    ["dev", branchRef({ name: "dev", head: "dev-2" })],
    ["stack-b", branchRef({ name: "stack-b", head: "stack-b-1" })],
    ["stack-c", branchRef({ name: "stack-c", head: "stack-c-1" })],
  ]);
  let pulls = [
    pullRef({
      number: 5,
      title: "fix+refactor(vcs): old title",
      head: "stack-b",
      base: "dev",
      url: "u5",
      draft: false,
    }),
    pullRef({
      number: 3,
      title: "stack-c",
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
        gitAndCodeHost({
          dirty: () => Effect.succeed([]),
          fetch: () => Effect.sync(() => void seen.push("fetch")),
          auto: () => Effect.void,
          merge: (pr: number) => Effect.sync(() => void seen.push(`merge ${pr}`)),
          wait: () => Effect.void,
          refs: () => Effect.succeed(Array.from(refs.values())),
          changes: () => Effect.succeed(pulls),
          change: (pr: number) => Effect.succeed(metas.get(pr)!),
          current: () => Effect.succeed("stack-c"),
          switch: (branch: string) => Effect.sync(() => void seen.push(`switch ${branch}`)),
          head: (name: string) =>
            Effect.succeed(
              Option.fromNullishOr(
                refs.get(name)?.head ??
                  (name.startsWith("origin/") ? refs.get(name.slice(7))?.head : undefined),
              ),
            ),
          base: (branch: string, parent: string) =>
            Effect.succeed(Option.fromNullishOr(bases.get(`${branch}:${parent}`))),
          commits: (branch: string, parent: string) =>
            Effect.succeed(
              parent === "origin/dev" && branch === "stack-b"
                ? ["b1"]
                : parent === "stack-b" && branch === "stack-c"
                  ? ["c1"]
                  : [],
            ),
          novel: (_parent: string, _branch: string, commits: ReadonlyArray<string>) =>
            Effect.succeed(commits),
          backup: (branch: string, name: string) =>
            Effect.sync(() => void seen.push(`backup ${branch} ${name}`)),
          drop: (branch: string) => Effect.sync(() => void seen.push(`drop ${branch}`)),
          restore: (branch: string, name: string) =>
            Effect.sync(() => void seen.push(`restore ${branch} ${name}`)),
          replay: (branch: string, parent: string, _commits: ReadonlyArray<string>) =>
            Effect.sync(() => {
              seen.push(`rebase ${branch} ${parent}`);
              refs.set(branch, branchRef({ name: branch, head: `${branch}-2` }));
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
          create: (
            branch: string,
            base: string,
            title: string,
            body: string,
            labels: ReadonlyArray<string>,
          ) =>
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
          ...codeHost,
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
  codeHost: Partial<CodeHost.Interface> = {},
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
        gitAndCodeHost({
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
            Effect.sync(() => void seen.push(`wait ${pr} ${merged ? "merged" : "open"}`)),
          refs: () => Effect.succeed(Array.from(refs.values())),
          changes: () => Effect.succeed(pulls),
          change: (pr: number) =>
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
          switch: (branch: string) => Effect.sync(() => void seen.push(`switch ${branch}`)),
          head: (name: string) =>
            Effect.succeed(
              Option.fromNullishOr(
                refs.get(name)?.head ??
                  (name.startsWith("origin/") ? refs.get(name.slice(7))?.head : undefined),
              ),
            ),
          base: (branch: string, parent: string) =>
            Effect.succeed(Option.fromNullishOr(bases.get(`${branch}:${parent}`))),
          commits: (branch: string, parent: string) =>
            Effect.succeed(
              parent === "dev" && branch === "stack-b"
                ? ["b1"]
                : parent === "stack-b" && branch === "stack-c"
                  ? ["c1"]
                  : [],
            ),
          novel: (_parent: string, _branch: string, commits: ReadonlyArray<string>) =>
            Effect.succeed(commits),
          replay: (branch: string, parent: string, _commits: ReadonlyArray<string>) =>
            Effect.sync(() => {
              seen.push(`rebase ${branch} ${parent}`);
              refs.set(branch, branchRef({ name: branch, head: `${branch}-2` }));
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
            Effect.sync(() => void seen.push(`body ${pr} ${body.includes("### [Stack]")}`)),
          close: () => Effect.void,
          create: (
            branch: string,
            base: string,
            title: string,
            body: string,
            labels: ReadonlyArray<string>,
          ) =>
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
          ...codeHost,
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
      number: 5,
      title: "fix+refactor(vcs): old title",
      head: "stack-b",
      base: "dev",
      url: "u5",
      draft: false,
    }),
    pullRef({
      number: 3,
      title: "stack-c",
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
        gitAndCodeHost({
          dirty: () => Effect.succeed([]),
          fetch: () => Effect.sync(() => void seen.push("fetch")),
          auto: () => Effect.void,
          merge: () => Effect.void,
          wait: () => Effect.void,
          refs: () => Effect.succeed(Array.from(refs.values())),
          changes: () => Effect.succeed(pulls),
          change: (pr: number) =>
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
                  (name.startsWith("origin/") ? refs.get(name.slice(7))?.head : undefined),
              ),
            ),
          base: (branch: string, parent: string) =>
            Effect.succeed(
              Option.fromNullishOr(
                branch === "stack-b" && parent === "origin/dev"
                  ? "dev-1"
                  : branch === "stack-b" && parent === "dev"
                    ? "dev-1"
                    : branch === "stack-c" && parent.startsWith("backup/stack-sync-")
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
              refs.set(branch, branchRef({ name: branch, head: `${branch}-2` }));
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
      state: stackState([stackLink({ branch: "stack-a", parent: "dev", anchor: "dev", pr: 1 })]),
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
      refs: [ref("dev"), ref("stack-a", "a"), ref("stack-b", "b"), ref("stack-c", "c")],
      pulls: [pr(1, "stack-a", "dev"), pr(2, "stack-b", "stack-a"), pr(3, "stack-c", "stack-a")],
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
    }).pipe(Effect.provide(Git.live.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))));
  });

  it.effect("push preserves origin tracking and supports fork remotes", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return "";
          }),
      }),
    );

    return Effect.gen(function* () {
      const git = yield* Git.Service;
      yield* git.push("stack-a");
      yield* git.push("stack-b", "fork");

      expect(calls).toEqual([
        ["git", "push", "--force-with-lease", "-u", "origin", "stack-a"],
        ["git", "fetch", "fork", "--prune"],
        ["git", "push", "--force-with-lease", "fork", "stack-b"],
      ]);
    }).pipe(Effect.provide(Git.live.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))));
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
      codeHostWaitIntervalMillis: 1_000,
    }).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const github = yield* CodeHost.Service;
      const fiber = yield* github.wait(4).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(calls).toHaveLength(1);

      yield* TestClock.adjust("999 millis");
      expect(calls).toHaveLength(1);

      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      expect(calls).toHaveLength(2);
    }).pipe(
      Effect.provide(
        CodeHostGitHub.layer.pipe(Layer.provideMerge(cfgLayer), Layer.provideMerge(proc)),
      ),
    );
  });

  it.effect("normalizes repository identity for fork push routing", () => {
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: () =>
          Effect.succeed(
            JSON.stringify([
              [
                {
                  number: 7,
                  title: "fork PR",
                  head: { ref: "feature/x", repo: { full_name: "KitLangton/OpenCode" } },
                  base: { ref: "dev" },
                  html_url: "https://github.com/anomalyco/opencode/pull/7",
                  draft: false,
                },
              ],
            ]),
          ),
      }),
    );

    return Effect.gen(function* () {
      const github = yield* CodeHost.Service;
      const pulls = yield* github.changes();

      expect(pulls[0]?.headRepository).toBe("kitlangton/opencode");
      expect(github.repository("git@github.com:KITLANGTON/OpenCode.git")).toBe(
        "kitlangton/opencode",
      );
    }).pipe(
      Effect.provide(CodeHostGitHub.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("decodes all paginated GitHub pull request pages", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return JSON.stringify([
              [
                {
                  number: 1,
                  title: "one",
                  head: { ref: "one", repo: { full_name: "owner/project" } },
                  base: { ref: "main" },
                  html_url: "u1",
                  draft: false,
                },
              ],
              [
                {
                  number: 2,
                  title: "two",
                  head: { ref: "two", repo: { full_name: "owner/project" } },
                  base: { ref: "main" },
                  html_url: "u2",
                  draft: false,
                },
              ],
            ]);
          }),
      }),
    );

    return Effect.gen(function* () {
      const github = yield* CodeHost.Service;
      const pulls = yield* github.changes();

      expect(pulls.map((pull) => Number(pull.number))).toEqual([1, 2]);
      expect(calls).toEqual([
        [
          "gh",
          "api",
          "repos/{owner}/{repo}/pulls?state=open&per_page=100",
          "--paginate",
          "--slurp",
        ],
      ]);
    }).pipe(
      Effect.provide(CodeHostGitHub.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("resolves a created GitHub fork PR by its returned URL", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return args[1] === "create"
              ? "https://github.com/upstream/project/pull/7"
              : JSON.stringify({
                  number: 7,
                  title: "restacked",
                  headRefName: "feature/x",
                  headRepository: { nameWithOwner: "contributor/project" },
                  baseRefName: "main",
                  url: "https://github.com/upstream/project/pull/7",
                  isDraft: false,
                });
          }),
      }),
    );

    return Effect.gen(function* () {
      const github = yield* CodeHost.Service;
      const created = yield* github.create(
        "feature/x",
        "main",
        "restacked",
        "body",
        [],
        "contributor/project",
      );

      expect(Number(created.number)).toBe(7);
      expect(String(created.url)).toBe("https://github.com/upstream/project/pull/7");
      expect(calls).toHaveLength(1);
    }).pipe(
      Effect.provide(CodeHostGitHub.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });
});

describe("GitLab", () => {
  it.effect("normalizes the MR source project for fork push routing", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return args[1] === "projects/44"
              ? JSON.stringify({ path_with_namespace: "fork-owner/project" })
              : JSON.stringify({
                  iid: 7,
                  title: "fork MR",
                  source_branch: "feature/x",
                  target_branch: "main",
                  web_url: "https://gitlab.com/upstream/project/-/merge_requests/7",
                  draft: false,
                  source_project_id: 44,
                });
          }),
      }),
    );
    const cfgLayer = StackConfig.layer({ root: "/tmp/stack", trunks: ["main"] }).pipe(
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      const pulls = yield* gitlab.changes();

      expect(pulls[0]?.headRepository).toBe("fork-owner/project");
      expect(calls).toEqual([
        [
          "glab",
          "api",
          "projects/:id/merge_requests?state=opened&per_page=100",
          "--paginate",
          "--output",
          "ndjson",
        ],
        ["glab", "api", "projects/44"],
      ]);
    }).pipe(
      Effect.provide(
        CodeHostGitLab.layer.pipe(Layer.provideMerge(cfgLayer), Layer.provideMerge(proc)),
      ),
    );
  });

  it.effect("decodes paginated GitLab merge requests from NDJSON output", () => {
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, _tool, args) =>
          Effect.succeed(
            args[1] === "projects/1"
              ? JSON.stringify({ path_with_namespace: "owner/one" })
              : args[1] === "projects/2"
                ? JSON.stringify({ path_with_namespace: "owner/two" })
                : [
                    {
                      iid: 1,
                      title: "one",
                      source_branch: "one",
                      target_branch: "main",
                      web_url: "u1",
                      draft: false,
                      source_project_id: 1,
                    },
                    {
                      iid: 2,
                      title: "two",
                      source_branch: "two",
                      target_branch: "main",
                      web_url: "u2",
                      draft: false,
                      source_project_id: 2,
                    },
                  ]
                    .map((item) => JSON.stringify(item))
                    .join("\n"),
          ),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      const pulls = yield* gitlab.changes();

      expect(pulls.map((pull) => Number(pull.number))).toEqual([1, 2]);
      expect(pulls.map((pull) => pull.headRepository)).toEqual(["owner/one", "owner/two"]);
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("caches GitLab source-project lookups within the adapter layer", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return args[1] === "projects/1"
              ? JSON.stringify({ path_with_namespace: "owner/project" })
              : [
                  {
                    iid: 1,
                    title: "one",
                    source_branch: "one",
                    target_branch: "main",
                    web_url: "u1",
                    draft: false,
                    source_project_id: 1,
                  },
                  {
                    iid: 2,
                    title: "two",
                    source_branch: "two",
                    target_branch: "main",
                    web_url: "u2",
                    draft: false,
                    source_project_id: 1,
                  },
                ]
                  .map((item) => JSON.stringify(item))
                  .join("\n");
          }),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      yield* gitlab.changes();

      expect(calls.filter((args) => args[2] === "projects/1")).toHaveLength(1);
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("decodes GitLab historical changes and mixed label shapes", () => {
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, _tool, args) =>
          Effect.succeed(
            args[1] === "projects/44"
              ? JSON.stringify({ path_with_namespace: "fork-owner/project" })
              : JSON.stringify({
                  iid: 7,
                  title: "fork MR",
                  description: null,
                  source_branch: "feature/x",
                  target_branch: "main",
                  web_url: "u7",
                  draft: false,
                  state: "opened",
                  labels: ["bug", { name: "stack" }],
                  source_project_id: 44,
                }),
          ),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      const change = yield* gitlab.change(7);

      expect(change.body).toBe("");
      expect(change.headRepository).toBe("fork-owner/project");
      expect(change.labels.map((label) => label.name)).toEqual(["bug", "stack"]);
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("normalizes missing GitLab historical changes", () => {
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) => Effect.fail(new ExecError(tool, args, 1, "404 Not Found")),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      expect((yield* Effect.flip(gitlab.change(7)))._tag).toBe("CodeHostChangeNotFoundError");
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("uses immediate GitLab merge without enabling auto-merge", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return "";
          }),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      yield* gitlab.merge(7);

      expect(calls).toEqual([
        ["glab", "mr", "merge", "7", "--auto-merge=false", "--squash", "--yes"],
      ]);
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("enables GitLab auto-merge through the merge API", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return "";
          }),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      yield* gitlab.auto(7);

      expect(calls).toEqual([
        [
          "glab",
          "api",
          "projects/:id/merge_requests/7/merge",
          "--method",
          "PUT",
          "--field",
          "auto_merge=true",
          "--field",
          "squash=true",
        ],
      ]);
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("updates GitLab merge requests without prompting", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return "";
          }),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      yield* gitlab.edit(7, "main");
      yield* gitlab.body(7, "updated body");

      expect(calls).toEqual([
        ["glab", "mr", "update", "7", "--target-branch", "main", "--yes"],
        [
          "glab",
          "api",
          "projects/:id/merge_requests/7",
          "--method",
          "PUT",
          "--raw-field",
          "description=updated body",
        ],
      ]);
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("clears GitLab descriptions through the update API", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return "";
          }),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      yield* gitlab.body(7, "");

      expect(calls).toEqual([
        [
          "glab",
          "api",
          "projects/:id/merge_requests/7",
          "--method",
          "PUT",
          "--raw-field",
          "description=",
        ],
      ]);
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("closes GitLab merge requests through glab", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            return "";
          }),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      yield* gitlab.close(7);
      expect(calls).toEqual([["glab", "mr", "close", "7"]]);
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("resolves a created GitLab fork MR by its returned URL", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            if (args[1] === "create")
              return "https://gitlab.com/upstream/project/-/merge_requests/7";
            if (args[1] === "view") {
              return JSON.stringify({
                iid: 7,
                title: "restacked",
                description: "body",
                source_branch: "feature/x",
                target_branch: "main",
                web_url: "https://gitlab.com/upstream/project/-/merge_requests/7",
                draft: false,
                state: "opened",
                labels: [],
                source_project_id: 44,
              });
            }
            return JSON.stringify({ path_with_namespace: "contributor/project" });
          }),
      }),
    );

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      const created = yield* gitlab.create(
        "feature/x",
        "main",
        "restacked",
        "body",
        [],
        "contributor/project",
      );

      expect(Number(created.number)).toBe(7);
      expect(String(created.url)).toBe("https://gitlab.com/upstream/project/-/merge_requests/7");
      expect(calls).toHaveLength(1);
    }).pipe(
      Effect.provide(CodeHostGitLab.layer.pipe(Layer.provideMerge(cfg), Layer.provideMerge(proc))),
    );
  });

  it.effect("continues waiting while a GitLab merge request is locked", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let views = 0;
    const proc = Layer.succeed(
      Proc.Service,
      Proc.Service.of({
        exec: (_cwd, tool, args) =>
          Effect.sync(() => {
            calls.push([tool, ...args]);
            views += 1;
            return JSON.stringify({ state: views === 1 ? "locked" : "merged", merged_at: null });
          }),
      }),
    );
    const cfgLayer = StackConfig.layer({
      root: "/tmp/stack",
      trunks: ["main"],
      codeHostWaitIntervalMillis: 1_000,
    }).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      const fiber = yield* gitlab.wait(7).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(calls).toHaveLength(1);

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(calls).toHaveLength(2);
    }).pipe(
      Effect.provide(
        CodeHostGitLab.layer.pipe(Layer.provideMerge(cfgLayer), Layer.provideMerge(proc)),
      ),
    );
  });
});

describe("Stack", () => {
  it.effect("status shows PR titles when GitHub details are available", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      const report = yield* stack.status();
      const node = report.nodes.find((item) => item.branch === "effectify-format");
      expect(node?.parent).toBe("effectify-env-filetime");
      expect(node?.source).toBe("inferred");
      expect(node?.title).toBe("Format stack output");
      expect(node?.issues).toEqual(["inferred-parent"]);
      expect(renderStatus(report)).toContain("Title: Format stack output");
    }).pipe(Effect.provide(make())),
  );

  it.effect("adopt stores explicit parent and anchor", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const link = yield* stack.adopt("effectify-format", "effectify-env-filetime");
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

      const trunk = yield* Effect.flip(stack.adopt("dev", "effectify-watcher"));
      expect(String(trunk)).toContain("cannot track trunk branch");

      const self = yield* Effect.flip(stack.adopt("effectify-format", "effectify-format"));
      expect(String(self)).toContain("cannot be its own parent");

      const cycle = yield* Effect.flip(stack.adopt("effectify-format", "effectify-env-filetime"));
      expect(String(cycle)).toContain("would create a cycle");
    }).pipe(Effect.provide(make())),
  );

  it.effect("status prefers explicit metadata once adopted", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.adopt("effectify-format", "effectify-env-filetime");
      const report = yield* stack.status();
      const node = report.nodes.find((item) => item.branch === "effectify-format");
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
      const items = yield* stack.sync({ apply: true });
      const state = yield* store.read();
      const undo = yield* store.readUndo();

      expect(items).toContain("Synced stack");
      expect(items).toContain("└─ ● effectify-watcher #17544");
      expect(items).toContain("            └─ ● effectify-format #17675");
      expect(items).toContain("Updated PRs: #17544, #17601, #17634, #17640, #17675");
      expect(state.links.map((link) => String(link.branch))).toEqual([
        "effectify-env-filetime",
        "effectify-file-watcher-service",
        "effectify-format",
        "effectify-vcs",
        "effectify-watcher",
      ]);
      expect(state.links.find((link) => link.branch === "standalone")).toBeUndefined();
      expect(undo?.state.links).toEqual([]);
      expect(undo?.actions).toContain("infer link: effectify-watcher -> dev @ aaa");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync previews inferred links without storing metadata", () => {
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
      const items = yield* stack.sync();
      const state = yield* store.read();
      const undo = yield* store.readUndo();

      expect(items).toContain("Sync preview");
      expect(items).toContain("└─ ● effectify-watcher #17544");
      expect(items).toContain("   └─ ● effectify-file-watcher-service #17601");
      expect(items).toContain("Would update PRs: #17544, #17601");
      expect(state.links).toEqual([]);
      expect(undo).toBeNull();
      expect(events).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync previews stale metadata reconciliation", () => {
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
      const items = yield* stack.sync();
      const state = yield* store.read();

      expect(items).toContain("Sync preview");
      expect(items).toContain("└─ ◌ stack-b #2 would rebase onto dev");
      expect(items).toContain("Would update PRs: #2");
      expect(state.links.map((link) => String(link.branch))).toEqual(["stale", "stack-b"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync branch argument scopes to the containing inferred stack", () => {
    const seen: Array<string> = [];
    const layer = stackTestLayer({
      current: "dev",
      refs: [
        ref("dev", "aaa"),
        ref("app-root", "app"),
        ref("app-child", "app-child"),
        ref("other-root", "other"),
        ref("other-child", "other-child"),
      ],
      pulls: [
        pr(1, "app-root", "dev"),
        pr(2, "app-child", "app-root"),
        pr(3, "other-root", "dev"),
        pr(4, "other-child", "other-root"),
      ],
      bases: bases(
        ["app-root", "dev", "aaa"],
        ["app-child", "app-root", "app"],
        ["other-root", "dev", "aaa"],
        ["other-child", "other-root", "other"],
      ),
      service: {
        body: (number) => Effect.sync(() => void seen.push(`body ${number}`)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const items = yield* stack.sync({ branch: "app-root", apply: true });
      const state = yield* store.read();

      expect(items).toContain("Synced stack");
      expect(items).toContain("└─ ● app-root #1");
      expect(items).toContain("   └─ ● app-child #2");
      expect(items.join("\n")).not.toContain("other-root");
      expect(state.links.map((link) => String(link.branch))).toEqual(["app-child", "app-root"]);
      expect([...seen].sort()).toEqual(["body 1", "body 2"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync without branch scopes to the current inferred stack", () => {
    const layer = stackTestLayer({
      current: "other-child",
      refs: [
        ref("dev", "aaa"),
        ref("app-root", "app"),
        ref("app-child", "app-child"),
        ref("other-root", "other"),
        ref("other-child", "other-child"),
      ],
      pulls: [
        pr(1, "app-root", "dev"),
        pr(2, "app-child", "app-root"),
        pr(3, "other-root", "dev"),
        pr(4, "other-child", "other-root"),
      ],
      bases: bases(
        ["app-root", "dev", "aaa"],
        ["app-child", "app-root", "app"],
        ["other-root", "dev", "aaa"],
        ["other-child", "other-root", "other"],
      ),
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const items = yield* stack.sync();

      expect(items).toContain("Sync preview");
      expect(items).toContain("└─ ● other-root #3");
      expect(items).toContain("   └─ ● other-child #4");
      expect(items.join("\n")).not.toContain("app-root");
    }).pipe(Effect.provide(layer));
  });

  it.effect("scoped sync ignores stale and independent recorded stacks", () => {
    const layer = stackTestLayer({
      current: "active-child",
      refs: [
        ref("dev", "dev-new"),
        ref("active-root", "active-root"),
        ref("active-child", "active-child"),
        ref("other-root", "other-root"),
        ref("other-child", "other-child"),
        ref("stale", "stale"),
      ],
      pulls: [
        pr(1, "active-root", "dev"),
        pr(2, "active-child", "active-root"),
        pr(3, "other-root", "dev"),
        pr(4, "other-child", "other-root"),
      ],
      bases: bases(
        ["active-root", "dev", "dev-new"],
        ["active-child", "active-root", "active-root"],
        ["other-root", "dev", "dev-old"],
        ["other-child", "other-root", "other-old"],
      ),
      state: stackState([
        stackLink({ branch: "active-root", parent: "dev", anchor: "dev-new", pr: 1 }),
        stackLink({ branch: "active-child", parent: "active-root", anchor: "active-root", pr: 2 }),
        stackLink({ branch: "other-root", parent: "dev", anchor: "dev-old", pr: 3 }),
        stackLink({ branch: "other-child", parent: "other-root", anchor: "other-old", pr: 4 }),
        stackLink({ branch: "stale", parent: "dev", anchor: "dev-old", pr: 5 }),
      ]),
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const output = (yield* stack.sync({ branch: "active-child" })).join("\n");

      expect(output).toContain("active-root");
      expect(output).toContain("active-child");
      expect(output).not.toContain("other-root");
      expect(output).not.toContain("other-child");
      expect(output).not.toContain("stale");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync refreshes stack blocks for requests created during repair", () => {
    const seen: Array<string> = [];
    let pulls = [pr(2, "active-child", "active-root")];
    const layer = stackTestLayer({
      current: "active-child",
      refs: [
        ref("dev", "dev-new"),
        ref("active-root", "active-root"),
        ref("active-child", "active-child"),
      ],
      pulls,
      bases: bases(
        ["active-root", "dev", "dev-old"],
        ["active-child", "active-root", "active-root"],
      ),
      state: stackState([
        stackLink({ branch: "active-root", parent: "dev", anchor: "dev-old", pr: null }),
        stackLink({ branch: "active-child", parent: "active-root", anchor: "active-root", pr: 2 }),
      ]),
      service: {
        changes: () => Effect.succeed(pulls),
        change: (number) => {
          const found = pulls.find((item) => item.number === number);
          return found
            ? Effect.succeed(metaFor(found))
            : Effect.fail(new CodeHostChangeNotFoundError(number));
        },
        create: (branch, base) =>
          Effect.sync(() => {
            const made = pr(3, branch, base);
            pulls = [...pulls, made];
            return made;
          }),
        body: (number) => Effect.sync(() => void seen.push(`body ${number}`)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ branch: "active-child", apply: true });

      expect(seen).toContain("body 3");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync previews replacement requests for missing non-terminal changes", () => {
    const layer = stackTestLayer({
      current: "stack-c",
      refs: [ref("dev", "dev-new"), ref("stack-b", "stack-b"), ref("stack-c", "stack-c")],
      pulls: [pr(3, "stack-c", "stack-b")],
      bases: bases(["stack-b", "dev", "dev-new"], ["stack-c", "stack-b", "stack-b"]),
      state: stackState([
        stackLink({ branch: "stack-b", parent: "dev", anchor: "dev-new", pr: 4 }),
        stackLink({ branch: "stack-c", parent: "stack-b", anchor: "stack-b", pr: 3 }),
      ]),
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const output = (yield* stack.sync()).join("\n");

      expect(output).toContain("stack-b would create PR");
      expect(output).toContain("Would create PRs: stack-b -> dev");
      expect(output).not.toContain("stack-b #4");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync checkpoints before creating a replacement request", () => {
    const layer = stackTestLayer({
      current: "active-child",
      refs: [
        ref("dev", "dev-new"),
        ref("active-root", "active-root"),
        ref("active-child", "active-child"),
      ],
      pulls: [pr(2, "active-child", "active-root")],
      bases: bases(
        ["active-root", "dev", "dev-new"],
        ["active-child", "active-root", "active-root"],
      ),
      state: stackState([
        stackLink({ branch: "active-root", parent: "dev", anchor: "dev-new", pr: null }),
        stackLink({ branch: "active-child", parent: "active-root", anchor: "active-root", pr: 2 }),
      ]),
      service: {
        create: () => Effect.fail(new ExecError("gh", ["pr", "create"], 1, "boom")),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      yield* Effect.flip(stack.sync({ branch: "active-child", apply: true }));
      const undo = yield* store.readUndo();

      const entry = undo?.entries.find((item) => item.branch === "active-root");
      expect(entry?.backup).toBeNull();
      expect(entry?.created).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync branch argument rejects branches outside tracked stacks", () => {
    const layer = stackTestLayer({
      current: "dev",
      refs: [ref("dev", "aaa"), ref("standalone", "alone")],
      pulls: [pr(1, "standalone", "dev")],
      bases: bases(["standalone", "dev", "aaa"]),
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const error = yield* Effect.flip(stack.sync({ branch: "standalone" }));

      expect(String(error)).toContain("standalone is not part of a tracked stack");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync restores the current branch when link refresh fails", () => {
    const seen: Array<string> = [];
    const refs = [ref("dev", "dev-1"), ref("stack-a", "a-1"), ref("stack-b", "b-1")];
    const layer = stackTestLayer({
      current: "stack-b",
      refs,
      pulls: [pr(1, "stack-a", "dev"), pr(2, "stack-b", "stack-a")],
      bases: bases(["stack-a", "dev", "dev-1"], ["stack-b", "stack-a", "a-1"]),
      service: {
        switch: (branch) => Effect.sync(() => void seen.push(`switch ${branch}`)),
        body: (number) => Effect.fail(new ExecError("gh", ["pr", "edit", `${number}`], 1, "boom")),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const failed = yield* stack.sync({ apply: true }).pipe(
        Effect.flip,
        Effect.map((err) => String(err)),
      );

      expect(failed).toContain("gh pr edit");
      expect(seen).toContain("switch stack-b");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync continue-on-failure processes independent stacks", () => {
    const seen: Array<string> = [];
    const refs = new Map([
      ["dev", ref("dev", "dev-1")],
      ["bad-root", ref("bad-root", "bad-new")],
      ["bad-child", ref("bad-child", "bad-child-old")],
      ["good-root", ref("good-root", "good-new")],
      ["good-child", ref("good-child", "good-child-old")],
    ]);
    const baseMap = new Map([
      ["bad-root:dev", "dev-1"],
      ["bad-root:origin/dev", "dev-1"],
      ["bad-child:bad-root", "bad-old"],
      ["good-root:dev", "dev-1"],
      ["good-root:origin/dev", "dev-1"],
      ["good-child:good-root", "good-old"],
    ]);
    const layer = stackTestLayer({
      current: "dev",
      refs: [],
      pulls: [
        pr(1, "bad-root", "dev"),
        pr(2, "bad-child", "bad-root"),
        pr(3, "good-root", "dev"),
        pr(4, "good-child", "good-root"),
      ],
      state: stackState([
        stackLink({ branch: "bad-root", parent: "dev", anchor: "dev-1", pr: 1 }),
        stackLink({ branch: "bad-child", parent: "bad-root", anchor: "bad-old", pr: 2 }),
        stackLink({ branch: "good-root", parent: "dev", anchor: "dev-1", pr: 3 }),
        stackLink({ branch: "good-child", parent: "good-root", anchor: "good-old", pr: 4 }),
      ]),
      service: {
        refs: () => Effect.succeed([...refs.values()]),
        head: (name) =>
          Effect.succeed(
            Option.fromNullishOr(
              refs.get(name)?.head ??
                (name.startsWith("origin/") ? refs.get(name.slice(7))?.head : undefined),
            ),
          ),
        base: (branch, parent) =>
          Effect.succeed(Option.fromNullishOr(baseMap.get(`${branch}:${parent}`))),
        commits: (_from, branch) => Effect.succeed([`${branch}-commit`]),
        replay: (branch, parent) =>
          branch === "bad-child"
            ? Effect.fail(new ExecError("git", ["cherry-pick"], 1, "conflict"))
            : Effect.sync(() => {
                seen.push(`rebase ${branch} ${parent}`);
                refs.set(branch, ref(branch, `${branch}-new`));
                baseMap.set(`${branch}:${parent}`, refs.get(parent)?.head ?? "");
              }),
        backup: (branch, name) => Effect.sync(() => void seen.push(`backup ${branch} ${name}`)),
        push: (branch) => Effect.sync(() => void seen.push(`push ${branch}`)),
        body: (number) => Effect.sync(() => void seen.push(`body ${number}`)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const error = yield* Effect.flip(stack.sync({ apply: true, continueOnFailure: true }));
      const items = (error instanceof Error ? error.message : String(error)).split("\n");
      const output = items.join("\n");
      const undo = yield* store.readUndo();

      expect(items).toContain("Sync complete");
      expect(items).toContain("1 stack synced, 1 stack failed");
      expect(items).toContain("  good-root");
      expect(items).toContain("  bad-root");
      expect(output).toContain("backup created: backup/stack-sync-");
      expect(output).toContain("bad-child could not be replayed onto bad-root");
      expect(seen).toContain("push good-child");
      expect(seen).toContain("body 3");
      expect(seen).toContain("body 4");
      expect(undo?.entries.map((entry) => String(entry.branch)).sort()).toEqual([
        "bad-child",
        "good-child",
      ]);
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
      const node = report.nodes.find((item) => item.branch === "effectify-format");
      expect(node?.issues).toContain("missing-parent");
    }).pipe(Effect.provide(make())),
  );

  it.effect("renderStatus prints a readable tree", () =>
    Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.adopt("effectify-format", "effectify-env-filetime");
      const view = renderStatus(yield* stack.status());
      expect(view).toContain("└─ effectify-format 👈 current");
      expect(view).toContain("PR: #17675 u5");
      expect(view).toContain("Title: Format stack output");
      expect(view).toContain("effectify-env-filetime");
      expect(view).toContain("inferred-parent");
    }).pipe(Effect.provide(make())),
  );

  it("renderStatus focuses on the current stack and hides backup branches", () => {
    const graph = StackGraph.make({
      state: stackState([
        stackLink({ branch: "stack-a", parent: "dev", anchor: "dev", pr: 1 }),
        stackLink({ branch: "stack-b", parent: "stack-a", anchor: "a", pr: 2 }),
        stackLink({ branch: "other", parent: "dev", anchor: "dev", pr: 3 }),
        stackLink({
          branch: "backup/stack-sync-old-stack-b",
          parent: "dev",
          anchor: "dev",
          pr: null,
        }),
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

  it.effect("sync fixes a missing parent and recreates the child pr", () => {
    const test = makeSync();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const items = yield* stack.sync({ apply: true });
      const state = yield* store.read();

      expect(items).toContain("Synced stack");
      expect(items).toContain("└─ ✓ stack-b #5 rebased onto dev");
      expect(items).toContain("   └─ ✓ stack-c #3 rebased onto stack-b");
      expect(items).toContain("Updated PRs: #3, #5");
      expect(items).toContain("Backups created: 2");
      expect(test.seen[0]).toBe("fetch");
      expect(test.seen[1]?.startsWith("backup stack-b backup/stack-sync-")).toBe(true);
      expect(test.seen[2]).toBe("rebase stack-b origin/dev");
      expect(test.seen[3]).toBe("push stack-b");
      expect(test.seen[4]?.startsWith("backup stack-c backup/stack-sync-")).toBe(true);
      expect(test.seen[5]).toBe("rebase stack-c stack-b");
      expect(test.seen[6]).toBe("push stack-c");
      expect(state.links.find((item) => item.branch === "stack-b")?.parent).toBe("dev");
      expect(state.links.find((item) => item.branch === "stack-b")?.pr).toBe(5);
      expect(state.links.find((item) => item.branch === "stack-c")?.anchor).toBe("stack-b-2");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("sync pushes fork PR heads and upstream base mirrors", () => {
    const seen: Array<string> = [];
    const refs = new Map([
      ["dev", ref("dev", "dev-new")],
      ["stack-a", ref("stack-a", "stack-a-head")],
      ["stack-b", ref("stack-b", "stack-b-head")],
    ]);
    const baseMap = new Map(
      Object.entries(bases(["stack-a", "dev", "dev-old"], ["stack-b", "stack-a", "stack-a-old"])),
    );
    const layer = stackTestLayer({
      refs: [...refs.values()],
      pulls: [
        pullRef({
          number: 10,
          head: "stack-a",
          headRepository: "kitlangton/opencode",
          base: "dev",
          url: "u10",
          draft: false,
        }),
        pullRef({
          number: 11,
          head: "stack-b",
          headRepository: "kitlangton/opencode",
          base: "stack-a",
          url: "u11",
          draft: false,
        }),
      ],
      bases: Object.fromEntries(baseMap),
      state: stackState([
        stackLink({ branch: "stack-a", parent: "dev", anchor: "dev-old", pr: 10 }),
        stackLink({ branch: "stack-b", parent: "stack-a", anchor: "stack-a-old", pr: 11 }),
      ]),
      service: {
        refs: () => Effect.succeed([...refs.values()]),
        remotes: () =>
          Effect.succeed([
            { name: "origin", url: "git@github.com:anomalyco/opencode.git" },
            { name: "fork", url: "git@github.com:kitlangton/opencode.git" },
          ]),
        head: (name) =>
          Effect.succeed(
            Option.fromNullishOr(
              refs.get(name)?.head ??
                (name.startsWith("origin/") ? refs.get(name.slice(7))?.head : undefined),
            ),
          ),
        base: (branch, parent) =>
          Effect.succeed(Option.fromNullishOr(baseMap.get(`${branch}:${parent}`))),
        replay: (branch, parent) =>
          Effect.sync(() => {
            seen.push(`rebase ${branch} ${parent}`);
            refs.set(branch, ref(branch, `${branch}-rebased`));
            baseMap.set(
              `${branch}:${parent}`,
              refs.get(parent.startsWith("origin/") ? parent.slice(7) : parent)?.head ?? "",
            );
          }),
        push: (branch, remote = "origin") =>
          Effect.sync(() => void seen.push(`push ${branch} ${remote}`)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      yield* stack.sync({ apply: true });
      const undo = yield* store.readUndo();

      expect(seen).toContain("push stack-a fork");
      expect(seen).toContain("push stack-a origin");
      expect(seen).toContain("push stack-b fork");
      expect(seen).not.toContain("push stack-b origin");
      expect(undo?.entries.find((entry) => entry.branch === "stack-a")?.pushRemotes).toEqual([
        "fork",
        "origin",
      ]);

      yield* stack.undo(true);
      expect(seen.filter((item) => item === "push stack-a fork")).toHaveLength(2);
      expect(seen.filter((item) => item === "push stack-a origin")).toHaveLength(2);
      expect(seen.filter((item) => item === "push stack-b fork")).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync does not rewrite a fork remote when no repair is needed", () => {
    const seen: Array<string> = [];
    const refs = [ref("dev", "dev-head"), ref("stack-a", "stack-a-local")];
    const layer = stackTestLayer({
      refs,
      pulls: [
        pullRef({
          number: 10,
          head: "stack-a",
          headRepository: "kitlangton/opencode",
          base: "dev",
          url: "u10",
          draft: false,
        }),
      ],
      bases: bases(["stack-a", "dev", "dev-head"]),
      state: stackState([
        stackLink({ branch: "stack-a", parent: "dev", anchor: "dev-head", pr: 10 }),
      ]),
      service: {
        remotes: () =>
          Effect.succeed([{ name: "origin", url: "git@github.com:anomalyco/opencode.git" }]),
        head: (name) =>
          Effect.succeed(
            Option.fromNullishOr(name === "fork/stack-a" ? "stack-a-stale" : refsHead(refs, name)),
          ),
        push: (branch, remote = "origin") =>
          Effect.sync(() => void seen.push(`push ${branch} ${remote}`)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const lines = yield* stack.sync({ apply: true });

      expect(seen).toEqual([]);
      expect(lines.join("\n")).not.toContain("pushed to fork");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync selects recorded changes when fork heads share a branch", () => {
    const layer = stackTestLayer({
      current: "stack-a",
      refs: [ref("dev", "dev-new"), ref("stack-a", "stack-a")],
      pulls: [
        pullRef({
          number: 10,
          head: "stack-a",
          headRepository: "one/project",
          base: "dev",
          url: "u10",
          draft: false,
        }),
        pullRef({
          number: 11,
          head: "stack-a",
          headRepository: "two/project",
          base: "dev",
          url: "u11",
          draft: false,
        }),
      ],
      bases: bases(["stack-a", "dev", "dev-old"]),
      state: stackState([
        stackLink({ branch: "stack-a", parent: "dev", anchor: "dev-old", pr: 10 }),
      ]),
      service: {
        remotes: () => Effect.succeed([{ name: "fork", url: "git@github.com:one/project.git" }]),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const output = (yield* stack.sync()).join("\n");

      expect(output).toContain("stack-a #10");
      expect(output).not.toContain("#11");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sync previews without mutating", () => {
    const test = makeSync();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const items = yield* stack.sync();
      const state = yield* store.read();
      const undo = yield* store.readUndo();

      expect(items).toContain("Sync preview");
      expect(items).toContain("└─ ◌ stack-b #5 would rebase onto dev");
      expect(items).toContain("   └─ ◌ stack-c #3 would rebase onto stack-b");
      expect(test.seen).toEqual([]);
      expect(state.links.find((item) => item.branch === "stack-b")?.parent).toBe("stack-a");
      expect(undo).toBeNull();
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("sync filters already-upstream parent commits before replay", () => {
    const test = makeSyncNovel();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const items = yield* stack.sync({ apply: true });

      expect(items).toContain("└─ ✓ stack-b #5 rebased onto dev");
      expect(items).toContain("   └─ ✓ stack-c #3 rebased onto stack-b");
      expect(test.seen).toContain("rebase stack-c stack-b c1");
      expect(test.seen).not.toContain("rebase stack-c stack-b b1,b2,c1");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("sync uses stored child anchor after squash-merged parent is removed", () => {
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
        novel: (_parent: string, _branch: string, commits: ReadonlyArray<string>) =>
          Effect.succeed(commits),
        replay: (branch: string, parent: string, commits: ReadonlyArray<string>) =>
          Effect.sync(() => seen.push(`rebase ${branch} ${parent} ${commits.join(",")}`)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true });

      expect(seen).toContain("rebase child origin/dev child-only");
      expect(seen).not.toContain("rebase child origin/dev parent-1,parent-2,child-only");
    }).pipe(Effect.provide(layer));
  });

  it.effect("undo restores the last applied mutation", () => {
    const test = makeSync();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      yield* stack.sync({ apply: true });
      const items = yield* stack.undo(true);
      const state = yield* store.read();
      const undo = yield* store.readUndo();

      expect(
        items.some(
          (item) =>
            item === "switch to dev" || item.startsWith("restore stack-b from backup/stack-sync-"),
        ),
      ).toBe(true);
      expect(items).toContain("switch to dev");
      expect(items).toContain("push stack-b");
      expect(items).toContain("restore stack metadata");
      expect(test.seen).toContain("switch dev");
      expect(test.seen.some((item) => item.startsWith("restore stack-b backup/stack-sync-"))).toBe(
        true,
      );
      expect(test.seen).not.toContain("close 6");
      expect(state.links.find((item) => item.branch === "stack-b")?.parent).toBe("stack-a");
      expect(undo).toBeNull();
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("last reports the most recent applied mutation", () => {
    const test = makeSync();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.sync({ apply: true });
      const items = yield* stack.last();

      expect(items[0]?.startsWith("last mutation: ")).toBe(true);
      expect(items).toContain("rebase stack-b onto dev");
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

  it.effect("links render the stack as chronological GitHub checkboxes", () => {
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
  });

  it.effect("links use scannable GitLab MR references with titles", () => {
    const test = makeSync({
      provider: "gitlab",
      capabilities: { adminMerge: false },
      requestLabel: "MR",
      reference: (number) => `!${number}`,
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.links(true);

      const body = test.bodies.get(3) ?? "";
      expect(body).toContain("1. !4 - stack-a");
      expect(body).toContain("2. !5 - fix+refactor(vcs): old title");
      expect(body).toContain("3. **!3 - stack-c** 👈 current");
      expect(body).not.toContain("#3");
    }).pipe(Effect.provide(test.layer));
  });

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
        gitAndCodeHost({
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
          changes: () => Effect.succeed(pulls),
          change: (pr: number) => Effect.succeed(metas.get(pr)!),
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
          body: (pr: number, body: string) => Effect.sync(() => void bodies.set(pr, body)),
          close: () => Effect.void,
          create: () => Effect.fail(new ExecError("gh", ["pr", "create"], 1, "unused")),
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
        change: (number) => {
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
        links: [stackLink({ branch: "stack-b", parent: "dev", anchor: "dev", pr: 4 })],
      }),
      service: {
        change: (number) =>
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
        links: [stackLink({ branch: "stack-b", parent: "dev", anchor: "dev", pr: 4 })],
      }),
      service: {
        change: (number) =>
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
      expect(plan.some((item) => item.startsWith("would backup stack-a -> backup/landed-"))).toBe(
        true,
      );
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
            expect(doneTest.seen[1]?.startsWith("backup stack-a backup/landed-")).toBe(true);
            expect(doneTest.seen[2]).toBe("edit 5 dev");
            expect(doneTest.seen[3]).toBe("merge 4");
            expect(doneTest.seen[4]).toBe("drop stack-a");
            expect(doneTest.seen[5]).toBe("fetch");
            const store = yield* Store;
            const undo = yield* store.readUndo();
            expect(undo?.entries.find((entry) => entry.branch === "stack-b")?.base).toBe("dev");
            yield* stack.undo(true);
            expect(doneTest.seen).toContain("edit 5 dev");
            expect(doneTest.seen).not.toContain("edit 5 stack-a");
          }).pipe(Effect.provide(doneTest.layer)),
        ),
      );
  });

  it.effect("land journals child retargets before a failed root merge", () => {
    const test = makeLand([], "stack-a", null, {
      merge: () => Effect.fail(new ExecError("gh", ["pr", "merge", "4"], 1, "blocked")),
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      yield* Effect.flip(stack.land("stack-a", { apply: true }));
      const undo = yield* store.readUndo();

      expect(test.seen).toContain("edit 5 dev");
      expect(undo?.entries.find((entry) => Number(entry.pr) === 5)?.base).toBe("stack-a");

      yield* stack.undo(true);
      expect(test.seen).toContain("edit 5 stack-a");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land removes root-only stack metadata", () => {
    let changes = [pr(4, "stack-a", "dev")];
    const layer = stackTestLayer({
      current: "stack-a",
      refs: [ref("dev", "dev"), ref("stack-a", "stack-a")],
      pulls: changes,
      bases: bases(["stack-a", "dev", "dev"]),
      state: stackState([stackLink({ branch: "stack-a", parent: "dev", anchor: "dev", pr: 4 })]),
      service: {
        changes: () => Effect.succeed(changes),
        merge: (number) =>
          Effect.sync(() => void (changes = changes.filter((item) => item.number !== number))),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const output = (yield* stack.land("stack-a", { apply: true })).join("\n");

      expect((yield* store.read()).links).toEqual([]);
      expect(output).toContain("stack is current");
    }).pipe(Effect.provide(layer));
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

  it.effect("land repair and final diagram only include the selected stack", () => {
    const seen: Array<string> = [];
    const layer = stackTestLayer({
      current: "active-child",
      refs: [
        ref("dev", "dev-new"),
        ref("active-root", "active-root"),
        ref("active-child", "active-child"),
        ref("other-root", "other-root"),
        ref("other-child", "other-child"),
      ],
      pulls: [
        pr(1, "active-root", "dev"),
        pr(2, "active-child", "active-root"),
        pr(3, "other-root", "dev"),
        pr(4, "other-child", "other-root"),
      ],
      bases: bases(
        ["active-root", "dev", "dev-new"],
        ["active-child", "active-root", "active-root"],
        ["other-root", "dev", "dev-old"],
        ["other-child", "other-root", "other-old"],
      ),
      state: stackState([
        stackLink({ branch: "active-root", parent: "dev", anchor: "dev-new", pr: 1 }),
        stackLink({ branch: "active-child", parent: "active-root", anchor: "active-root", pr: 2 }),
        stackLink({ branch: "other-root", parent: "dev", anchor: "dev-old", pr: 3 }),
        stackLink({ branch: "other-child", parent: "other-root", anchor: "other-old", pr: 4 }),
      ]),
      service: {
        replay: (branch) => Effect.sync(() => void seen.push(`rebase ${branch}`)),
        push: (branch) => Effect.sync(() => void seen.push(`push ${branch}`)),
        body: (number) => Effect.sync(() => void seen.push(`body ${number}`)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const store = yield* Store;
      const preview = (yield* stack.land("active-root")).join("\n");

      expect(preview).toContain("would rebase active-child onto dev");
      expect(preview).not.toContain("other-root");
      expect(preview).not.toContain("other-child");

      const applied = (yield* stack.land("active-root", { apply: true })).join("\n");
      const state = yield* store.read();
      expect(applied).toContain("Stack");
      expect(applied).not.toContain("other-root");
      expect(applied).not.toContain("other-child");
      expect(seen).toContain("rebase active-child");
      expect(seen).toContain("push active-child");
      expect(seen.join("\n")).not.toContain("other-root");
      expect(seen.join("\n")).not.toContain("other-child");
      expect(seen).not.toContain("body 3");
      expect(seen).not.toContain("body 4");
      expect(state.links.map((item) => String(item.branch))).toContain("other-root");
      expect(state.links.map((item) => String(item.branch))).toContain("other-child");
    }).pipe(Effect.provide(layer));
  });

  it.effect("land selects tracked changes when fork heads share a branch", () => {
    const layer = stackTestLayer({
      refs: [ref("dev", "dev-new"), ref("root", "root"), ref("child", "child")],
      pulls: [
        pullRef({
          number: 99,
          head: "root",
          headRepository: "other/project",
          base: "dev",
          url: "u99",
          draft: false,
        }),
        pullRef({
          number: 1,
          head: "root",
          headRepository: "tracked/project",
          base: "dev",
          url: "u1",
          draft: false,
        }),
        pullRef({
          number: 98,
          head: "child",
          headRepository: "other/project",
          base: "root",
          url: "u98",
          draft: false,
        }),
        pullRef({
          number: 2,
          head: "child",
          headRepository: "tracked/project",
          base: "root",
          url: "u2",
          draft: false,
        }),
      ],
      bases: bases(["root", "dev", "dev-new"], ["child", "root", "root"]),
      state: stackState([
        stackLink({ branch: "root", parent: "dev", anchor: "dev-new", pr: 1 }),
        stackLink({ branch: "child", parent: "root", anchor: "root", pr: 2 }),
      ]),
      service: {
        remotes: () =>
          Effect.succeed([{ name: "fork", url: "git@github.com:tracked/project.git" }]),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const preview = (yield* stack.land("root")).join("\n");

      expect(preview).toContain("would merge #1 (root)");
      expect(preview).toContain("would retarget #2 (child) to dev before merge");
      expect(preview).not.toContain("#99");
      expect(preview).not.toContain("#98");
    }).pipe(Effect.provide(layer));
  });

  it.effect("land refreshes stack blocks for requests recreated during repair", () => {
    const seen: Array<string> = [];
    let pulls = [pr(1, "active-root", "dev")];
    const layer = stackTestLayer({
      current: "active-child",
      refs: [
        ref("dev", "dev-new"),
        ref("active-root", "active-root"),
        ref("active-child", "active-child"),
      ],
      pulls,
      bases: bases(
        ["active-root", "dev", "dev-new"],
        ["active-child", "active-root", "active-root"],
      ),
      state: stackState([
        stackLink({ branch: "active-root", parent: "dev", anchor: "dev-new", pr: 1 }),
        stackLink({ branch: "active-child", parent: "active-root", anchor: "active-root", pr: 2 }),
      ]),
      service: {
        changes: () => Effect.succeed(pulls),
        merge: (number) =>
          Effect.sync(() => void (pulls = pulls.filter((item) => item.number !== number))),
        change: (number) => {
          const found = pulls.find((item) => item.number === number);
          return found
            ? Effect.succeed(metaFor(found))
            : Effect.fail(new CodeHostChangeNotFoundError(number));
        },
        create: (branch, base) =>
          Effect.sync(() => {
            const made = pr(5, branch, base);
            pulls = [...pulls, made];
            return made;
          }),
        body: (number) => Effect.sync(() => void seen.push(`body ${number}`)),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.land("active-root", { apply: true });

      expect(seen).toContain("body 5");
    }).pipe(Effect.provide(layer));
  });

  it.effect("land recreates a fork request from its original source repository", () => {
    const seen: Array<string> = [];
    let pulls = [pr(1, "active-root", "dev")];
    const layer = stackTestLayer({
      current: "active-child",
      refs: [
        ref("dev", "dev-new"),
        ref("active-root", "active-root"),
        ref("active-child", "active-child"),
      ],
      pulls,
      bases: bases(["active-root", "dev", "dev-new"]),
      state: stackState([
        stackLink({ branch: "active-root", parent: "dev", anchor: "dev-new", pr: 1 }),
        stackLink({
          branch: "active-child",
          parent: "active-root",
          anchor: "active-root",
          pr: 2,
          headRepository: "contributor/project",
        }),
      ]),
      service: {
        remotes: () =>
          Effect.succeed([
            { name: "origin", url: "git@gitlab.com:upstream/project.git" },
            { name: "fork", url: "git@gitlab.com:contributor/project.git" },
          ]),
        changes: () => Effect.succeed(pulls),
        merge: (number) =>
          Effect.sync(() => void (pulls = pulls.filter((item) => item.number !== number))),
        change: (number) => {
          const found = pulls.find((item) => item.number === number);
          return found
            ? Effect.succeed(metaFor(found))
            : Effect.fail(new CodeHostChangeNotFoundError(number));
        },
        push: (branch, remote = "origin") =>
          Effect.sync(() => void seen.push(`push ${branch} ${remote}`)),
        create: (branch, base, _title, _body, _labels, headRepository) =>
          Effect.sync(() => {
            seen.push(`create ${headRepository}`);
            const made = pullRef({
              number: 5,
              head: branch,
              ...(headRepository === undefined ? {} : { headRepository }),
              base,
              url: "u5",
              draft: false,
            });
            pulls = [...pulls, made];
            return made;
          }),
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.land("active-root", { apply: true });

      expect(seen).toContain("push active-child fork");
      expect(seen).toContain("create contributor/project");
    }).pipe(Effect.provide(layer));
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
      expect(test.seen[1]?.startsWith("backup stack-a backup/landed-")).toBe(true);
      expect(test.seen[2]).toBe("edit 5 dev");
      expect(test.seen[3]).toBe("auto 4");
      expect(test.seen[4]).toBe("wait 4 merged");
      expect(test.seen[5]).toBe("drop stack-a");
      expect(test.seen[6]).toBe("fetch");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land auto can merge through a target PR", () => {
    const test = makeLand();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const done = yield* stack.land(undefined, { auto: true, through: "5" });

      expect(done).toContain("enable auto-merge #4 (stack-a)");
      expect(done).toContain("enable auto-merge #5 (stack-b)");
      expect(done).toContain("merged through: stack-b");
      expect(done).not.toContain("enable auto-merge #3 (stack-c)");
      expect(test.seen).toContain("auto 4");
      expect(test.seen).toContain("auto 5");
      expect(test.seen).not.toContain("auto 3");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land auto rejects a through target outside the stack before merging", () => {
    const test = makeLand();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const error = yield* Effect.flip(stack.land(undefined, { auto: true, through: "stack-z" }));

      expect(String(error)).toContain("stack-z is not in the current stack from stack-a");
      expect(test.seen).not.toContain("auto 4");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land rejects through without auto", () => {
    const test = makeLand();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const error = yield* Effect.flip(stack.land(undefined, { through: "stack-b" }));

      expect(String(error)).toContain("use --through only with --auto");
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
      const error = yield* Effect.flip(stack.land("stack-a", { admin: true }));

      expect(String(error)).toContain("use --admin only with --apply");
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("land rejects GitLab admin merge before mutation", () => {
    const test = makeLand([], "stack-a", null, {
      provider: "gitlab",
      capabilities: { adminMerge: false },
      requestLabel: "MR",
      reference: (number) => `!${number}`,
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const error = yield* Effect.flip(stack.land("stack-a", { apply: true, admin: true }));

      expect(String(error)).toContain("--admin is not supported by gitlab");
      expect(test.seen).toEqual([]);
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

  it.effect("sync rebases descendants when an older PR branch changes", () =>
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
          CodeHostGitHub.memory({
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
        return yield* stack.sync({ apply: true });
      }).pipe(Effect.provide(layer));

      expect(items).not.toContain("rebase stack-b onto dev");
      expect(items).toContain("   └─ ✓ stack-c #3 rebased onto stack-b");
      expect(yield* shell(repo, "git", ["merge-base", "stack-c", "stack-b"])).toBe(
        yield* shell(repo, "git", ["rev-parse", "stack-b"]),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.effect("sync rebases a deep stack when PR 2 is refactored", () =>
    Effect.gen(function* () {
      const scenario = yield* realStack({
        branches: [
          {
            name: "stack-2",
            parent: "dev",
            number: 2,
            commits: [{ file: "two.txt", body: "two\n", message: "two" }],
          },
          {
            name: "stack-3",
            parent: "stack-2",
            number: 3,
            commits: [{ file: "three.txt", body: "three\n", message: "three" }],
          },
          {
            name: "stack-4",
            parent: "stack-3",
            number: 4,
            commits: [{ file: "four.txt", body: "four\n", message: "four" }],
          },
          {
            name: "stack-5",
            parent: "stack-4",
            number: 5,
            commits: [{ file: "five.txt", body: "five\n", message: "five" }],
          },
        ],
      });

      yield* scenario.git(["checkout", "stack-2"]);
      yield* commitFile(scenario.repo, "two-refactor.txt", "two refactor\n", "two refactor");
      yield* scenario.git(["push", "origin", "stack-2"]);

      const items = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        return yield* stack.sync({ apply: true });
      }).pipe(Effect.provide(scenario.layer));

      expect(items).not.toContain("rebase stack-2 onto dev");
      expect(items).toContain("   └─ ✓ stack-3 #3 rebased onto stack-2");
      expect(items).toContain("      └─ ✓ stack-4 #4 rebased onto stack-3");
      expect(items).toContain("         └─ ✓ stack-5 #5 rebased onto stack-4");
      expect(yield* scenario.git(["merge-base", "stack-3", "stack-2"])).toBe(
        yield* scenario.git(["rev-parse", "stack-2"]),
      );
      expect(yield* scenario.git(["merge-base", "stack-4", "stack-3"])).toBe(
        yield* scenario.git(["rev-parse", "stack-3"]),
      );
      expect(yield* scenario.git(["merge-base", "stack-5", "stack-4"])).toBe(
        yield* scenario.git(["rev-parse", "stack-4"]),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.effect("sync is idempotent after repairing a moved parent", () =>
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
        const first = yield* stack.sync({ apply: true });
        const second = yield* stack.sync({ apply: true });
        return { first, second };
      }).pipe(Effect.provide(scenario.layer));

      expect(result.first).toContain("   └─ ✓ stack-c #3 rebased onto stack-b");
      expect(result.second).not.toContain("   └─ ✓ stack-c #3 rebased onto stack-b");
      expect(result.second).toContain("Stack is current");
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
        const items = yield* stack.sync({ apply: true });
        const state = yield* store.read();
        const undo = yield* store.readUndo();
        return { items, state, undo };
      }).pipe(Effect.provide(scenario.layer));

      expect(result.items).toContain("└─ ● stack-a #2");
      expect(result.items).toContain("   └─ ● stack-b #3");
      expect(result.items).toContain("      └─ ● stack-c #4");
      expect(result.state.links.map((link) => String(link.branch))).toEqual([
        "stack-a",
        "stack-b",
        "stack-c",
      ]);
      expect(result.undo?.state.links).toEqual([]);
      expect(yield* scenario.git(["branch", "--show-current"])).toBe("stack-c");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("sync explains failed replay and keeps backup and undo journal", () =>
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
        yield* stack.sync({ apply: true }).pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              failed = true;
              expect(String(err)).toContain("✕ stack-c #3 failed to rebase onto stack-b");
              expect(String(err)).toContain("stack-c could not be replayed onto stack-b");
              expect(String(err)).toContain("stack undo --apply");
              expect(String(err)).toContain("stack sync");
            }),
          ),
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
        yield* stack.sync({ apply: true });
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
            err = cause instanceof DirtyWorktreeError ? cause.message : String(cause);
          }),
        ),
      );
      expect(err).toContain("worktree is dirty");
      expect(test.seen).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "land repairs descendants in a real git repository",
    () =>
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
    15_000,
  );
});

describe("RepairExecution", () => {
  it.effect("checkpoints before applying a branch rebase", () => {
    const log: Array<string> = [];
    const record = (line: string) => Effect.sync(() => void log.push(line));

    return RepairExecution.applyRebaseBranch(
      {
        branch: "stack-a",
        parent: "dev",
        onto: "origin/dev",
        backup: "backup/stack-a",
        commits: ["c1", "c2"],
        pushRemotes: ["fork", "origin"],
      },
      {
        checkpoint: () => record("checkpoint"),
        step: (message) => record(`step ${message}`),
        git: {
          backup: (branch, backup) => record(`backup ${branch} ${backup}`),
          replay: (branch, onto, commits) =>
            record(`replay ${branch} ${onto} ${commits.join(",")}`),
          push: (branch, remote) => record(`push ${branch} ${remote}`),
        },
        onReplayFailure: (error) => error,
      },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(log).toEqual([
            "checkpoint",
            "step backup stack-a -> backup/stack-a",
            "backup stack-a backup/stack-a",
            "step rebase stack-a onto dev",
            "replay stack-a origin/dev c1,c2",
            "step push stack-a to fork",
            "push stack-a fork",
            "step push stack-a",
            "push stack-a origin",
          ]);
        }),
      ),
    );
  });

  it.effect("does not mutate when a rebase checkpoint fails", () => {
    const log: Array<string> = [];
    const record = (line: string) => Effect.sync(() => void log.push(line));

    return Effect.gen(function* () {
      yield* Effect.flip(
        RepairExecution.applyRebaseBranch(
          {
            branch: "stack-a",
            parent: "dev",
            onto: "origin/dev",
            backup: "backup/stack-a",
            commits: [],
            pushRemotes: ["origin"],
          },
          {
            checkpoint: () => Effect.fail(new StackOperationError("checkpoint failed")),
            step: (message) => record(`step ${message}`),
            git: {
              backup: (branch, backup) => record(`backup ${branch} ${backup}`),
              replay: (branch, onto) => record(`replay ${branch} ${onto}`),
              push: (branch, remote) => record(`push ${branch} ${remote}`),
            },
            onReplayFailure: (error) => error,
          },
        ),
      );
      expect(log).toEqual([]);
    });
  });

  it.effect("checkpoints before retargeting a change", () => {
    const log: Array<string> = [];
    const record = (line: string) => Effect.sync(() => void log.push(line));

    return RepairExecution.applyRetargetPull(
      { pr: 7, base: "dev" },
      {
        checkpoint: () => record("checkpoint"),
        step: (message) => record(`step ${message}`),
        edit: (pr, base) => record(`edit ${pr} ${base}`),
        reference: (number) => `#${number}`,
      },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(log).toEqual(["checkpoint", "step retarget #7 to dev", "edit 7 dev"]);
        }),
      ),
    );
  });
});

describe("CodeHost", () => {
  it("keeps the legacy GitHub source namespace as a forwarding adapter", () => {
    expect(GitHub.layer).toBe(CodeHostGitHub.layer);
    expect(GitHub.memory).toBe(CodeHostGitHub.memory);
  });

  it("parses repository identity independently from the provider", () => {
    expect(CodeHost.remoteInfo("https://github.com/owner/repo.git")).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
    expect(CodeHost.remoteInfo("git@git.company.internal:group/subgroup/repo.git")).toEqual({
      host: "git.company.internal",
      owner: "group/subgroup",
      repo: "repo",
    });
  });

  it("preserves enterprise HTTPS ports and compares remote hosts case-insensitively", () => {
    expect(CodeHost.remoteInfo("https://gitlab.example.test:8443/group/repo.git")).toEqual({
      host: "gitlab.example.test:8443",
      owner: "group",
      repo: "repo",
    });
    expect(
      CodeHost.repositoryFor(
        "https://GITLAB.example.test:8443/group/fork.git",
        "https://gitlab.example.test:8443/group/repo.git",
      ),
    ).toBe("group/fork");
    expect(
      CodeHost.repositoryFor(
        "https://gitlab.example.test:8444/group/fork.git",
        "https://gitlab.example.test:8443/group/repo.git",
      ),
    ).toBeNull();
  });

  it("only auto-detects unambiguous public providers", () => {
    expect(CodeHost.detectProvider("https://github.com/owner/repo.git")).toBe("github");
    expect(CodeHost.detectProvider("git@gitlab.com:group/repo.git")).toBe("gitlab");
    expect(CodeHost.detectProvider("https://gitlab.example.com/team/repo.git")).toBeNull();
    expect(CodeHost.detectProvider("https://git.company.internal/team/repo.git")).toBeNull();
  });

  it("parses repository identities for configured enterprise hosts", () => {
    expect(CodeHost.repositoryFor("https://git.company.internal/group/repo.git")).toBe(
      "group/repo",
    );
    expect(
      CodeHost.repositoryFor(
        "https://gitlab.com/group/repo.git",
        "https://github.com/group/repo.git",
      ),
    ).toBeNull();
  });

  it.effect("adapters expose provider-native URL and reference behavior", () =>
    Effect.gen(function* () {
      const github = yield* CodeHost.Service;
      expect(github.reference(3)).toBe("#3");
      expect(github.changeUrlBase("https://github.enterprise.test/owner/repo.git")).toBe(
        "https://github.enterprise.test/owner/repo/pull",
      );
    }).pipe(Effect.provide(CodeHostGitHub.memory())),
  );

  it.effect("gitlab uses MR references and configured-host URLs", () =>
    Effect.gen(function* () {
      const gitlab = yield* CodeHost.Service;
      expect(gitlab.reference(3)).toBe("!3");
      expect(gitlab.changeUrlBase("https://git.company.test/group/repo.git")).toBe(
        "https://git.company.test/group/repo/-/merge_requests",
      );
    }).pipe(Effect.provide(CodeHostGitLab.memory())),
  );

  it("reads explicit CodeHost provider values", () => {
    expect(CodeHost.providerFrom(undefined)).toBeNull();
    expect(CodeHost.providerFrom("")).toBeNull();
    expect(CodeHost.providerFrom("github")).toBe("github");
    expect(CodeHost.providerFrom("GITLAB")).toBe("gitlab");
    expect(CodeHost.providerFrom("bitbucket")).toBeNull();
  });

  for (const adapter of [
    { provider: "github", state: "OPEN", memory: CodeHostGitHub.memory },
    { provider: "gitlab", state: "opened", memory: CodeHostGitLab.memory },
  ]) {
    it.effect(`${adapter.provider} memory layer satisfies the CodeHost contract`, () => {
      const log: Array<string> = [];
      return Effect.gen(function* () {
        const host = yield* CodeHost.Service;
        const created = yield* host.create("feature/x", "main", "title", "body", ["bug"]);
        expect(String(created.head)).toBe("feature/x");
        expect(String(created.base)).toBe("main");
        expect(yield* host.changes()).toHaveLength(1);

        yield* host.edit(created.number, "dev");
        yield* host.body(created.number, "updated body");
        const meta = yield* host.change(created.number);
        expect(String(meta.base)).toBe("dev");
        expect(meta.body).toBe("updated body");
        expect(String(meta.state)).toBe(adapter.state);
        expect(meta.labels.map((label) => label.name)).toEqual(["bug"]);

        yield* host.auto(created.number);
        yield* host.wait(created.number);
        yield* host.merge(created.number);
        expect(yield* host.changes()).toHaveLength(0);

        const closed = yield* host.create("feature/y", "dev", "title", "body", []);
        yield* host.close(closed.number);
        expect(yield* host.changes()).toHaveLength(0);
        expect(log).toEqual([
          "create feature/x main",
          `edit ${created.number} dev`,
          `body ${created.number}`,
          `auto ${created.number}`,
          `wait ${created.number}`,
          `merge ${created.number}`,
          "create feature/y dev",
          `close ${closed.number}`,
        ]);
      }).pipe(Effect.provide(adapter.memory({ log })));
    });

    it.effect(`${adapter.provider} memory layer keeps fixture metadata coherent`, () =>
      Effect.gen(function* () {
        const host = yield* CodeHost.Service;
        yield* host.body(1, "updated body");
        yield* host.edit(1, "dev");

        const list = yield* host.changes();
        expect(list[0]?.checks).toBe("pending");
        const meta = yield* host.change(1);
        expect(meta.title).toBe("existing title");
        expect(meta.body).toBe("updated body");
        expect(String(meta.base)).toBe("dev");

        const created = yield* host.create("feature/y", "main", "title", "body", []);
        expect(Number(created.number)).toBe(8);
      }).pipe(
        Effect.provide(
          adapter.memory({
            pulls: [
              pullRef({
                number: 1,
                title: "existing title",
                head: "feature/x",
                base: "main",
                url: "u1",
                draft: false,
                checks: "pending",
              }),
            ],
            metas: [
              pullMeta({
                number: 7,
                title: "historical",
                body: "",
                head: "historical",
                base: "main",
                url: "u7",
                draft: false,
                state: adapter.state,
                labels: [],
              }),
            ],
          }),
        ),
      ),
    );

    it.effect(`${adapter.provider} memory layer rejects mutations for missing changes`, () =>
      Effect.gen(function* () {
        const host = yield* CodeHost.Service;
        for (const operation of [
          host.edit(99, "dev"),
          host.body(99, "body"),
          host.close(99),
          host.merge(99),
          host.auto(99),
          host.wait(99),
        ]) {
          expect((yield* Effect.flip(operation))._tag).toBe("CodeHostChangeNotFoundError");
        }
      }).pipe(Effect.provide(adapter.memory())),
    );
  }

  it.effect("gitlab rejects admin merge rather than ignoring it", () =>
    Effect.gen(function* () {
      const host = yield* CodeHost.Service;
      const error = yield* Effect.flip(host.merge(1, { admin: true }));
      expect(error._tag).toBe("UnsupportedCodeHostOperation");
      expect(error.message).toContain("admin merge is not supported by gitlab");
    }).pipe(Effect.provide(CodeHostGitLab.memory())),
  );
});

describe("StackBlock", () => {
  const pulls = [
    pullRef({
      number: 1,
      title: "Feature A",
      head: "feat/a",
      base: "main",
      url: "u1",
      draft: false,
    }),
    pullRef({
      number: 2,
      title: "Feature B",
      head: "feat/b",
      base: "feat/a",
      url: "u2",
      draft: false,
    }),
    pullRef({
      number: 3,
      title: "Feature C",
      head: "feat/c",
      base: "feat/b",
      url: "u3",
      draft: false,
    }),
  ];

  it("renders GitHub PR references with the # prefix by default", () => {
    const block = StackBlock.render({
      pulls,
      metas: new Map(),
      chain: ["feat/a", "feat/b", "feat/c"],
      branch: "feat/b",
      previous: "",
    });
    expect(block).toContain("1. #1");
    expect(block).toContain("2. **#2** 👈 current");
    expect(block).toContain("3. #3");
    expect(block).not.toContain("Feature A");
  });

  it("renders GitLab MR references using the code host reference formatter", () => {
    const block = StackBlock.render({
      pulls,
      metas: new Map(),
      chain: ["feat/a", "feat/b", "feat/c"],
      branch: "feat/c",
      previous: "",
      reference: (number) => `!${number}`,
    });
    expect(block).toContain("1. !1");
    expect(block).toContain("2. !2");
    expect(block).toContain("3. **!3** 👈 current");
    expect(block).not.toContain("#1");
    expect(block).not.toContain("Feature A");
  });

  it("can render GitLab MR titles for scannable GitLab descriptions", () => {
    const block = StackBlock.render({
      pulls,
      metas: new Map(),
      chain: ["feat/a", "feat/b", "feat/c"],
      branch: "feat/c",
      previous: "",
      reference: (number) => `!${number}`,
      showTitles: true,
    });
    expect(block).toContain("1. !1 - Feature A");
    expect(block).toContain("2. !2 - Feature B");
    expect(block).toContain("3. **!3 - Feature C** 👈 current");
  });

  it("can enrich completed GitLab history with MR titles", () => {
    const previous = `body before

<!-- stack:links:start -->
### [Stack](https://github.com/kitlangton/stack)

1. !1
2. !2 - Already titled
3. **!3** 👈 current
<!-- stack:links:end -->`;
    const block = StackBlock.render({
      pulls: [],
      metas: new Map(),
      chain: [],
      branch: "feat/d",
      previous,
      reference: (number) => `!${number}`,
      showTitles: true,
      completedTitles: new Map([
        [1, "Feature A"],
        [2, "Feature B"],
        [3, "Feature C"],
      ]),
    });
    expect(block).toContain("1. !1 - Feature A");
    expect(block).toContain("2. !2 - Already titled");
    expect(block).toContain("3. !3 - Feature C");
  });

  it("parses both # and ! prefixed entries from a previous block", () => {
    const previous = `body before

<!-- stack:links:start -->
### [Stack](https://github.com/kitlangton/stack)

1. !1
2. !2
3. **!3** 👈 current
<!-- stack:links:end -->`;
    const block = StackBlock.render({
      pulls: [pulls[2]!],
      metas: new Map(),
      chain: ["feat/c"],
      branch: "feat/c",
      previous,
      reference: (number) => `!${number}`,
    });
    expect(block).toContain("**!3** 👈 current");
  });

  it("does not duplicate live entries when prefix migrates between syncs", () => {
    const previous = `body before

<!-- stack:links:start -->
### [Stack](https://github.com/kitlangton/stack)

1. #1
2. #2
3. **#3** 👈 current
<!-- stack:links:end -->`;
    const block = StackBlock.render({
      pulls,
      metas: new Map(),
      chain: ["feat/a", "feat/b", "feat/c"],
      branch: "feat/c",
      previous,
      reference: (number) => `!${number}`,
    });
    expect(block).not.toContain("#1");
    expect(block).not.toContain("#2");
    expect(block).not.toContain("#3");
    expect(block).toContain("1. !1");
    expect(block).toContain("2. !2");
    expect(block).toContain("3. **!3** 👈 current");
  });
});

describe("StackGraph trunk display", () => {
  it("treeFromStatus picks the trunk that is actually referenced as a parent", () => {
    const graph = StackGraph.make({
      state: stackState([stackLink({ branch: "feat/a", parent: "main", anchor: "x", pr: 1 })]),
      refs: [
        branchRef({ name: "dev", head: "d" }),
        branchRef({ name: "main", head: "m" }),
        branchRef({ name: "feat/a", head: "a" }),
      ],
      pulls: [pullRef({ number: 1, head: "feat/a", base: "main", url: "u1", draft: false })],
      trunks: ["dev", "main", "master"],
      current: "feat/a",
    });
    expect(graph.tree.trunk).toBe("main");
  });

  it("treeFromStatus falls back to first trunk when none is referenced", () => {
    const graph = StackGraph.make({
      state: stackState([]),
      refs: [],
      pulls: [],
      trunks: ["dev", "main"],
      current: "",
    });
    expect(graph.tree.trunk).toBe("dev");
  });
});
