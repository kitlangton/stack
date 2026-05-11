import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  ExecError,
  GitHubDecodeError,
  type GitHubError,
  PullLabel,
  pullMeta,
  PullMeta,
  pullRef,
  PullRef,
} from "../domain/model.ts";
import * as Proc from "../platform/proc.ts";
import { StackConfig } from "./Config.ts";

export interface Interface {
  readonly auto: (pr: number) => Effect.Effect<void, GitHubError>;
  readonly merge: (
    pr: number,
    opts?: { readonly admin?: boolean },
  ) => Effect.Effect<void, GitHubError>;
  readonly wait: (pr: number) => Effect.Effect<void, GitHubError>;
  readonly pulls: () => Effect.Effect<ReadonlyArray<PullRef>, GitHubError>;
  readonly pull: (pr: number) => Effect.Effect<PullMeta, GitHubError>;
  readonly edit: (pr: number, base: string) => Effect.Effect<void, GitHubError>;
  readonly body: (pr: number, body: string) => Effect.Effect<void, GitHubError>;
  readonly close: (pr: number) => Effect.Effect<void, GitHubError>;
  readonly create: (
    branch: string,
    base: string,
    title: string,
    body: string,
    labels: ReadonlyArray<string>,
  ) => Effect.Effect<PullRef, GitHubError>;
}

class PullData extends Schema.Class<PullData>("PullData")({
  number: Schema.Number,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
}) {}

class PullView extends Schema.Class<PullView>("PullView")({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.String,
  headRefName: Schema.String,
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

const PullListJson = Schema.Array(PullData);

const decodePullList = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PullListJson)(JSON.parse(out)),
    catch: (err) => new GitHubDecodeError(args, out, String(err)),
  });

const decodePullView = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PullView)(JSON.parse(out)),
    catch: (err) => new GitHubDecodeError(args, out, String(err)),
  });

const decodePullWatch = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PullWatch)(JSON.parse(out)),
    catch: (err) => new GitHubDecodeError(args, out, String(err)),
  });

const decodePullData = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PullData)(JSON.parse(out)),
    catch: (err) => new GitHubDecodeError(args, out, String(err)),
  });

const ref = (row: PullData) =>
  pullRef({
    number: row.number,
    head: row.headRefName,
    base: row.baseRefName,
    url: row.url,
    draft: row.isDraft,
  });

const meta = (row: PullView) =>
  pullMeta({
    number: row.number,
    title: row.title,
    body: row.body,
    head: row.headRefName,
    base: row.baseRefName,
    url: row.url,
    draft: row.isDraft,
    state: "OPEN",
    labels: row.labels.map((item) => new PullLabel({ name: item.name })),
  });

export class Service extends Context.Service<Service, Interface>()(
  "@stack/GitHub",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
      const cfg = yield* StackConfig;
      const proc = yield* Proc.Service;

      const run = Effect.fn("GitHub.run")(function* (
        args: ReadonlyArray<string>,
        ok: ReadonlyArray<number> = [0],
      ) {
        return yield* proc.exec(cfg.root, "gh", args, ok);
      });

      const pulls = Effect.fn("GitHub.pulls")(function* () {
        const args = [
          "pr",
          "list",
          "--state",
          "open",
          "--json",
          "number,headRefName,baseRefName,url,isDraft",
          "--limit",
          "200",
        ];
        const out = yield* run(args);

        const rows = yield* decodePullList(args, out);

        return rows.map(ref);
      });

      const pull = Effect.fn("GitHub.pull")((pr: number) => {
        const args = [
          "pr",
          "view",
          `${pr}`,
          "--json",
          "number,title,body,headRefName,baseRefName,url,isDraft,labels",
        ];
        return run(args).pipe(
          Effect.flatMap((out) => decodePullView(args, out)),
          Effect.map(meta),
        );
      });

      const auto = Effect.fn("GitHub.auto")((pr: number) =>
        run([
          "pr",
          "merge",
          `${pr}`,
          "--auto",
          "--squash",
        ]).pipe(Effect.asVoid),
      );

      const merge = Effect.fn("GitHub.merge")((
        pr: number,
        opts?: { readonly admin?: boolean },
      ) =>
        run([
          "pr",
          "merge",
          `${pr}`,
          "--squash",
          ...(opts?.admin ? ["--admin"] : []),
        ]).pipe(
          Effect.asVoid,
        ),
      );

      const wait = Effect.fn("GitHub.wait")((pr: number) =>
        Effect.gen(function* () {
          for (;;) {
            const args = [
              "pr",
              "view",
              `${pr}`,
              "--json",
              "state,mergedAt",
            ];
            const out = yield* run(args);
            const row = yield* decodePullWatch(args, out);

            if (row.mergedAt) return;
            if (row.state !== "OPEN") {
              return yield* Effect.fail(
                new ExecError(
                  "gh",
                  ["pr", "view", `${pr}`],
                  1,
                  `PR #${pr} closed without merging`,
                ),
              );
            }

            yield* Effect.sleep(cfg.githubWaitIntervalMillis);
          }
        }),
      );

      const edit = Effect.fn("GitHub.edit")((pr: number, base: string) =>
        run(["pr", "edit", `${pr}`, "--base", base]).pipe(Effect.asVoid),
      );

      const body = Effect.fn("GitHub.body")((pr: number, body: string) =>
        run(["pr", "edit", `${pr}`, "--body", body]).pipe(Effect.asVoid),
      );

      const close = Effect.fn("GitHub.close")((pr: number) =>
        run(["pr", "close", `${pr}`]).pipe(Effect.asVoid),
      );

      const create = Effect.fn("GitHub.create")(function* (
        branch: string,
        base: string,
        title: string,
        body: string,
        labels: ReadonlyArray<string>,
      ) {
        yield* run([
          "pr",
          "create",
          "--head",
          branch,
          "--base",
          base,
          "--title",
          title,
          "--body",
          body,
          ...labels.flatMap((label) => ["--label", label]),
        ]);

        const args = [
          "pr",
          "view",
          branch,
          "--json",
          "number,headRefName,baseRefName,url,isDraft",
        ];
        const out = yield* run(args);

        const row = yield* decodePullData(args, out);

        return ref(row);
      });

      return Service.of({
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

export const memory = (opts: {
  readonly pulls?: ReadonlyArray<PullRef>;
  readonly metas?: ReadonlyArray<PullMeta>;
  readonly log?: Array<string>;
} = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
        const pullsRef = yield* Ref.make(Array.from(opts.pulls ?? []));
        const metasRef = yield* Ref.make(
          new Map<number, PullMeta>(
            (opts.metas ?? []).map((item) => [Number(item.number), item]),
          ),
        );
        let next = Math.max(0, ...Array.from(opts.pulls ?? [], (p) => p.number)) + 1;
        const record = (line: string) => Effect.sync(() => opts.log?.push(line));

        const pulls = Effect.fn("GitHub.memory.pulls")(() => Ref.get(pullsRef));
        const pull = Effect.fn("GitHub.memory.pull")((pr: number) =>
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
                          state: "OPEN",
                          labels: [],
                        }),
                      )
                    : Effect.fail(new ExecError("gh", ["pr", "view", `${pr}`], 1, "not found"));
                }),
              );
            }),
          ),
        );
        const edit = Effect.fn("GitHub.memory.edit")((pr: number, base: string) =>
          Effect.gen(function* () {
            yield* record(`edit ${pr} ${base}`);
            yield* Ref.update(pullsRef, (pulls) =>
              pulls.map((item) =>
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
          }),
        );
        const body = Effect.fn("GitHub.memory.body")((pr: number, body: string) =>
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
        const create = Effect.fn("GitHub.memory.create")(function* (
          branch: string,
          base: string,
          title: string,
          body: string,
          labels: ReadonlyArray<string>,
        ) {
          const number = next++;
          const made = pullRef({
            number,
            head: branch,
            base,
            url: `https://example.com/${number}`,
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
                state: "OPEN",
                labels: labels.map((name) => new PullLabel({ name })),
              }),
            ),
          );
          return made;
        });
        const close = Effect.fn("GitHub.memory.close")((pr: number) =>
          Effect.gen(function* () {
            yield* record(`close ${pr}`);
            yield* Ref.update(pullsRef, (pulls) => pulls.filter((item) => item.number !== pr));
          }),
        );
        const merge = Effect.fn("GitHub.memory.merge")((pr: number) =>
          Effect.gen(function* () {
            yield* record(`merge ${pr}`);
            yield* Ref.update(pullsRef, (pulls) => pulls.filter((item) => item.number !== pr));
          }),
        );
        const auto = Effect.fn("GitHub.memory.auto")((pr: number) =>
          record(`auto ${pr}`),
        );
        const wait = Effect.fn("GitHub.memory.wait")((pr: number) =>
          record(`wait ${pr}`),
        );

        return Service.of({
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
