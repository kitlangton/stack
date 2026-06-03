import * as Cache from "effect/Cache";
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
  UnsupportedCodeHostOperation,
} from "../../domain/model.ts";
import * as Proc from "../../platform/proc.ts";
import { StackConfig } from "../Config.ts";
import { CodeHost } from "../CodeHost.ts";
import { CodeHostMemory } from "./Memory.ts";

const LabelEntry = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]);

const labelName = (entry: typeof LabelEntry.Type): string =>
  typeof entry === "string" ? entry : entry.name;

class MRData extends Schema.Class<MRData>("MRData")({
  iid: Schema.Number,
  title: Schema.String,
  source_branch: Schema.String,
  target_branch: Schema.String,
  web_url: Schema.String,
  draft: Schema.Boolean,
  source_project_id: Schema.NullOr(Schema.Number),
}) {}

class MRView extends Schema.Class<MRView>("MRView")({
  iid: Schema.Number,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  source_branch: Schema.String,
  target_branch: Schema.String,
  web_url: Schema.String,
  draft: Schema.Boolean,
  state: Schema.String,
  labels: Schema.Array(LabelEntry),
  source_project_id: Schema.NullOr(Schema.Number),
}) {}

class MRWatch extends Schema.Class<MRWatch>("MRWatch")({
  state: Schema.String,
  merged_at: Schema.NullOr(Schema.String),
}) {}

class ProjectData extends Schema.Class<ProjectData>("ProjectData")({
  path_with_namespace: Schema.String,
}) {}

const decodeMRList = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () =>
      out
        .split("\n")
        .filter(Boolean)
        .map((line) => Schema.decodeUnknownSync(MRData)(JSON.parse(line))),
    catch: (err) => new CodeHostDecodeError("glab", args, out, String(err)),
  });

const decodeMRView = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(MRView)(JSON.parse(out)),
    catch: (err) => new CodeHostDecodeError("glab", args, out, String(err)),
  });

const decodeMRWatch = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(MRWatch)(JSON.parse(out)),
    catch: (err) => new CodeHostDecodeError("glab", args, out, String(err)),
  });

const decodeProjectData = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(ProjectData)(JSON.parse(out)),
    catch: (err) => new CodeHostDecodeError("glab", args, out, String(err)),
  });

const missingPull = (err: ExecError) => /not found|404/i.test(err.stderr);

const ref = (row: MRData, headRepository: string | null) =>
  pullRef({
    number: row.iid,
    title: row.title,
    head: row.source_branch,
    headRepository,
    base: row.target_branch,
    url: row.web_url,
    draft: row.draft,
  });

const meta = (row: MRView, headRepository: string | null) =>
  pullMeta({
    number: row.iid,
    title: row.title,
    body: row.description ?? "",
    head: row.source_branch,
    headRepository,
    base: row.target_branch,
    url: row.web_url,
    draft: row.draft,
    state: row.state,
    labels: row.labels.map((item) => new PullLabel({ name: labelName(item) })),
  });

const properties = {
  provider: "gitlab" as const,
  capabilities: { adminMerge: false },
  requestLabel: "MR" as const,
  reference: (number: number) => `!${number}`,
  repository: CodeHost.repositoryFor,
  changeUrlBase: (remote: string) => {
    const info = CodeHost.remoteInfo(remote);
    return info ? `https://${info.host}/${info.owner}/${info.repo}/-/merge_requests` : null;
  },
} satisfies CodeHost.AdapterProperties;

export const layer = Layer.effect(
  CodeHost.Service,
  Effect.gen(function* () {
    const cfg = yield* StackConfig;
    const proc = yield* Proc.Service;

    const run = Effect.fn("CodeHost.gitlab.run")(function* (
      args: ReadonlyArray<string>,
      ok: ReadonlyArray<number> = [0],
    ) {
      return yield* proc.exec(cfg.root, "glab", args, ok);
    });

    const repositories = yield* Cache.make({
      capacity: 256,
      lookup: Effect.fn("CodeHost.gitlab.sourceRepository.lookup")(function* (id: number) {
        const args = ["api", `projects/${id}`];
        const out = yield* run(args);
        const project = yield* decodeProjectData(args, out);
        return project.path_with_namespace;
      }),
    });

    const sourceRepository = Effect.fn("CodeHost.gitlab.sourceRepository")(function* (
      id: number | null,
    ) {
      return id === null ? null : yield* Cache.get(repositories, id);
    });

    const changes = Effect.fn("CodeHost.gitlab.changes")(function* () {
      const args = [
        "api",
        "projects/:id/merge_requests?state=opened&per_page=100",
        "--paginate",
        "--output",
        "ndjson",
      ];
      const out = yield* run(args);
      const rows = yield* decodeMRList(args, out);
      return yield* Effect.forEach(
        rows,
        (row) => sourceRepository(row.source_project_id).pipe(Effect.map((repo) => ref(row, repo))),
        { concurrency: cfg.codeHostConcurrency },
      );
    });

    const change = Effect.fn("CodeHost.gitlab.change")((pr: number) => {
      const args = ["mr", "view", `${pr}`, "-F", "json"];
      return run(args).pipe(
        Effect.catchIf(missingPull, () => Effect.fail(new CodeHostChangeNotFoundError(pr))),
        Effect.flatMap((out) => decodeMRView(args, out)),
        Effect.flatMap((row) =>
          sourceRepository(row.source_project_id).pipe(Effect.map((repo) => meta(row, repo))),
        ),
      );
    });

    const auto = Effect.fn("CodeHost.gitlab.auto")((pr: number) =>
      run([
        "api",
        `projects/:id/merge_requests/${pr}/merge`,
        "--method",
        "PUT",
        "--field",
        "auto_merge=true",
        "--field",
        "squash=true",
      ]).pipe(Effect.asVoid),
    );

    const merge = Effect.fn("CodeHost.gitlab.merge")(function* (
      pr: number,
      opts?: { readonly admin?: boolean },
    ) {
      if (opts?.admin) {
        return yield* Effect.fail(new UnsupportedCodeHostOperation("gitlab", "admin merge"));
      }
      yield* run(["mr", "merge", `${pr}`, "--auto-merge=false", "--squash", "--yes"]);
    });

    const wait = Effect.fn("CodeHost.gitlab.wait")((pr: number) =>
      Effect.gen(function* () {
        for (;;) {
          const args = ["mr", "view", `${pr}`, "-F", "json"];
          const out = yield* run(args);
          const row = yield* decodeMRWatch(args, out);

          if (row.merged_at || row.state === "merged") return;
          if (row.state === "closed") {
            return yield* Effect.fail(
              new ExecError("glab", ["mr", "view", `${pr}`], 1, `MR !${pr} closed without merging`),
            );
          }

          yield* Effect.sleep(cfg.codeHostWaitIntervalMillis);
        }
      }),
    );

    const edit = Effect.fn("CodeHost.gitlab.edit")((pr: number, base: string) =>
      run(["mr", "update", `${pr}`, "--target-branch", base, "--yes"]).pipe(Effect.asVoid),
    );

    const body = Effect.fn("CodeHost.gitlab.body")((pr: number, body: string) =>
      run([
        "api",
        `projects/:id/merge_requests/${pr}`,
        "--method",
        "PUT",
        "--raw-field",
        `description=${body}`,
      ]).pipe(Effect.asVoid),
    );

    const close = Effect.fn("CodeHost.gitlab.close")((pr: number) =>
      run(["mr", "close", `${pr}`]).pipe(Effect.asVoid),
    );

    const create = Effect.fn("CodeHost.gitlab.create")(function* (
      branch: string,
      base: string,
      title: string,
      body: string,
      labels: ReadonlyArray<string>,
      headRepository?: string | null,
    ) {
      const created = yield* run([
        "mr",
        "create",
        "--source-branch",
        branch,
        ...(headRepository ? ["--head", headRepository] : []),
        "--target-branch",
        base,
        "--title",
        title,
        "--description",
        body,
        "--yes",
        ...labels.flatMap((label) => ["--label", label]),
      ]);

      const number = Number(created.trim().match(/\/merge_requests\/(\d+)\/?$/)?.[1]);
      if (!Number.isInteger(number)) {
        return yield* new CodeHostDecodeError("glab", ["mr", "create"], created, "missing MR IID");
      }
      return pullRef({
        number,
        title,
        head: branch,
        headRepository: headRepository ?? null,
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
    state: "opened",
    url: (number) => `https://example.com/-/merge_requests/${number}`,
  });

export * as CodeHostGitLab from "./GitLab.ts";
