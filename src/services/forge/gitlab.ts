import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  ExecError,
  ForgeDecodeError,
  PullLabel,
  pullMeta,
  PullMeta,
  pullRef,
  PullRef,
} from "../../domain/model.ts";
import * as Proc from "../../platform/proc.ts";
import { StackConfig } from "../Config.ts";
import * as Forge from "../Forge.ts";

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
}) {}

class MRWatch extends Schema.Class<MRWatch>("MRWatch")({
  state: Schema.String,
  merged_at: Schema.NullOr(Schema.String),
}) {}

const MRListJson = Schema.Array(MRData);

const decodeMRList = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(MRListJson)(JSON.parse(out)),
    catch: (err) => new ForgeDecodeError("glab", args, out, String(err)),
  });

const decodeMRView = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(MRView)(JSON.parse(out)),
    catch: (err) => new ForgeDecodeError("glab", args, out, String(err)),
  });

const decodeMRWatch = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(MRWatch)(JSON.parse(out)),
    catch: (err) => new ForgeDecodeError("glab", args, out, String(err)),
  });

const decodeMRData = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(MRData)(JSON.parse(out)),
    catch: (err) => new ForgeDecodeError("glab", args, out, String(err)),
  });

const ref = (row: MRData) =>
  pullRef({
    number: row.iid,
    title: row.title,
    head: row.source_branch,
    base: row.target_branch,
    url: row.web_url,
    draft: row.draft,
  });

const meta = (row: MRView) =>
  pullMeta({
    number: row.iid,
    title: row.title,
    body: row.description ?? "",
    head: row.source_branch,
    base: row.target_branch,
    url: row.web_url,
    draft: row.draft,
    state: row.state,
    labels: row.labels.map((item) => new PullLabel({ name: labelName(item) })),
  });

export const layer = Layer.effect(
  Forge.Service,
  Effect.gen(function* () {
    const cfg = yield* StackConfig;
    const proc = yield* Proc.Service;

    const run = Effect.fn("Forge.gitlab.run")(function* (
      args: ReadonlyArray<string>,
      ok: ReadonlyArray<number> = [0],
    ) {
      return yield* proc.exec(cfg.root, "glab", args, ok);
    });

    const pulls = Effect.fn("Forge.gitlab.pulls")(function* () {
      const args = ["mr", "list", "-F", "json", "--per-page", "200"];
      const out = yield* run(args);
      const rows = yield* decodeMRList(args, out);
      return rows.map(ref);
    });

    const pull = Effect.fn("Forge.gitlab.pull")((pr: number) => {
      const args = ["mr", "view", `${pr}`, "-F", "json"];
      return run(args).pipe(
        Effect.flatMap((out) => decodeMRView(args, out)),
        Effect.map(meta),
      );
    });

    const auto = Effect.fn("Forge.gitlab.auto")((pr: number) =>
      run(["mr", "merge", `${pr}`, "--auto-merge", "--squash", "--yes"]).pipe(Effect.asVoid),
    );

    const merge = Effect.fn("Forge.gitlab.merge")(
      (pr: number, _opts?: { readonly admin?: boolean }) =>
        run(["mr", "merge", `${pr}`, "--squash", "--yes"]).pipe(Effect.asVoid),
    );

    const wait = Effect.fn("Forge.gitlab.wait")((pr: number) =>
      Effect.gen(function* () {
        for (;;) {
          const args = ["mr", "view", `${pr}`, "-F", "json"];
          const out = yield* run(args);
          const row = yield* decodeMRWatch(args, out);

          if (row.merged_at || row.state === "merged") return;
          if (row.state === "closed" || row.state === "locked") {
            return yield* Effect.fail(
              new ExecError("glab", ["mr", "view", `${pr}`], 1, `MR !${pr} closed without merging`),
            );
          }

          yield* Effect.sleep(cfg.forgeWaitIntervalMillis);
        }
      }),
    );

    const edit = Effect.fn("Forge.gitlab.edit")((pr: number, base: string) =>
      run(["mr", "update", `${pr}`, "--target-branch", base]).pipe(Effect.asVoid),
    );

    const body = Effect.fn("Forge.gitlab.body")((pr: number, body: string) =>
      run(["mr", "update", `${pr}`, "--description", body]).pipe(Effect.asVoid),
    );

    const close = Effect.fn("Forge.gitlab.close")((pr: number) =>
      run(["mr", "close", `${pr}`]).pipe(Effect.asVoid),
    );

    const create = Effect.fn("Forge.gitlab.create")(function* (
      branch: string,
      base: string,
      title: string,
      body: string,
      labels: ReadonlyArray<string>,
    ) {
      yield* run([
        "mr",
        "create",
        "--source-branch",
        branch,
        "--target-branch",
        base,
        "--title",
        title,
        "--description",
        body,
        "--yes",
        ...labels.flatMap((label) => ["--label", label]),
      ]);

      const args = ["mr", "view", branch, "-F", "json"];
      const out = yield* run(args);
      const row = yield* decodeMRData(args, out);
      return ref(row);
    });

    return Forge.Service.of({
      auto,
      merge,
      wait,
      pulls,
      pull,
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
  Layer.effect(
    Forge.Service,
    Effect.gen(function* () {
      const pullsRef = yield* Ref.make(Array.from(opts.pulls ?? []));
      const metasRef = yield* Ref.make(
        new Map<number, PullMeta>((opts.metas ?? []).map((item) => [Number(item.number), item])),
      );
      let next = Math.max(0, ...Array.from(opts.pulls ?? [], (p) => p.number)) + 1;
      const record = (line: string) => Effect.sync(() => opts.log?.push(line));

      const pulls = Effect.fn("Forge.gitlab.memory.pulls")(() => Ref.get(pullsRef));
      const pull = Effect.fn("Forge.gitlab.memory.pull")((pr: number) =>
        Ref.get(metasRef).pipe(
          Effect.flatMap((metas) => {
            const meta = metas.get(pr);
            if (meta) return Effect.succeed(meta);
            return Ref.get(pullsRef).pipe(
              Effect.flatMap((pulls) => {
                const found = pulls.find((item) => item.number === pr);
                return found
                  ? Effect.succeed(
                      pullMeta({
                        number: found.number,
                        title: `stack: ${found.head}`,
                        body: "",
                        head: found.head,
                        base: found.base,
                        url: found.url,
                        draft: found.draft,
                        state: "opened",
                        labels: [],
                      }),
                    )
                  : Effect.fail(new ExecError("glab", ["mr", "view", `${pr}`], 1, "not found"));
              }),
            );
          }),
        ),
      );
      const edit = Effect.fn("Forge.gitlab.memory.edit")((pr: number, base: string) =>
        Effect.gen(function* () {
          yield* record(`edit ${pr} ${base}`);
          yield* Ref.update(pullsRef, (pulls) =>
            pulls.map((item) =>
              item.number === pr
                ? pullRef({
                    number: item.number,
                    title: item.title,
                    head: item.head,
                    base,
                    url: item.url,
                    draft: item.draft,
                  })
                : item,
            ),
          );
        }),
      );
      const body = Effect.fn("Forge.gitlab.memory.body")((pr: number, body: string) =>
        Effect.gen(function* () {
          yield* record(`body ${pr}`);
          yield* Ref.update(metasRef, (metas) => {
            const nextMetas = new Map(metas);
            const current = nextMetas.get(pr);
            if (current) {
              nextMetas.set(
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
            }
            return nextMetas;
          });
        }),
      );
      const create = Effect.fn("Forge.gitlab.memory.create")(function* (
        branch: string,
        base: string,
        title: string,
        body: string,
        labels: ReadonlyArray<string>,
      ) {
        const number = next++;
        const made = pullRef({
          number,
          title,
          head: branch,
          base,
          url: `https://example.com/-/merge_requests/${number}`,
          draft: false,
        });
        yield* record(`create ${branch} ${base}`);
        yield* Ref.update(pullsRef, (pulls) => [...pulls, made]);
        yield* Ref.update(metasRef, (metas) =>
          new Map(metas).set(
            number,
            pullMeta({
              number,
              title,
              body,
              head: branch,
              base,
              url: made.url,
              draft: made.draft,
              state: "opened",
              labels: labels.map((name) => new PullLabel({ name })),
            }),
          ),
        );
        return made;
      });
      const close = Effect.fn("Forge.gitlab.memory.close")((pr: number) =>
        Effect.gen(function* () {
          yield* record(`close ${pr}`);
          yield* Ref.update(pullsRef, (pulls) => pulls.filter((item) => item.number !== pr));
        }),
      );
      const merge = Effect.fn("Forge.gitlab.memory.merge")((pr: number) =>
        Effect.gen(function* () {
          yield* record(`merge ${pr}`);
          yield* Ref.update(pullsRef, (pulls) => pulls.filter((item) => item.number !== pr));
        }),
      );
      const auto = Effect.fn("Forge.gitlab.memory.auto")((pr: number) => record(`auto ${pr}`));
      const wait = Effect.fn("Forge.gitlab.memory.wait")((pr: number) => record(`wait ${pr}`));

      return Forge.Service.of({
        auto,
        merge,
        wait,
        pulls,
        pull,
        edit,
        body,
        close,
        create,
      });
    }),
  );
