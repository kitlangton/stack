import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  BranchError,
  BranchRef,
  branchName,
  branchRef,
  DirtyWorktreeError,
  MergeBaseError,
  PullMeta,
  pullRef,
  PullRef,
  stackLink,
  StackLink,
  StackOperationError,
  type StackError,
  stackState,
  StatusReport,
  UndoEntry,
  undoEntry,
  undoState,
} from "../domain/model.ts";
import { renderDiagram } from "../format.ts";
import * as RepairPlan from "../repairPlan.ts";
import * as StackGraph from "../stackGraph.ts";
import * as StackBlock from "../stackBlock.ts";
import * as StackResult from "../stackResult.ts";
import { StackConfig } from "./Config.ts";
import * as Git from "./Git.ts";
import * as GitHub from "./GitHub.ts";
import * as Progress from "./Progress.ts";
import { Store } from "./Store.ts";

export interface StackService {
  readonly status: () => Effect.Effect<StatusReport, StackError>;
  readonly adopt: (
    branch: string,
    parent: string,
  ) => Effect.Effect<StackLink, StackError>;
  readonly links: (
    apply?: boolean,
  ) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly land: (
    branch?: string,
    opts?: {
      readonly apply?: boolean;
      readonly auto?: boolean;
      readonly admin?: boolean;
    },
  ) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly sync: (
    opts?: { readonly dryRun?: boolean },
  ) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly doctor: () => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly repair: (
    apply?: boolean,
  ) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly last: () => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly undo: (
    apply?: boolean,
  ) => Effect.Effect<ReadonlyArray<string>, StackError>;
}

export class Stack extends Context.Service<Stack, StackService>()("@stack/Stack") {
  static readonly layer = Layer.effect(
    Stack,
    Effect.gen(function* () {
      const cfg = yield* StackConfig;
      const git = yield* Git.Service;
      const github = yield* GitHub.Service;
      const progress = yield* Progress.Service;
      const store = yield* Store;

      const draft = (link: StackLink, parent: string, old: PullMeta | null) => {
        if (!old) {
          return {
            title: `stack: ${link.branch}`,
            body: `Restacked ${link.branch} onto ${parent}.`,
            labels: Array<string>(),
          };
        }

        const note = `Restacked from #${old.number} onto \`${parent}\` after parent merge.`;
        const body = old.body.match(/^Stacked on #\d+\.$/m)
          ? old.body.replace(/^Stacked on #\d+\.$/m, note)
          : `${old.body}

${note}`;

        return {
          title: old.title,
          body,
          labels: old.labels.map((item) => item.name),
        };
      };

      const clean = Effect.fn("Stack.clean")(() =>
        Effect.gen(function* () {
          const lines = yield* git.dirty();
          if (lines.length > 0)
            return yield* Effect.fail(new DirtyWorktreeError(lines));
        }),
      );

      const trunk = (name: string) => cfg.trunks.some((item) => item === name);
      const step = (message: string) =>
        progress.emit({ _tag: "Step", message });
      const wait = (message: string) =>
        progress.emit({ _tag: "Wait", message });
      const mergeFailure = (err: unknown) =>
        new StackOperationError(
          `${err instanceof Error ? err.message : String(err)}\n\n` +
            `The PR did not merge immediately. If checks are still running or the PR is waiting on required reviews, use: stack merge --auto\n` +
            `If you intentionally want to bypass GitHub merge requirements with admin privileges, use: stack merge --apply --admin`,
        );
      const missingPull = (err: StackError) =>
        err._tag === "ExecError" &&
        /not found|could not resolve|no pull request/i.test(err.stderr);
      const timestamp = Effect.fn("Stack.timestamp")(function* () {
        const now = yield* DateTime.nowAsDate;
        return now.toISOString().replaceAll(":", "").replaceAll(".", "");
      });

      const githubPullBase = (remote: string) => {
        const https = remote.match(
          /^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/,
        );
        if (https) return `https://github.com/${https[1]}/${https[2]}/pull`;

        const ssh = remote.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
        if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}/pull`;

        return null;
      };

      const status: StackService["status"] = Effect.fn("Stack.status")(() =>
        Effect.gen(function* () {
          const [state, refs, current, remote] = yield* Effect.all([
            store.read(),
            git.refs(),
            git.current(),
            git.remote(),
          ]);
          const base = Option.isSome(remote) ? githubPullBase(remote.value) : null;
          const prUrls = new Map(
            state.links.flatMap((link) =>
              base && link.pr ? [[Number(link.pr), `${base}/${link.pr}`]] : [],
            ),
          );
          return StackGraph.make({
            state,
            refs,
            pulls: [],
            prUrls,
            trunks: cfg.trunks,
            current,
          }).report;
        }),
      );

      const diagram = Effect.fn("Stack.diagram")(function* () {
        const report = yield* status();
        return ["", "Stack", renderDiagram(report)];
      });

      const adopt = Effect.fn("Stack.adopt")((branch: string, parent: string) =>
        Effect.gen(function* () {
          const refs = yield* git.refs();
          if (trunk(branch)) {
            return yield* Effect.fail(
              new StackOperationError(`cannot track trunk branch: ${branch}`),
            );
          }
          if (branch === parent) {
            return yield* Effect.fail(
              new StackOperationError(`${branch} cannot be its own parent`),
            );
          }
          if (!refs.some((ref) => ref.name === branch))
            return yield* Effect.fail(new BranchError(branch));
          if (!refs.some((ref) => ref.name === parent) && !trunk(parent)) {
            return yield* Effect.fail(new BranchError(parent));
          }

          const base = yield* git.base(branch, parent);
          if (Option.isNone(base))
            return yield* Effect.fail(new MergeBaseError(branch, parent));

          const [state, pulls] = yield* Effect.all([
            store.read(),
            github.pulls(),
          ]);
          const nextLinks = new Map(
            state.links
              .filter((link) => link.branch !== branch)
              .map((link) => [String(link.branch), String(link.parent)]),
          );
          if (
            StackGraph.wouldCreateCycle(
              nextLinks,
              new Set(cfg.trunks.map(String)),
              branch,
              parent,
            )
          ) {
            return yield* Effect.fail(
              new StackOperationError(
                `tracking ${branch} onto ${parent} would create a cycle`,
              ),
            );
          }
          const pr = pulls.find((pull) => pull.head === branch)?.number ?? null;
          const next = stackLink({ branch, parent, anchor: base.value, pr });
          const prev =
            state.links.find((link) => link.branch === branch) ?? null;
          if (
            prev &&
            prev.parent === next.parent &&
            prev.anchor === next.anchor &&
            prev.pr === next.pr
          ) {
            return next;
          }
          const links = state.links.filter((link) => link.branch !== branch);

          yield* store.write(
            stackState(
              [...links, next].sort((a, b) => a.branch.localeCompare(b.branch)),
            ),
          );

          return next;
        }),
      );

      const inferApplyPlan = Effect.fn("Stack.inferApplyPlan")(
        (
          state: ReturnType<typeof stackState>,
          refs: ReadonlyArray<BranchRef>,
          pulls: ReadonlyArray<PullRef>,
        ) =>
          Effect.gen(function* () {
            const refNames = new Set(refs.map((ref) => String(ref.name)));
            const explicit = new Map(
              state.links.map((link) => [String(link.branch), String(link.parent)]),
            );
            const trunks = new Set(cfg.trunks.map(String));
            const childBases = new Set(
              pulls
                .map((pull) => String(pull.base))
                .filter((base) => !trunks.has(base)),
            );
            const planned = new Map(explicit);
            const actions: Array<StackLink> = [];

            for (const pull of pulls) {
              const branch = String(pull.head);
              const parent = String(pull.base);
              if (explicit.has(branch)) continue;
              if (!refNames.has(branch)) continue;
              if (!refNames.has(parent) && !trunks.has(parent)) continue;
              if (branch === parent) continue;
              if (trunks.has(parent) && !childBases.has(branch)) continue;
              if (StackGraph.wouldCreateCycle(planned, trunks, branch, parent)) {
                continue;
              }

              const anchor = yield* git.base(branch, parent);
              if (Option.isNone(anchor)) continue;

              const action = stackLink({
                branch,
                parent,
                anchor: anchor.value,
                pr: Number(pull.number),
              });
              actions.push(action);
              planned.set(branch, parent);
            }

            return actions;
          }),
      );

      const reconcileApplyState = Effect.fn("Stack.reconcileApplyState")(
        (
          state: ReturnType<typeof stackState>,
          refs: ReadonlyArray<BranchRef>,
          pulls: ReadonlyArray<PullRef>,
          mode: StackResult.Mode,
        ) =>
          Effect.gen(function* () {
            const trunks = new Set(cfg.trunks.map(String));
            const refNames = new Set(refs.map((ref) => String(ref.name)));
            const pullsByBranch = new Map(
              pulls.map((pull) => [String(pull.head), pull]),
            );
            const openBases = new Set(pulls.map((pull) => String(pull.base)));
            const actions: Array<StackResult.StackResultItem> = [];
            const kept = new Array<StackLink>();
            const replayAnchors = new Map<string, string>();

            for (const link of state.links) {
              const branch = String(link.branch);
              const pull = pullsByBranch.get(branch) ?? null;
              if (!pull && !openBases.has(branch)) {
                actions.push({
                  _tag: "RemoveLink",
                  mode,
                  branch,
                  reason: "no open PR and no open child PR depends on it",
                });
                continue;
              }
              kept.push(link);
            }

            const plannedParents = new Map(
              kept.map((link) => [String(link.branch), String(link.parent)]),
            );
            const reconciled = new Array<StackLink>();
            for (const link of kept) {
              const branch = String(link.branch);
              const pull = pullsByBranch.get(branch) ?? null;
              const parent = pull ? String(pull.base) : String(link.parent);
              const parentValid = refNames.has(parent) || trunks.has(parent);
              if (
                pull &&
                parent !== link.parent &&
                parentValid &&
                branch !== parent &&
                !StackGraph.wouldCreateCycle(
                  new Map([...plannedParents].filter(([name]) => name !== branch)),
                  trunks,
                  branch,
                  parent,
                )
              ) {
                const anchor = yield* git.base(branch, parent);
                if (Option.isSome(anchor)) {
                  const oldParent = String(link.parent);
                  const oldParentTracked = plannedParents.has(oldParent) || trunks.has(oldParent);
                  if (!oldParentTracked) replayAnchors.set(branch, String(link.anchor));
                  const next = stackLink({
                    branch,
                    parent,
                    anchor: oldParentTracked ? anchor.value : link.anchor,
                    pr: Number(pull.number),
                  });
                  actions.push({
                    _tag: "UpdateLink",
                    mode,
                    branch,
                    from: String(link.parent),
                    to: parent,
                    anchor: anchor.value,
                  });
                  plannedParents.set(branch, parent);
                  reconciled.push(next);
                  continue;
                }
              }
              reconciled.push(link);
            }

            return {
              state: stackState(
                reconciled.sort((a, b) => a.branch.localeCompare(b.branch)),
              ),
              actions,
              replayAnchors,
            };
          }),
      );

      const stateWithPlan = (
        state: ReturnType<typeof stackState>,
        plan: ReadonlyArray<StackLink>,
      ) => {
        const planned = new Map(
          state.links.map((link) => [String(link.branch), link]),
        );
        for (const action of plan) {
          planned.set(
            String(action.branch),
            action,
          );
        }

        return stackState(
          [...planned.values()].sort((a, b) => a.branch.localeCompare(b.branch)),
        );
      };

      const repairStack = Effect.fn("Stack.repairStack")(
        (
          state: ReturnType<typeof stackState>,
          refs: ReadonlyArray<BranchRef>,
          pulls: ReadonlyArray<PullRef>,
          opts: {
            readonly apply: boolean;
            readonly saved?: Map<string, string>;
            readonly journalState?: ReturnType<typeof stackState>;
            readonly initialActions?: ReadonlyArray<StackResult.StackResultItem>;
            readonly replayAnchors?: ReadonlyMap<string, string>;
          },
        ) =>
          Effect.gen(function* () {
            const apply = opts.apply;
            const saved = opts.saved ?? new Map<string, string>();
            const replayAnchors = opts.replayAnchors ?? new Map<string, string>();
            const journalState = opts.journalState ?? state;
            const initialActions = opts.initialActions ?? [];
            const mode: StackResult.Mode = apply ? "apply" : "dry-run";
            const stamp = yield* timestamp();
            const actions: Array<StackResult.StackResultItem> =
              Array.from(initialActions);
            const links = new Map(
              state.links.map((link) => [String(link.branch), link]),
            );
            const graph = StackGraph.make({
              state,
              refs,
              pulls,
              trunks: cfg.trunks,
              current: "",
            });

            const live = new Map(refs.map((ref) => [String(ref.name), ref]));
            const heads = new Map(
              refs.map((ref) => [String(ref.name), ref.head]),
            );
            const prs = new Map(pulls.map((pull) => [String(pull.head), pull]));
            const tips = new Map<string, string | null>();
            const prior = new Map<string, string>();
            const moved = new Set<string>();
            const entries: Array<UndoEntry> = [];
            const next: Array<StackLink> = [];
            let journal = apply && initialActions.length > 0;

            for (const link of state.links) {
              const match = refs
                .map((ref) => ref.name)
                .filter(
                  (name) =>
                    (name.startsWith("backup/landed-") ||
                      name.startsWith("backup/stack-sync-")) &&
                    name.endsWith(`-${link.branch}`),
                )
                .sort()
                .at(-1);

              if (match) prior.set(String(link.branch), match);
            }

            const checkpoint = Effect.fn("Stack.repairStack.checkpoint")(() =>
              apply
                ? store.writeUndo(
                    undoState(
                      stamp,
                      journalState,
                      entries,
                      StackResult.renderAll(actions),
                    ),
                  )
                : Effect.void,
            );

            if (journal) yield* checkpoint();

            const resolve = (
              name: string,
              seen = new Set<string>(),
            ): string | null => {
              let parent = name;
              for (;;) {
                if (live.has(parent) || trunk(parent)) return parent;
                if (seen.has(parent)) return null;
                seen.add(parent);
                const link = links.get(parent);
                if (!link) return null;
                parent = String(link.parent);
              }
            };

            for (const link of [...state.links].sort(
              (a, b) =>
                graph.rank(String(a.branch)) - graph.rank(String(b.branch)),
            )) {
              if (!live.has(String(link.branch))) {
                if (!prs.has(String(link.branch))) continue;
                next.push(link);
                continue;
              }

              const parent = resolve(String(link.parent));
              if (!parent) {
                next.push(link);
                actions.push(
                  StackResult.text(
                    `skip ${link.branch}: cannot resolve parent ${link.parent}`,
                  ),
                );
                continue;
              }

              if (parent !== link.parent)
                actions.push(
                  {
                    _tag: "Reparent",
                    mode,
                    branch: String(link.branch),
                    from: String(link.parent),
                    to: parent,
                  },
                );

              const pr = prs.get(String(link.branch)) ?? null;
              const onto = trunk(parent) ? `origin/${parent}` : parent;
              const from =
                saved.get(String(link.parent)) ??
                (live.has(String(link.parent))
                  ? String(link.parent)
                  : (prior.get(String(link.parent)) ?? String(link.parent)));
              if (!tips.has(onto)) {
                const tip = yield* git.head(onto);
                tips.set(onto, Option.isSome(tip) ? tip.value : null);
              }
              const want = tips.get(onto) ?? heads.get(parent) ?? null;
              const have = yield* git.base(link.branch, onto);
              const drift =
                replayAnchors.has(String(link.branch)) ||
                parent !== link.parent ||
                moved.has(parent) ||
                (want && (Option.isNone(have) || have.value !== want));
              const base = pr?.base ?? null;
              let backup: string | null = null;
              let created: number | null = null;
              let num = pr?.number ?? link.pr;

              if (drift) {
                const anchor = replayAnchors.get(String(link.branch));
                const baseRef = anchor ? Option.some(anchor) : yield* git.base(link.branch, from);
                const commitsToReplay = Option.isSome(baseRef)
                  ? yield* Effect.gen(function* () {
                      const commits = yield* git.commits(baseRef.value, link.branch);
                      return yield* git.novel(onto, link.branch, commits);
                    })
                  : Array<string>();
                backup = `backup/stack-sync-${stamp}-${link.branch}`;
                const rebase = {
                  branch: String(link.branch),
                  parent,
                  onto,
                  backup,
                  commits: commitsToReplay,
                } satisfies RepairPlan.RebaseBranchPlan;
                actions.push(...RepairPlan.rebaseBranch(rebase, mode));

                if (apply) {
                  entries.push(
                    undoEntry({
                      branch: link.branch,
                      backup,
                      pr: pr?.number ?? link.pr ?? null,
                      base,
                      created: null,
                    }),
                  );
                  journal = true;
                  yield* checkpoint();
                  yield* step(`backup ${rebase.branch} -> ${rebase.backup}`);
                  yield* git.backup(rebase.branch, rebase.backup);
                  saved.set(rebase.branch, rebase.backup);
                  yield* step(`rebase ${rebase.branch} onto ${rebase.parent}`);
                  yield* git.replay(rebase.branch, rebase.onto, rebase.commits);
                  yield* step(`push ${rebase.branch}`);
                  yield* git.push(rebase.branch);
                  const tip = yield* git.head(link.branch);
                  const head = Option.isSome(tip)
                    ? tip.value
                    : (want ?? heads.get(link.branch) ?? link.anchor);
                  heads.set(link.branch, head);
                  live.set(link.branch, branchRef({ name: link.branch, head }));
                } else {
                  heads.set(link.branch, `planned/${link.branch}`);
                }

                moved.add(link.branch);
              }

              const now = prs.get(link.branch) ?? null;
              if (now && now.base !== parent) {
                const retarget = {
                  pr: Number(now.number),
                  base: parent,
                } satisfies RepairPlan.RetargetPullPlan;
                actions.push(RepairPlan.retargetPull(retarget, mode));
                if (apply) {
                  yield* step(`retarget #${now.number} to ${parent}`);
                  yield* github.edit(now.number, parent);
                }
                prs.set(
                  link.branch,
                  pullRef({
                    number: now.number,
                    head: now.head,
                    base: parent,
                    url: now.url,
                    draft: now.draft,
                  }),
                );
              }

              const open = prs.get(link.branch) ?? null;
              if (!open) {
                if (apply) {
                  const prev = link.pr
                    ? yield* github
                        .pull(link.pr)
                        .pipe(
                          Effect.catchIf(missingPull, () =>
                            Effect.succeed<PullMeta | null>(null),
                          ),
                        )
                    : null;
                  const nextPr = draft(link, parent, prev);
                  yield* step(`create PR for ${link.branch} -> ${parent}`);
                  const made = yield* github.create(
                    link.branch,
                    parent,
                    nextPr.title,
                    nextPr.body,
                    nextPr.labels,
                  );
                  created = made.number;
                  num = made.number;
                  prs.set(link.branch, made);
                  const createdPull = {
                    branch: String(link.branch),
                    base: parent,
                    pr: Number(made.number),
                  } satisfies RepairPlan.CreatePullPlan;
                  actions.push(RepairPlan.createPull(createdPull, mode));
                  const i = entries.findIndex(
                    (item) => item.branch === link.branch,
                  );
                  if (i >= 0) {
                    entries[i] = undoEntry({
                      branch: entries[i]!.branch,
                      backup: entries[i]!.backup,
                      pr: entries[i]!.pr,
                      base: entries[i]!.base,
                      created: made.number,
                    });
                  } else {
                    entries.push(
                      undoEntry({
                        branch: link.branch,
                        backup: null,
                        pr: now?.number ?? link.pr ?? null,
                        base,
                        created: made.number,
                      }),
                    );
                  }
                  journal = true;
                  yield* checkpoint();
                } else {
                  actions.push(RepairPlan.createPull({
                    branch: String(link.branch),
                    base: parent,
                    pr: null,
                  }, mode));
                }
              } else {
                num = open.number;
              }

              if (
                apply &&
                now &&
                now.base !== parent &&
                !entries.some((item) => item.branch === link.branch)
              ) {
                entries.push(
                  undoEntry({
                    branch: link.branch,
                    backup: null,
                    pr: now.number,
                    base,
                    created,
                  }),
                );
                journal = true;
                yield* checkpoint();
              }

              next.push(
                stackLink({
                  branch: String(link.branch),
                  parent,
                  anchor: heads.get(parent) ?? want ?? link.anchor,
                  pr: num ?? null,
                }),
              );
            }

            if (apply && actions.length > 0) {
              yield* store.write(
                stackState(
                  next.sort((a, b) => a.branch.localeCompare(b.branch)),
                ),
              );
            }

            if (apply && !journal) {
              yield* store.clearUndo();
            }

            return actions.length > 0
              ? StackResult.renderAll(actions)
              : [apply ? "stack is current" : "would make no changes"];
          }),
      );

      const repair: StackService["repair"] = Effect.fn("Stack.repair")((apply = false) =>
        Effect.gen(function* () {
          const current = yield* git.current();
          if (apply) yield* clean();
          yield* git.fetch();
          const [state, refs, pulls] = yield* Effect.all([
            store.read(),
            git.refs(),
            github.pulls(),
          ]);
          const steps = yield* repairStack(state, refs, pulls, { apply });
          const notes = apply ? yield* links(true) : Array<string>();
          if (apply) yield* git.switch(current);
          const view = apply ? yield* diagram() : Array<string>();
          return [...steps, ...notes, ...view];
        }),
      );

      const sync: StackService["sync"] = Effect.fn("Stack.sync")((opts) =>
        Effect.gen(function* () {
          const dryRun = opts?.dryRun ?? false;
          const syncStep = (message: string) =>
            dryRun ? Effect.void : step(message);
          const current = yield* git.current();
          return yield* Effect.gen(function* () {
            if (!dryRun) yield* clean();
            yield* syncStep("fetch origin --prune");
            yield* git.fetch();
            yield* syncStep("inspect open PRs and local refs");
            const [state, refs, pulls] = yield* Effect.all([
              store.read(),
              git.refs(),
              github.pulls(),
            ]);
            const reconciled = yield* reconcileApplyState(
              state,
              refs,
              pulls,
              dryRun ? "dry-run" : "apply",
            );
            yield* syncStep("reconcile local stack metadata");
            const plan = yield* inferApplyPlan(reconciled.state, refs, pulls);
            yield* syncStep("infer PR-base stack links");
            const planned = stateWithPlan(reconciled.state, plan);
            yield* syncStep("repair stack branches and PRs");
            const steps = yield* repairStack(
              planned,
              refs,
              pulls,
              {
                apply: !dryRun,
                journalState: state,
                replayAnchors: reconciled.replayAnchors,
                initialActions: [
                  ...reconciled.actions,
                  ...plan.map(StackResult.track),
                ],
              },
            );
            yield* syncStep("refresh stack blocks");
            const notes = yield* linksFor(planned, !dryRun);
            const view = dryRun ? Array<string>() : yield* diagram();
            return [...steps, ...notes, ...view];
          }).pipe(
            Effect.ensuring(
              dryRun
                ? Effect.void
                : step(`restore branch ${current}`).pipe(
                    Effect.flatMap(() => git.switch(current)),
                    Effect.catchTag("ExecError", () => Effect.void),
                  ),
            ),
          );
        }),
      );

      const linksFor = Effect.fn("Stack.linksFor")(
        (
          stateOverride: ReturnType<typeof stackState> | null,
          apply = false,
          completed = new Set<string>(),
        ) =>
          Effect.gen(function* () {
            const [state, pulls] = yield* Effect.all([
              stateOverride ? Effect.succeed(stateOverride) : store.read(),
              github.pulls(),
            ]);
            const info = yield* Effect.all(
              state.links
                .map((link) => link.pr)
                .filter((pr): pr is NonNullable<typeof pr> => pr !== null)
                .map((pr) =>
                  github
                    .pull(pr)
                    .pipe(Effect.catchIf(missingPull, () => Effect.succeed(null))),
                ),
              { concurrency: cfg.githubConcurrency },
            );
            const metas = new Map(
              info
                .filter((item): item is PullMeta => item !== null)
                .map((item) => [String(item.head), item]),
            );
            const metasByNumber = new Map(
              info
                .filter((item): item is PullMeta => item !== null)
                .map((item) => [Number(item.number), item]),
            );
            const prs = new Map(pulls.map((pull) => [String(pull.head), pull]));
            const graph = StackGraph.make({
              state,
              refs: [],
              pulls,
              trunks: cfg.trunks,
              current: "",
            });
            const jobs = state.links
              .map((link) => prs.get(String(link.branch)))
              .filter((pull): pull is PullRef => Boolean(pull))
              .map((pull) =>
                Effect.gen(function* () {
                  const meta =
                    metasByNumber.get(Number(pull.number)) ??
                    (yield* github.pull(pull.number));
                  const next = StackBlock.splice(
                    meta.body,
                    StackBlock.render({
                      pulls,
                      metas,
                      chain: graph.explicitChainFor(String(pull.head)),
                      completed,
                      branch: String(pull.head),
                      previous: meta.body,
                    }),
                  );
                  if (next === meta.body) return null;
                  if (apply) {
                    yield* step(`update #${pull.number} stack block`);
                    yield* github.body(pull.number, next);
                  }
                  return StackResult.render({
                    _tag: "UpdateStackLinks",
                    mode: apply ? "apply" : "dry-run",
                    pr: Number(pull.number),
                  });
                }),
              );

            const items = yield* Effect.all(jobs, {
              concurrency: cfg.githubConcurrency,
            });
            const actions = items.filter((item): item is string =>
              Boolean(item),
            );
            return actions.length > 0
              ? actions
              : [
                  apply
                    ? "stack links are current"
                    : "would make no description changes",
                ];
          }),
      );

      const links: StackService["links"] = Effect.fn("Stack.links")(
        (apply = false) => linksFor(null, apply),
      );

      const last = Effect.fn("Stack.last")(() =>
        Effect.gen(function* () {
          const run = yield* store.readUndo();
          if (!run) return ["no applied mutation recorded"];
          const items =
            run.actions.length > 0 ? run.actions : ["no actions recorded"];
          return [
            `last mutation: ${run.at}`,
            ...items,
            "undo with: stack undo --apply",
          ];
        }),
      );

      const doctor: StackService["doctor"] = Effect.fn("Stack.doctor")(() =>
        Effect.gen(function* () {
          const describe = (err: unknown) =>
            err instanceof Error ? err.message : String(err);
          const current = yield* git.current().pipe(
            Effect.match({
              onFailure: (err) => `fail current branch: ${describe(err)}`,
              onSuccess: (branch) =>
                branch ? `ok current branch: ${branch}` : "warn detached HEAD",
            }),
          );
          const clean = yield* git.dirty().pipe(
            Effect.match({
              onFailure: (err) => `fail worktree status: ${describe(err)}`,
              onSuccess: (lines) =>
                lines.length === 0
                  ? "ok worktree clean"
                  : `warn worktree dirty: ${lines.length} changed file(s)`,
            }),
          );
          const refs = yield* git.refs().pipe(
            Effect.match({
              onFailure: (err) => ({ ok: false as const, err }),
              onSuccess: (refs) => ({ ok: true as const, refs }),
            }),
          );
          const trunks = refs.ok
            ? cfg.trunks.map((trunk) =>
                refs.refs.some((ref) => ref.name === trunk)
                  ? `ok trunk branch: ${trunk}`
                  : `warn missing local trunk branch: ${trunk}`,
              )
            : [`fail branch refs: ${describe(refs.err)}`];
          const pulls = yield* github.pulls().pipe(
            Effect.match({
              onFailure: (err) => `fail open PRs: ${describe(err)}`,
              onSuccess: (pulls) => `ok open PRs visible: ${pulls.length}`,
            }),
          );
          const state = yield* store.read().pipe(
            Effect.match({
              onFailure: (err) => `fail stack metadata: ${describe(err)}`,
              onSuccess: (state) => `ok stack metadata: ${state.links.length} link(s)`,
            }),
          );
          const undo = yield* store.readUndo().pipe(
            Effect.match({
              onFailure: (err) => `fail undo journal: ${describe(err)}`,
              onSuccess: (undo) =>
                undo ? `info undo journal: ${undo.at}` : "ok undo journal: none",
            }),
          );

          return [current, clean, ...trunks, pulls, state, undo];
        }),
      );

      const land = Effect.fn("Stack.land")(
        (
          branch?: string,
          opts?: {
            readonly apply?: boolean;
            readonly auto?: boolean;
            readonly admin?: boolean;
          },
        ) =>
          Effect.gen(function* () {
            const apply = opts?.apply ?? false;
            const auto = opts?.auto ?? false;
            const admin = opts?.admin ?? false;
            if (apply && auto) {
              return yield* Effect.fail(
                new StackOperationError("use either --apply or --auto, not both"),
              );
            }
            if (admin && !apply) {
              return yield* Effect.fail(
                new StackOperationError("use --admin only with --apply"),
              );
            }
            const active = apply || auto;

            if (active) yield* clean();
            const [state, refs, pulls, current] = yield* Effect.all([
              store.read(),
              git.refs(),
              github.pulls(),
              git.current(),
            ]);
            const graph = StackGraph.make({
              state,
              refs,
              pulls,
              trunks: cfg.trunks,
              current,
            });
            const inferred = graph.rootOf(current);
            const roots = state.links
              .filter((item) => trunk(String(item.parent)))
              .map((item) => String(item.branch))
              .sort((a, b) => a.localeCompare(b));
            const target =
              branch ??
              (state.links.some((item) => item.branch === inferred)
                ? inferred
                : roots.length === 1
                  ? roots[0]!
                  : inferred);
            if (!branch && !state.links.some((item) => item.branch === target)) {
              if (roots.length > 1) {
                return yield* Effect.fail(
                  new StackOperationError(
                    `multiple stack roots found: ${roots.join(", ")}. run: stack merge <branch>`,
                  ),
                );
              }
            }
            const link =
              state.links.find((item) => item.branch === target) ?? null;
            if (!link) {
              const pr = pulls.find((item) => item.head === target) ?? null;
              if (!refs.some((item) => item.name === target) && !pr)
                return yield* Effect.fail(new BranchError(target));
              const parent = pr?.base ?? String(cfg.trunks[0] ?? "dev");
              return yield* Effect.fail(
                new StackOperationError(
                  `${target} is not tracked in stack state. status can infer it, but merge needs an explicit link. run: stack track ${target} --onto ${parent}`,
                ),
              );
            }
            if (!trunk(link.parent)) {
              return yield* Effect.fail(
                new StackOperationError(
                  `${target} is not the oldest branch in its stack`,
                ),
              );
            }

            const pr = pulls.find((item) => item.head === target) ?? null;
            if (!pr) {
              return yield* Effect.fail(
                new StackOperationError(`no open PR found for ${target}`),
              );
            }

            const root = cfg.trunks[0] ?? branchName("dev");
            const stamp = yield* timestamp();
            const name = `backup/landed-${stamp}-${target}`;
            const hasLocalTarget = refs.some((item) => item.name === target);
            const next =
              state.links.find((item) => item.parent === target)?.branch ??
              null;
            const landed = new Set([`#${pr.number}`, String(target)]);
            const preRetargets = state.links
              .filter((item) => item.parent === target)
              .flatMap((child) => {
                const childPr = pulls.find((item) => item.head === child.branch);
                return childPr && childPr.base !== link.parent
                  ? [
                      {
                        pr: Number(childPr.number),
                        branch: String(child.branch),
                        base: String(link.parent),
                      },
                    ]
                  : [];
              });
            const retargetChildren = Effect.forEach(
              preRetargets,
              (item) =>
                Effect.gen(function* () {
                  yield* step(
                    `retarget #${item.pr} (${item.branch}) to ${item.base} before merge`,
                  );
                  yield* github.edit(item.pr, item.base);
                }),
              { discard: true },
            );
            const plannedPulls = pulls.map((item) => {
              const retarget = preRetargets.find((next) => next.pr === item.number);
              return retarget
                ? pullRef({
                    number: item.number,
                    head: item.head,
                    base: retarget.base,
                    url: item.url,
                    draft: item.draft,
                    checks: item.checks,
                  })
                : item;
            });
            const actions = [
              ...(current === target
                ? [`${active ? "" : "would "}switch to ${root}`]
                : []),
              ...(hasLocalTarget
                ? [`${active ? "" : "would "}backup ${target} -> ${name}`]
                : []),
              ...preRetargets.map(
                (item) =>
                  `${active ? "" : "would "}retarget #${item.pr} (${item.branch}) to ${item.base} before merge`,
              ),
              auto
                ? `enable auto-merge #${pr.number} (${target})`
                : `${apply ? "" : "would "}${admin ? "admin " : ""}merge #${pr.number} (${target})`,
              ...(auto ? [`wait for #${pr.number} to merge`] : []),
            ];

            const repairAfterMerge = Effect.fn("Stack.land.repairAfterMerge")(() =>
              Effect.gen(function* () {
                yield* git.fetch();
                const [nextState, nextRefs, nextPulls] = yield* Effect.all([
                  store.read(),
                  git.refs(),
                  github.pulls(),
                ]);
                const steps = yield* repairStack(
                  nextState,
                  nextRefs.filter((item) => item.name !== target),
                  nextPulls.filter((item) => item.head !== target),
                  { apply: true, saved: new Map([[target, name]]) },
                );
                const notes = yield* linksFor(null, true, landed);
                if (current !== target) yield* git.switch(current);
                const tail = next ? `next root: ${next}` : "next root: none";
                const view = yield* diagram();
                return [...actions, ...steps, ...notes, tail, ...view];
              }),
            );

            if (auto) {
              if (current === target) {
                yield* step(`switch to ${root}`);
                yield* git.switch(root);
              }
              if (hasLocalTarget) {
                yield* step(`backup ${target} -> ${name}`);
                yield* git.backup(target, name);
              }
              yield* retargetChildren;
              yield* step(`enable auto-merge #${pr.number} (${target})`);
              yield* github.auto(pr.number);
              yield* wait(`waiting for #${pr.number} to merge`);
              yield* github.wait(pr.number);
              if (hasLocalTarget) {
                yield* step(`drop local ${target}`);
                yield* git.drop(target);
              }
              return yield* repairAfterMerge();
            }

            if (apply) {
              if (current === target) {
                yield* step(`switch to ${root}`);
                yield* git.switch(root);
              }
              if (hasLocalTarget) {
                yield* step(`backup ${target} -> ${name}`);
                yield* git.backup(target, name);
              }
              yield* retargetChildren;
              yield* step(`${admin ? "admin " : ""}merge #${pr.number} (${target})`);
              yield* github.merge(pr.number, { admin }).pipe(
                Effect.mapError(mergeFailure),
              );
              if (hasLocalTarget) {
                yield* step(`drop local ${target}`);
                yield* git.drop(target);
              }
              return yield* repairAfterMerge();
            }

            const steps = yield* repairStack(
              state,
              refs.filter((item) => item.name !== target),
              plannedPulls.filter((item) => item.head !== target),
              { apply: false },
            );
            const tail = next ? `next root: ${next}` : "next root: none";
            return [...actions, ...steps, tail];
          }),
      );

      const undo = Effect.fn("Stack.undo")((apply = false) =>
        Effect.gen(function* () {
          const current = yield* git.current();
          if (apply) yield* clean();
          const run = yield* store.readUndo();
          if (!run) return [apply ? "nothing to undo" : "would do nothing"];

          const mode = apply ? "" : "would ";
          const actions: Array<string> = [];
          const trunk = cfg.trunks[0] ?? branchName("dev");
          const restore = new Set(
            run.entries.flatMap((item) =>
              item.backup ? [String(item.branch)] : [],
            ),
          );

          if (restore.has(current)) {
            actions.push(`${mode}switch to ${trunk}`);
            if (apply) yield* git.switch(trunk);
          }

          for (const item of run.entries) {
            if (!item.backup) continue;
            actions.push(`${mode}restore ${item.branch} from ${item.backup}`);
            actions.push(`${mode}push ${item.branch}`);
            if (apply) {
              yield* git.restore(item.branch, item.backup);
              yield* git.push(item.branch);
            }
          }

          for (const item of run.entries) {
            if (item.created) {
              actions.push(`${mode}close #${item.created}`);
              if (apply) yield* github.close(item.created);
            }
            if (item.pr && item.base) {
              actions.push(`${mode}retarget #${item.pr} to ${item.base}`);
              if (apply) yield* github.edit(item.pr, item.base);
            }
          }

          actions.push(`${mode}restore stack metadata`);

          if (apply) {
            yield* store.write(run.state);
            yield* store.clearUndo();
            yield* git.switch(current);
          }

          return actions;
        }),
      );

      return Stack.of({ status, adopt, links, land, sync, doctor, repair, last, undo });
    }),
  );
}
