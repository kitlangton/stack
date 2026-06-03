import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import {
  CodeHostChangeNotFoundError,
  PullLabel,
  pullMeta,
  type PullMeta,
  pullRef,
  type PullRef,
  UnsupportedCodeHostOperation,
} from "../../domain/model.ts";
import { CodeHost } from "../CodeHost.ts";

export interface Options {
  readonly properties: CodeHost.AdapterProperties;
  readonly state: string;
  readonly url: (number: number) => string;
  readonly pulls?: ReadonlyArray<PullRef>;
  readonly metas?: ReadonlyArray<PullMeta>;
  readonly log?: Array<string>;
}

export const layer = (opts: Options) =>
  Layer.effect(
    CodeHost.Service,
    Effect.gen(function* () {
      const pullsRef = yield* Ref.make(Array.from(opts.pulls ?? []));
      const metasRef = yield* Ref.make(
        new Map<number, PullMeta>((opts.metas ?? []).map((item) => [Number(item.number), item])),
      );
      let next =
        Math.max(
          0,
          ...Array.from(opts.pulls ?? [], (pull) => pull.number),
          ...Array.from(opts.metas ?? [], (meta) => meta.number),
        ) + 1;
      const record = (line: string) => Effect.sync(() => opts.log?.push(line));
      const metaFor = (found: PullRef) =>
        pullMeta({
          number: found.number,
          title: found.title ?? `stack: ${found.head}`,
          body: "",
          head: found.head,
          headRepository: found.headRepository,
          base: found.base,
          url: found.url,
          draft: found.draft,
          state: opts.state,
          labels: [],
        });

      const changes = Effect.fn("CodeHost.memory.changes")(() => Ref.get(pullsRef));
      const requireOpen = Effect.fn("CodeHost.memory.requireOpen")(function* (pr: number) {
        const found = (yield* Ref.get(pullsRef)).some((item) => item.number === pr);
        if (!found) return yield* new CodeHostChangeNotFoundError(pr);
      });
      const change = Effect.fn("CodeHost.memory.change")(function* (pr: number) {
        const metas = yield* Ref.get(metasRef);
        const meta = metas.get(pr);
        if (meta) return meta;
        const found = (yield* Ref.get(pullsRef)).find((item) => item.number === pr);
        if (!found) return yield* new CodeHostChangeNotFoundError(pr);
        const made = metaFor(found);
        yield* Ref.update(metasRef, (metas) => new Map(metas).set(pr, made));
        return made;
      });
      const edit = Effect.fn("CodeHost.memory.edit")((pr: number, base: string) =>
        Effect.gen(function* () {
          yield* requireOpen(pr);
          yield* record(`edit ${pr} ${base}`);
          yield* Ref.update(pullsRef, (pulls) =>
            pulls.map((item) =>
              item.number === pr
                ? pullRef({
                    number: item.number,
                    title: item.title,
                    head: item.head,
                    headRepository: item.headRepository,
                    base,
                    url: item.url,
                    draft: item.draft,
                    checks: item.checks,
                  })
                : item,
            ),
          );
          yield* Ref.update(metasRef, (metas) => {
            const nextMetas = new Map(metas);
            const current = nextMetas.get(pr);
            if (current) {
              nextMetas.set(
                pr,
                pullMeta({
                  number: current.number,
                  title: current.title,
                  body: current.body,
                  head: current.head,
                  headRepository: current.headRepository,
                  base,
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
      const body = Effect.fn("CodeHost.memory.body")((pr: number, body: string) =>
        Effect.gen(function* () {
          yield* requireOpen(pr);
          yield* change(pr);
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
                  headRepository: current.headRepository,
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
      const create = Effect.fn("CodeHost.memory.create")(function* (
        branch: string,
        base: string,
        title: string,
        body: string,
        labels: ReadonlyArray<string>,
        headRepository?: string | null,
      ) {
        const number = next++;
        const made = pullRef({
          number,
          title,
          head: branch,
          headRepository: headRepository ?? null,
          base,
          url: opts.url(number),
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
              headRepository: headRepository ?? null,
              base,
              url: made.url,
              draft: made.draft,
              state: opts.state,
              labels: labels.map((name) => new PullLabel({ name })),
            }),
          ),
        );
        return made;
      });
      const close = Effect.fn("CodeHost.memory.close")((pr: number) =>
        Effect.gen(function* () {
          yield* requireOpen(pr);
          yield* record(`close ${pr}`);
          yield* Ref.update(pullsRef, (pulls) => pulls.filter((item) => item.number !== pr));
        }),
      );
      const merge = Effect.fn("CodeHost.memory.merge")(function* (
        pr: number,
        mergeOpts?: { readonly admin?: boolean },
      ) {
        if (mergeOpts?.admin && !opts.properties.capabilities.adminMerge) {
          return yield* new UnsupportedCodeHostOperation(opts.properties.provider, "admin merge");
        }
        yield* requireOpen(pr);
        yield* record(`merge ${pr}`);
        yield* Ref.update(pullsRef, (pulls) => pulls.filter((item) => item.number !== pr));
      });
      const auto = Effect.fn("CodeHost.memory.auto")(function* (pr: number) {
        yield* requireOpen(pr);
        yield* record(`auto ${pr}`);
      });
      const wait = Effect.fn("CodeHost.memory.wait")(function* (pr: number) {
        yield* requireOpen(pr);
        yield* record(`wait ${pr}`);
      });

      return CodeHost.Service.of({
        ...opts.properties,
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

export * as CodeHostMemory from "./Memory.ts";
