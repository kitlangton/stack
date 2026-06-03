import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  ExecError,
  CodeHostChangeNotFoundError,
  CodeHostDecodeError,
  PullLabel,
  pullMeta,
  PullMeta,
  pullRef,
  PullRef,
} from "../../domain/model.ts";
import * as Proc from "../../platform/proc.ts";
import { StackConfig } from "../Config.ts";
import { CodeHost } from "../CodeHost.ts";
import { CodeHostMemory } from "./Memory.ts";

class PullView extends Schema.Class<PullView>("PullView")({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.String,
  headRefName: Schema.String,
  headRepository: Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String })),
  baseRefName: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  labels: Schema.Array(
    Schema.Struct({
      name: Schema.String,
    }),
  ),
}) {}

class PullWatch extends Schema.Class<PullWatch>("PullWatch")({
  state: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
}) {}

class PullListData extends Schema.Class<PullListData>("PullListData")({
  number: Schema.Number,
  title: Schema.String,
  head: Schema.Struct({
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
  html_url: Schema.String,
  draft: Schema.Boolean,
}) {}

const PullListJson = Schema.Array(Schema.Array(PullListData));

const decodePullList = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PullListJson)(JSON.parse(out)),
    catch: (err) => new CodeHostDecodeError("gh", args, out, String(err)),
  });

const decodePullView = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PullView)(JSON.parse(out)),
    catch: (err) => new CodeHostDecodeError("gh", args, out, String(err)),
  });

const decodePullWatch = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PullWatch)(JSON.parse(out)),
    catch: (err) => new CodeHostDecodeError("gh", args, out, String(err)),
  });

const missingPull = (err: ExecError) =>
  /not found|could not resolve|no pull request|404/i.test(err.stderr);

const listRef = (row: PullListData) =>
  pullRef({
    number: row.number,
    title: row.title,
    head: row.head.ref,
    headRepository: row.head.repo?.full_name.toLowerCase() ?? null,
    base: row.base.ref,
    url: row.html_url,
    draft: row.draft,
  });

const meta = (row: PullView) =>
  pullMeta({
    number: row.number,
    title: row.title,
    body: row.body,
    head: row.headRefName,
    headRepository: row.headRepository?.nameWithOwner.toLowerCase() ?? null,
    base: row.baseRefName,
    url: row.url,
    draft: row.isDraft,
    state: "OPEN",
    labels: row.labels.map((item) => new PullLabel({ name: item.name })),
  });

const properties = {
  provider: "github" as const,
  capabilities: { adminMerge: true },
  requestLabel: "PR" as const,
  reference: (number: number) => `#${number}`,
  repository: (remote: string, origin?: string) =>
    CodeHost.repositoryFor(remote, origin)?.toLowerCase() ?? null,
  changeUrlBase: (remote: string) => {
    const info = CodeHost.remoteInfo(remote);
    return info ? `https://${info.host}/${info.owner}/${info.repo}/pull` : null;
  },
} satisfies CodeHost.AdapterProperties;

export const layer = Layer.effect(
  CodeHost.Service,
  Effect.gen(function* () {
    const cfg = yield* StackConfig;
    const proc = yield* Proc.Service;

    const run = Effect.fn("CodeHost.github.run")(function* (
      args: ReadonlyArray<string>,
      ok: ReadonlyArray<number> = [0],
    ) {
      return yield* proc.exec(cfg.root, "gh", args, ok);
    });

    const changes = Effect.fn("CodeHost.github.changes")(function* () {
      const args = [
        "api",
        "repos/{owner}/{repo}/pulls?state=open&per_page=100",
        "--paginate",
        "--slurp",
      ];
      const out = yield* run(args);
      const rows = yield* decodePullList(args, out);
      return rows.flatMap((page) => page.map(listRef));
    });

    const change = Effect.fn("CodeHost.github.change")((pr: number) => {
      const args = [
        "pr",
        "view",
        `${pr}`,
        "--json",
        "number,title,body,headRefName,headRepository,baseRefName,url,isDraft,labels",
      ];
      return run(args).pipe(
        Effect.catchIf(missingPull, () => Effect.fail(new CodeHostChangeNotFoundError(pr))),
        Effect.flatMap((out) => decodePullView(args, out)),
        Effect.map(meta),
      );
    });

    const auto = Effect.fn("CodeHost.github.auto")((pr: number) =>
      run(["pr", "merge", `${pr}`, "--auto", "--squash"]).pipe(Effect.asVoid),
    );

    const merge = Effect.fn("CodeHost.github.merge")(
      (pr: number, opts?: { readonly admin?: boolean }) =>
        run(["pr", "merge", `${pr}`, "--squash", ...(opts?.admin ? ["--admin"] : [])]).pipe(
          Effect.asVoid,
        ),
    );

    const wait = Effect.fn("CodeHost.github.wait")((pr: number) =>
      Effect.gen(function* () {
        for (;;) {
          const args = ["pr", "view", `${pr}`, "--json", "state,mergedAt"];
          const out = yield* run(args);
          const row = yield* decodePullWatch(args, out);

          if (row.mergedAt) return;
          if (row.state !== "OPEN") {
            return yield* Effect.fail(
              new ExecError("gh", ["pr", "view", `${pr}`], 1, `PR #${pr} closed without merging`),
            );
          }

          yield* Effect.sleep(cfg.codeHostWaitIntervalMillis);
        }
      }),
    );

    const edit = Effect.fn("CodeHost.github.edit")((pr: number, base: string) =>
      run(["pr", "edit", `${pr}`, "--base", base]).pipe(Effect.asVoid),
    );

    const body = Effect.fn("CodeHost.github.body")((pr: number, body: string) =>
      run(["pr", "edit", `${pr}`, "--body", body]).pipe(Effect.asVoid),
    );

    const close = Effect.fn("CodeHost.github.close")((pr: number) =>
      run(["pr", "close", `${pr}`]).pipe(Effect.asVoid),
    );

    const create = Effect.fn("CodeHost.github.create")(function* (
      branch: string,
      base: string,
      title: string,
      body: string,
      labels: ReadonlyArray<string>,
      headRepository?: string | null,
    ) {
      const head = headRepository ? `${headRepository.split("/")[0]}:${branch}` : branch;
      const created = yield* run([
        "pr",
        "create",
        "--head",
        head,
        "--base",
        base,
        "--title",
        title,
        "--body",
        body,
        ...labels.flatMap((label) => ["--label", label]),
      ]);

      const number = Number(created.trim().match(/\/pull\/(\d+)\/?$/)?.[1]);
      if (!Number.isInteger(number)) {
        return yield* new CodeHostDecodeError("gh", ["pr", "create"], created, "missing PR number");
      }
      return pullRef({
        number,
        title,
        head: branch,
        headRepository: headRepository?.toLowerCase() ?? null,
        base,
        url: created.trim(),
        draft: false,
      });
    });

    return CodeHost.Service.of({
      ...properties,
      auto,
      merge,
      wait,
      changes,
      change,
      edit,
      body,
      close,
      create,
    });
  }),
);

export const memory = (
  opts: {
    readonly pulls?: ReadonlyArray<PullRef>;
    readonly metas?: ReadonlyArray<PullMeta>;
    readonly log?: Array<string>;
  } = {},
) =>
  CodeHostMemory.layer({
    ...opts,
    properties,
    state: "OPEN",
    url: (number) => `https://example.com/${number}`,
  });

export * as CodeHostGitHub from "./GitHub.ts";
