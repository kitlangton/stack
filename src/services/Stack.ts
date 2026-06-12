import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  BranchError,
  BranchRef,
  branchName,
  branchRef,
  DirtyWorktreeError,
  ExecError,
  MergeBaseError,
  PullMeta,
  pullRef,
  PullRef,
  stackLink,
  StackLink,
  StackOperationError,
  type StackError,
  stackState,
  StackState,
  StatusReport,
  UndoEntry,
  undoEntry,
  undoState,
} from "../domain/model.ts";
import { renderDiagram } from "../format.ts";
import { RepairExecution } from "../repairExecution.ts";
import * as RepairPlan from "../repairPlan.ts";
import * as StackGraph from "../stackGraph.ts";
import * as StackBlock from "../stackBlock.ts";
import * as StackResult from "../stackResult.ts";
import * as Proc from "../platform/proc.ts";
import { StackConfig } from "./Config.ts";
import { Git } from "./Git.ts";
import { CodeHost } from "./CodeHost.ts";
import * as CodeHostAzureDevOps from "./code-host/AzureDevOps.ts";
import * as Progress from "./Progress.ts";
import { Store } from "./Store.ts";

export interface StackService {
  readonly status: () => Effect.Effect<StatusReport, StackError>;
  readonly adopt: (branch: string, parent: string) => Effect.Effect<StackLink, StackError>;
  readonly links: (apply?: boolean) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly land: (
    branch?: string,
    opts?: {
      readonly apply?: boolean;
      readonly auto?: boolean;
      readonly admin?: boolean;
      readonly through?: string;
    },
  ) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly sync: (opts?: {
    readonly apply?: boolean;
    readonly branch?: string;
    readonly continueOnFailure?: boolean;
  }) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly doctor: () => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly last: () => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly undo: (apply?: boolean) => Effect.Effect<ReadonlyArray<string>, StackError>;
}

export class Stack extends Context.Service<Stack, StackService>()("@stack/Stack") {
  static readonly layer = Layer.effect(
    Stack,
    Effect.gen(function* () {
      const cfg = yield* StackConfig;
      const git = yield* Git.Service;
      const codeHost = yield* CodeHost.Service;
      const progress = yield* Progress.Service;
      const store = yield* Store;

      const reference = (number: number) => codeHost.reference(number);
      const requestLabel = codeHost.requestLabel;

      const draft = (link: StackLink, parent: string, old: PullMeta | null) => {
        if (!old) {
          return {
            title: `stack: ${link.branch}`,
            body: `Restacked ${link.branch} onto ${parent}.`,
            labels: Array<string>(),
          };
        }

        const note = `Restacked from ${reference(Number(old.number))} onto \`${parent}\` after parent merge.`;
        const body = old.body.match(/^Stacked on [#!]\d+\.$/m)
          ? old.body.replace(/^Stacked on [#!]\d+\.$/m, note)
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
          if (lines.length > 0) return yield* Effect.fail(new DirtyWorktreeError(lines));
        }),
      );

      const trunk = (name: string) => cfg.trunks.some((item) => item === name);
      const step = (message: string) => progress.emit({ _tag: "Step", message });
      const wait = (message: string) => progress.emit({ _tag: "Wait", message });
      const mergeFailure = (err: unknown) =>
        new StackOperationError(
          `${err instanceof Error ? err.message : String(err)}\n\n` +
            `The change did not merge immediately. If checks are still running or the change is waiting on required reviews, use: stack merge --auto\n` +
            `If you intentionally want to bypass merge requirements with admin privileges (GitHub only), use: stack merge --apply --admin`,
        );
      const replayFailure = (
        rebase: RepairPlan.RebaseBranchPlan,
        err: StackError,
        state: ReturnType<typeof stackState>,
        pulls: ReadonlyArray<PullRef>,
        actions: ReadonlyArray<StackResult.StackResultItem>,
      ) =>
        new StackOperationError(
          [
            ...renderSyncTree({
              title: "Sync stopped",
              state,
              pulls,
              actions,
              mode: "apply",
              failed: { branch: rebase.branch, parent: rebase.parent },
            }),
            "",
            "Failed:",
            `  ${rebase.branch} could not be replayed onto ${rebase.parent}`,
            "",
            "Cleaned up:",
            `  backup created: ${rebase.backup}`,
            "  the failed cherry-pick was aborted",
            "  the original branch was restored",
            "  the temporary replay branch was deleted",
            "  the undo journal was saved",
            "",
            "Next:",
            `  repair ${rebase.branch} from ${rebase.backup}, push it, then run: stack sync --apply`,
            "  or restore the pre-sync state with: stack undo --apply",
            "",
            "Git error:",
            err instanceof Error ? `  ${err.message}` : `  ${String(err)}`,
            err._tag === "ExecError" && err.stderr ? `  ${err.stderr}` : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        );
      const timestamp = Effect.fn("Stack.timestamp")(function* () {
        const now = yield* DateTime.nowAsDate;
        return now.toISOString().replaceAll(":", "").replaceAll(".", "");
      });
      const sameState = Schema.toEquivalence(StackState);

      const renderSyncTree = (opts: {
        readonly title: string;
        readonly state: ReturnType<typeof stackState>;
        readonly pulls: ReadonlyArray<PullRef>;
        readonly actions: ReadonlyArray<StackResult.StackResultItem>;
        readonly mode: StackResult.Mode;
        readonly failed?: { readonly branch: string; readonly parent: string };
      }) => {
        const trunkNames = cfg.trunks.map(String);
        const pulls = new Map(opts.pulls.map((pull) => [String(pull.head), pull]));
        const children = new Map<string, Array<string>>();
        const links = new Map(opts.state.links.map((link) => [String(link.branch), link]));
        for (const link of opts.state.links) {
          const parent = String(link.parent);
          const list = children.get(parent) ?? [];
          list.push(String(link.branch));
          children.set(parent, list);
        }
        for (const list of children.values()) list.sort((a, b) => a.localeCompare(b));

        const rebased = new Map<string, string>();
        const pushed = new Map<string, ReadonlyArray<string>>();
        const created = new Map<
          string,
          StackResult.StackResultItem & { readonly _tag: "CreatePull" }
        >();
        const updatedPrs = new Set<number>();
        let backups = 0;
        for (const action of opts.actions) {
          if (action._tag === "Rebase") rebased.set(action.branch, action.parent);
          if (action._tag === "Push") pushed.set(action.branch, action.remotes);
          if (action._tag === "CreatePull") created.set(action.branch, action);
          if (action._tag === "Backup") backups += 1;
          if (action._tag === "UpdateStackLinks") updatedPrs.add(action.pr);
        }

        const failedBranch = opts.failed?.branch ?? null;
        const blocked = new Set<string>();
        const collectBlocked = (branch: string) => {
          for (const child of children.get(branch) ?? []) {
            blocked.add(child);
            collectBlocked(child);
          }
        };
        if (failedBranch) collectBlocked(failedBranch);

        const label = (branch: string) => {
          const link = links.get(branch);
          const pull = pulls.get(branch);
          const creating = created.get(branch) ?? null;
          const pr = pull?.number ?? creating?.pr ?? (creating ? null : (link?.pr ?? null));
          return `${branch}${pr ? ` ${reference(Number(pr))}` : ""}`;
        };
        const status = (branch: string) => {
          if (failedBranch === branch) {
            return {
              icon: "✕",
              note: `failed to rebase onto ${opts.failed?.parent}`,
            };
          }
          if (blocked.has(branch)) return { icon: "◌", note: "not changed" };
          const parent = rebased.get(branch);
          if (parent) {
            return opts.mode === "dry-run"
              ? { icon: "◌", note: `would rebase onto ${parent}` }
              : {
                  icon: pushed.has(branch) ? "✓" : "◌",
                  note: `rebased onto ${parent}`,
                };
          }
          const remotes = pushed.get(branch);
          if (remotes) {
            const remoteText =
              remotes.length === 1 && remotes[0] === "origin" ? "" : ` to ${remotes.join(", ")}`;
            return opts.mode === "dry-run"
              ? { icon: "◌", note: `would push${remoteText}` }
              : { icon: "✓", note: `pushed${remoteText}` };
          }
          if (created.has(branch)) {
            return opts.mode === "dry-run"
              ? { icon: "◌", note: `would create ${requestLabel}` }
              : { icon: "✓", note: `created ${requestLabel}` };
          }
          return { icon: "●", note: "" };
        };

        const trunkName =
          trunkNames.find((name) => (children.get(name) ?? []).length > 0) ??
          trunkNames[0] ??
          "main";
        const lines = [opts.title, "", `● ${trunkName}`];
        const walk = (branch: string, prefix: string, last: boolean) => {
          const item = status(branch);
          lines.push(
            `${prefix}${last ? "└─" : "├─"} ${item.icon} ${label(branch)}${item.note ? ` ${item.note}` : ""}`,
          );
          const kids = children.get(branch) ?? [];
          kids.forEach((child, index) =>
            walk(child, `${prefix}${last ? "   " : "│  "}`, index === kids.length - 1),
          );
        };
        const roots = trunkNames.flatMap((name) => children.get(name) ?? []);
        roots.forEach((root, index) => walk(root, "", index === roots.length - 1));
        if (roots.length === 0) lines.push("└─ ◌ stack is current");

        const summary = new Array<string>();
        if (created.size > 0) {
          const verb =
            opts.mode === "dry-run" ? `Would create ${requestLabel}s` : `Created ${requestLabel}s`;
          summary.push(
            `${verb}: ${[...created.values()]
              .sort((a, b) => a.branch.localeCompare(b.branch))
              .map((item) => (item.pr ? reference(item.pr) : `${item.branch} -> ${item.base}`))
              .join(", ")}`,
          );
        }
        if (updatedPrs.size > 0) {
          const verb =
            opts.mode === "dry-run" ? `Would update ${requestLabel}s` : `Updated ${requestLabel}s`;
          summary.push(
            `${verb}: ${[...updatedPrs]
              .sort((a, b) => a - b)
              .map((pr) => reference(pr))
              .join(", ")}`,
          );
        }
        if (backups > 0 && opts.mode === "apply") summary.push(`Backups created: ${backups}`);
        if (summary.length > 0) lines.push("", ...summary);
        if (opts.mode === "dry-run") lines.push("", "Apply:", "  stack sync --apply");
        else if (!opts.failed && (backups > 0 || updatedPrs.size > 0)) {
          lines.push("", "Undo:", "  stack undo --apply");
        }
        return lines;
      };

      const scopedBranches = (state: ReturnType<typeof stackState>, root: string) => {
        const children = new Map<string, Array<string>>();
        for (const link of state.links) {
          const parent = String(link.parent);
          const list = children.get(parent) ?? [];
          list.push(String(link.branch));
          children.set(parent, list);
        }

        const branches = new Set<string>();
        const visit = (branch: string) => {
          if (branches.has(branch)) return;
          branches.add(branch);
          for (const child of children.get(branch) ?? []) visit(child);
        };
        visit(root);
        return branches;
      };

      const filterState = (state: ReturnType<typeof stackState>, branches: ReadonlySet<string>) =>
        stackState(state.links.filter((link) => branches.has(String(link.branch))));

      const mergeState = (
        state: ReturnType<typeof stackState>,
        branches: ReadonlySet<string>,
        scoped: ReturnType<typeof stackState>,
      ) =>
        stateWithPlan(
          stackState(state.links.filter((link) => !branches.has(String(link.branch)))),
          scoped.links,
        );

      const writeScopedState = (branches: ReadonlySet<string>) =>
        Effect.fn("Stack.writeScopedState")((next: ReturnType<typeof stackState>) =>
          store
            .read()
            .pipe(Effect.flatMap((latest) => store.write(mergeState(latest, branches, next)))),
        );

      const actionBranch = (action: StackResult.StackResultItem) => {
        switch (action._tag) {
          case "Text":
          case "UpdateStackLinks":
            return null;
          case "Track":
            return String(action.link.branch);
          case "RemoveLink":
          case "UpdateLink":
          case "Reparent":
          case "Backup":
          case "Rebase":
          case "Push":
          case "CreatePull":
            return action.branch;
          case "RetargetPull":
            return null;
        }
      };

      const filterActions = (
        actions: ReadonlyArray<StackResult.StackResultItem>,
        branches: ReadonlySet<string>,
      ) =>
        actions.filter((action) => {
          const branch = actionBranch(action);
          return branch === null || branches.has(branch);
        });

      const changeForLink = Effect.fn("Stack.changeForLink")(function* (
        link: StackLink,
        pulls: ReadonlyArray<PullRef>,
      ) {
        const candidates = pulls.filter((pull) => pull.head === link.branch);
        const recorded = link.pr
          ? (candidates.find((pull) => Number(pull.number) === Number(link.pr)) ?? null)
          : null;
        if (recorded) return recorded;
        if (candidates.length <= 1) return candidates[0] ?? null;
        return yield* Effect.fail(
          new StackOperationError(
            `multiple open ${requestLabel}s have head branch ${link.branch}; cannot safely select ${reference(Number(link.pr ?? candidates[0]!.number))}`,
          ),
        );
      });

      const changesForLinks = Effect.fn("Stack.changesForLinks")(
        (links: ReadonlyArray<StackLink>, pulls: ReadonlyArray<PullRef>) =>
          Effect.forEach(links, (link) => changeForLink(link, pulls)).pipe(
            Effect.map((items) => items.filter((item): item is PullRef => item !== null)),
          ),
      );

      const status: StackService["status"] = Effect.fn("Stack.status")(() =>
        Effect.gen(function* () {
          const [state, refs, current, remote] = yield* Effect.all([
            store.read(),
            git.refs(),
            git.current(),
            git.remote(),
          ]);
          const pulls = yield* codeHost.changes().pipe(
            Effect.catchTags({
              ExecError: () => Effect.succeed([]),
              CodeHostDecodeError: () => Effect.succeed([]),
            }),
          );
          const base = Option.isSome(remote) ? codeHost.changeUrlBase(remote.value) : null;
          const prUrls = new Map(
            state.links.flatMap((link) =>
              base && link.pr ? [[Number(link.pr), `${base}/${link.pr}`]] : [],
            ),
          );
          return StackGraph.make({
            state,
            refs,
            pulls,
            prUrls,
            trunks: cfg.trunks,
            current,
          }).report;
        }),
      );

      const diagram = Effect.fn("Stack.diagram")(function* (branches?: ReadonlySet<string>) {
        const report = yield* status();
        const scopedReport = branches
          ? new StatusReport({
              current: report.current,
              trunks: report.trunks,
              nodes: report.nodes.filter((node) => branches.has(String(node.branch))),
            })
          : report;
        return ["", "Stack", renderDiagram(scopedReport, reference)];
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
          if (Option.isNone(base)) return yield* Effect.fail(new MergeBaseError(branch, parent));

          const [state, pulls] = yield* Effect.all([store.read(), codeHost.changes()]);
          const nextLinks = new Map(
            state.links
              .filter((link) => link.branch !== branch)
              .map((link) => [String(link.branch), String(link.parent)]),
          );
          if (
            StackGraph.wouldCreateCycle(nextLinks, new Set(cfg.trunks.map(String)), branch, parent)
          ) {
            return yield* Effect.fail(
              new StackOperationError(`tracking ${branch} onto ${parent} would create a cycle`),
            );
          }
          const candidates = pulls.filter((pull) => pull.head === branch);
          if (candidates.length > 1) {
            return yield* Effect.fail(
              new StackOperationError(
                `multiple open ${requestLabel}s have head branch ${branch}; cannot safely track one`,
              ),
            );
          }
          const pull = candidates[0] ?? null;
          const pr = pull?.number ?? null;
          const next = stackLink({
            branch,
            parent,
            anchor: base.value,
            pr,
            headRepository: pull?.headRepository ?? null,
          });
          const prev = state.links.find((link) => link.branch === branch) ?? null;
          if (
            prev &&
            prev.parent === next.parent &&
            prev.anchor === next.anchor &&
            prev.pr === next.pr &&
            prev.headRepository === next.headRepository
          ) {
            return next;
          }
          const links = state.links.filter((link) => link.branch !== branch);

          yield* store.write(
            stackState([...links, next].sort((a, b) => a.branch.localeCompare(b.branch))),
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
              pulls.map((pull) => String(pull.base)).filter((base) => !trunks.has(base)),
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
              if (pulls.filter((item) => item.head === pull.head).length > 1) {
                return yield* Effect.fail(
                  new StackOperationError(
                    `multiple open ${requestLabel}s have head branch ${branch}; cannot safely infer a stack link`,
                  ),
                );
              }
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
                headRepository: pull.headRepository,
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
            const selectedPulls = yield* changesForLinks(state.links, pulls);
            const pullsByBranch = new Map(selectedPulls.map((pull) => [String(pull.head), pull]));
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
                  reason: `no open ${requestLabel} and no open child ${requestLabel} depends on it`,
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
                    headRepository: pull.headRepository,
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
              state: stackState(reconciled.sort((a, b) => a.branch.localeCompare(b.branch))),
              actions,
              replayAnchors,
            };
          }),
      );

      const stateWithPlan = (
        state: ReturnType<typeof stackState>,
        plan: ReadonlyArray<StackLink>,
      ) => {
        const planned = new Map(state.links.map((link) => [String(link.branch), link]));
        for (const action of plan) {
          planned.set(String(action.branch), action);
        }

        return stackState([...planned.values()].sort((a, b) => a.branch.localeCompare(b.branch)));
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
            readonly initialEntries?: ReadonlyArray<UndoEntry>;
            readonly journalActions?: ReadonlyArray<StackResult.StackResultItem>;
            readonly initialActions?: ReadonlyArray<StackResult.StackResultItem>;
            readonly replayAnchors?: ReadonlyMap<string, string>;
            readonly writeState?: (
              state: ReturnType<typeof stackState>,
            ) => Effect.Effect<void, StackError>;
            readonly preserveUndo?: boolean;
          },
        ) =>
          Effect.gen(function* () {
            const apply = opts.apply;
            const saved = opts.saved ?? new Map<string, string>();
            const replayAnchors = opts.replayAnchors ?? new Map<string, string>();
            const journalState = opts.journalState ?? state;
            const journalActions = opts.journalActions ?? [];
            const initialActions = opts.initialActions ?? [];
            const mode: StackResult.Mode = apply ? "apply" : "dry-run";
            const stamp = yield* timestamp();
            const actions: Array<StackResult.StackResultItem> = Array.from(initialActions);
            const links = new Map(state.links.map((link) => [String(link.branch), link]));
            const graph = StackGraph.make({
              state,
              refs,
              pulls,
              trunks: cfg.trunks,
              current: "",
            });

            const live = new Map(refs.map((ref) => [String(ref.name), ref]));
            const heads = new Map(refs.map((ref) => [String(ref.name), ref.head]));
            const duplicateHeads = new Set<string>();
            const prs = new Map<string, PullRef>();
            for (const pull of pulls) {
              const branch = String(pull.head);
              if (prs.has(branch)) duplicateHeads.add(branch);
              prs.set(branch, pull);
            }
            const ambiguous = state.links.find((link) => duplicateHeads.has(String(link.branch)));
            if (ambiguous) {
              return yield* Effect.fail(
                new StackOperationError(
                  `multiple open ${requestLabel}s have head branch ${ambiguous.branch}; cannot safely select a remote to repair`,
                ),
              );
            }
            const childBases = new Set(pulls.map((pull) => String(pull.base)));
            let remoteByRepository: Map<string, string> | null = null;
            const tips = new Map<string, string | null>();
            const prior = new Map<string, string>();
            const moved = new Set<string>();
            const entries: Array<UndoEntry> = Array.from(opts.initialEntries ?? []);
            const next: Array<StackLink> = [];
            let journal = apply && (initialActions.length > 0 || entries.length > 0);

            const headRemote = Effect.fn("Stack.repairStack.headRemote")(function* (
              headRepository: string | null,
              change: number | null,
            ) {
              if (!headRepository) return "origin";
              if (!remoteByRepository) {
                const originRemote = yield* git.remote();
                remoteByRepository = new Map(
                  (yield* git.remotes()).flatMap((remote): Array<[string, string]> => {
                    const repository = codeHost.repository(
                      remote.url,
                      Option.getOrUndefined(originRemote),
                    );
                    return repository ? [[repository, remote.name]] : [];
                  }),
                );
              }
              const remote = remoteByRepository.get(headRepository);
              if (remote) return remote;
              return yield* new StackOperationError(
                `${requestLabel}${change === null ? "" : ` ${reference(change)}`} head is ${headRepository}, but no local git remote points to that repository`,
              );
            });

            const pushRemotes = Effect.fn("Stack.repairStack.pushRemotes")(function* (
              branch: string,
              headRepository: string | null,
              change: number | null,
            ) {
              const remotes = new Set<string>([yield* headRemote(headRepository, change)]);
              if (childBases.has(branch)) remotes.add("origin");
              return [...remotes];
            });

            const backups = refs
              .map((ref) => ref.name)
              .filter(
                (name) =>
                  name.startsWith("backup/landed-") || name.startsWith("backup/stack-sync-"),
              )
              .sort();
            for (const name of backups) {
              for (const link of state.links) {
                if (name.endsWith(`-${link.branch}`)) prior.set(String(link.branch), name);
              }
            }

            const checkpoint = Effect.fn("Stack.repairStack.checkpoint")(() =>
              apply
                ? store.writeUndo(
                    undoState(
                      stamp,
                      journalState,
                      entries,
                      StackResult.renderAll(
                        [...journalActions, ...actions],
                        reference,
                        requestLabel,
                      ),
                    ),
                  )
                : Effect.void,
            );

            if (journal) yield* checkpoint();

            const resolve = (name: string, seen = new Set<string>()): string | null => {
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
              (a, b) => graph.rank(String(a.branch)) - graph.rank(String(b.branch)),
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
                  StackResult.text(`skip ${link.branch}: cannot resolve parent ${link.parent}`),
                );
                continue;
              }

              if (parent !== link.parent)
                actions.push({
                  _tag: "Reparent",
                  mode,
                  branch: String(link.branch),
                  from: String(link.parent),
                  to: parent,
                });

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
              const previous =
                apply && !pr && link.pr
                  ? yield* codeHost
                      .change(link.pr)
                      .pipe(
                        Effect.catchTag("CodeHostChangeNotFoundError", () =>
                          Effect.succeed<PullMeta | null>(null),
                        ),
                      )
                  : null;
              const headRepository =
                pr?.headRepository ?? previous?.headRepository ?? link.headRepository ?? null;

              if (drift) {
                const targetRemotes = yield* pushRemotes(
                  String(link.branch),
                  headRepository,
                  pr ? Number(pr.number) : link.pr ? Number(link.pr) : null,
                );
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
                  pushRemotes: targetRemotes,
                } satisfies RepairPlan.RebaseBranchPlan;
                actions.push(...RepairPlan.rebaseBranch(rebase, mode));

                if (apply) {
                  const priorEntry = entries.find((item) => item.branch === link.branch) ?? null;
                  const entry = undoEntry({
                    branch: link.branch,
                    backup,
                    pr: priorEntry?.pr ?? pr?.number ?? link.pr ?? null,
                    base: priorEntry?.base ?? base,
                    created: priorEntry?.created ?? null,
                    pushRemotes: targetRemotes,
                  });
                  const entryIndex = entries.findIndex((item) => item.branch === link.branch);
                  if (entryIndex >= 0) entries[entryIndex] = entry;
                  else entries.push(entry);
                  journal = true;
                  yield* RepairExecution.applyRebaseBranch(rebase, {
                    git,
                    checkpoint,
                    step,
                    onReplayFailure: (err) => replayFailure(rebase, err, state, pulls, actions),
                  });
                  saved.set(rebase.branch, rebase.backup);
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
                  if (!entries.some((item) => item.branch === link.branch)) {
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
                  }
                  yield* RepairExecution.applyRetargetPull(retarget, {
                    checkpoint,
                    step,
                    edit: codeHost.edit,
                    reference,
                  });
                }
                prs.set(
                  link.branch,
                  pullRef({
                    number: now.number,
                    head: now.head,
                    headRepository: now.headRepository,
                    base: parent,
                    url: now.url,
                    draft: now.draft,
                    checks: now.checks,
                  }),
                );
              }

              const open = prs.get(link.branch) ?? null;
              if (!open) {
                if (apply) {
                  const prev = previous;
                  const nextPr = draft(link, parent, prev);
                  if (!entries.some((item) => item.branch === link.branch)) {
                    entries.push(
                      undoEntry({
                        branch: link.branch,
                        backup: null,
                        pr: now?.number ?? link.pr ?? null,
                        base,
                        created: null,
                      }),
                    );
                    journal = true;
                  }
                  yield* step(`create ${requestLabel} for ${link.branch} -> ${parent}`);
                  yield* checkpoint();
                  const made = yield* codeHost.create(
                    link.branch,
                    parent,
                    nextPr.title,
                    nextPr.body,
                    nextPr.labels,
                    headRepository,
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
                  const i = entries.findIndex((item) => item.branch === link.branch);
                  if (i >= 0) {
                    entries[i] = undoEntry({
                      branch: entries[i]!.branch,
                      backup: entries[i]!.backup,
                      pr: entries[i]!.pr,
                      base: entries[i]!.base,
                      created: made.number,
                      ...(entries[i]!.pushRemotes ? { pushRemotes: entries[i]!.pushRemotes } : {}),
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
                  actions.push(
                    RepairPlan.createPull(
                      {
                        branch: String(link.branch),
                        base: parent,
                        pr: null,
                      },
                      mode,
                    ),
                  );
                }
              } else {
                num = open.number;
              }

              next.push(
                stackLink({
                  branch: String(link.branch),
                  parent,
                  anchor: heads.get(parent) ?? want ?? link.anchor,
                  pr: num ?? null,
                  headRepository: open?.headRepository ?? headRepository,
                }),
              );
            }

            const resultState = stackState(next.sort((a, b) => a.branch.localeCompare(b.branch)));

            if (apply && (actions.length > 0 || !sameState(state, resultState))) {
              yield* (opts.writeState ?? store.write)(resultState);
            }

            if (apply && !journal && !opts.preserveUndo) {
              yield* store.clearUndo();
            }

            return {
              actions,
              state: resultState,
              undo: journal
                ? undoState(
                    stamp,
                    journalState,
                    entries,
                    StackResult.renderAll([...journalActions, ...actions], reference, requestLabel),
                  )
                : null,
              lines:
                actions.length > 0
                  ? StackResult.renderAll(actions, reference, requestLabel)
                  : [apply ? "stack is current" : "would make no changes"],
            };
          }),
      );

      const sync: StackService["sync"] = Effect.fn("Stack.sync")((opts) =>
        Effect.gen(function* () {
          const apply = opts?.apply ?? false;
          const dryRun = !apply;
          const requestedBranch = opts?.branch;
          const continueOnFailure = opts?.continueOnFailure ?? false;
          const current = requestedBranch && dryRun ? "" : yield* git.current();
          return yield* Effect.gen(function* () {
            if (!dryRun) yield* clean();
            if (!dryRun) yield* git.fetch();
            const [state, refs, pulls] = yield* Effect.all([
              store.read(),
              git.refs(),
              codeHost.changes(),
            ]);
            const reconciled = yield* reconcileApplyState(
              state,
              refs,
              pulls,
              dryRun ? "dry-run" : "apply",
            );
            const plan = yield* inferApplyPlan(reconciled.state, refs, pulls);
            const planned = stateWithPlan(reconciled.state, plan);
            const mode: StackResult.Mode = dryRun ? "dry-run" : "apply";

            const graph = StackGraph.make({
              state: planned,
              refs,
              pulls,
              trunks: cfg.trunks,
              current,
            });
            const linked = new Set(planned.links.map((link) => String(link.branch)));
            const resolveScope = (branch: string, explicit: boolean) => {
              if (!linked.has(branch)) {
                if (explicit) {
                  return Effect.fail<StackOperationError>(
                    new StackOperationError(`${branch} is not part of a tracked stack`),
                  );
                }
                return Effect.succeed<{
                  readonly root: string;
                  readonly branches: ReadonlySet<string>;
                } | null>(null);
              }
              const root = graph.rootOf(branch);
              return Effect.succeed({ root, branches: scopedBranches(planned, root) });
            };
            const scope = requestedBranch
              ? yield* resolveScope(requestedBranch, true)
              : yield* resolveScope(current, false);

            const initialActions = [...reconciled.actions, ...plan.map(StackResult.track)];

            const syncScoped = Effect.fn("Stack.sync.scoped")(
              (
                target: { readonly root: string; readonly branches: ReadonlySet<string> } | null,
                preserveUndo = false,
              ) =>
                Effect.gen(function* () {
                  const scoped = target ? filterState(planned, target.branches) : planned;
                  const scopedInitial = target
                    ? filterActions(initialActions, target.branches)
                    : initialActions;
                  const replayAnchors = target
                    ? new Map(
                        [...reconciled.replayAnchors].filter(([branch]) =>
                          target.branches.has(branch),
                        ),
                      )
                    : reconciled.replayAnchors;
                  const writeState = target ? writeScopedState(target.branches) : undefined;
                  const scopedPulls = yield* changesForLinks(scoped.links, pulls);
                  const repair = yield* repairStack(scoped, refs, scopedPulls, {
                    apply: !dryRun,
                    journalState: state,
                    replayAnchors,
                    initialActions: scopedInitial,
                    ...(writeState ? { writeState } : {}),
                    preserveUndo,
                  });
                  const changedOpenPulls = repair.actions.some(
                    (action) => action._tag === "RetargetPull" || action._tag === "CreatePull",
                  );
                  const notesPulls = yield* changesForLinks(
                    repair.state.links,
                    !dryRun && changedOpenPulls ? yield* codeHost.changes() : pulls,
                  );
                  const notes = yield* linksFor(repair.state, !dryRun, new Set(), notesPulls);
                  const changed = repair.actions.length > 0 || notes.actions.length > 0;
                  const lines = !changed
                    ? renderSyncTree({
                        title: "Stack is current",
                        state: scoped,
                        pulls: scopedPulls,
                        actions: [],
                        mode,
                      })
                    : renderSyncTree({
                        title: dryRun ? "Sync preview" : "Synced stack",
                        state: repair.state,
                        pulls: scopedPulls,
                        actions: [...repair.actions, ...notes.actions],
                        mode,
                      });
                  return { lines, undo: repair.undo };
                }),
            );

            if (requestedBranch || !continueOnFailure) {
              const result = yield* syncScoped(scope);
              return result.lines;
            }

            const roots = cfg.trunks
              .flatMap((trunk) => planned.links.filter((link) => link.parent === trunk))
              .map((link) => String(link.branch))
              .sort((a, b) => a.localeCompare(b));
            const succeeded = new Array<string>();
            const failed = new Array<{ root: string; error: string }>();
            const sections = new Array<string>();
            const aggregateEntries = new Array<UndoEntry>();
            const aggregateActions = new Array<string>();
            let aggregateAt: string | null = null;

            const rememberUndo = (run: ReturnType<typeof undoState> | null) => {
              if (!run) return;
              aggregateAt ??= String(run.at);
              aggregateEntries.push(...run.entries);
              aggregateActions.push(...run.actions);
            };

            for (const root of roots) {
              const result = yield* Effect.result(
                syncScoped({ root, branches: scopedBranches(planned, root) }, true),
              );
              if (Result.isSuccess(result)) {
                succeeded.push(root);
                if (sections.length > 0) sections.push("");
                rememberUndo(result.success.undo);
                sections.push(...result.success.lines);
              } else {
                rememberUndo(yield* store.readUndo());
                failed.push({ root, error: String(result.failure) });
              }

              if (!dryRun && aggregateAt && aggregateEntries.length > 0) {
                yield* store.writeUndo(
                  undoState(aggregateAt, state, aggregateEntries, aggregateActions),
                );
              }
            }

            const summary = [
              "Sync complete",
              `${succeeded.length} ${succeeded.length === 1 ? "stack" : "stacks"} synced, ${failed.length} ${failed.length === 1 ? "stack" : "stacks"} failed`,
            ];
            if (succeeded.length > 0) {
              summary.push("", "Succeeded:", ...succeeded.map((root) => `  ${root}`));
            }
            if (failed.length > 0) {
              summary.push("", "Failed:");
              for (const item of failed) {
                summary.push(`  ${item.root}`, item.error);
              }
            }

            const output = [...summary, ...(sections.length > 0 ? ["", ...sections] : [])];
            if (failed.length > 0) {
              return yield* Effect.fail(new StackOperationError(output.join("\n")));
            }
            return output;
          }).pipe(
            Effect.ensuring(
              dryRun
                ? Effect.void
                : git.switch(current).pipe(Effect.catchTag("ExecError", () => Effect.void)),
            ),
          );
        }),
      );

      const linksFor = Effect.fn("Stack.linksFor")(
        (
          stateOverride: ReturnType<typeof stackState> | null,
          apply = false,
          completed = new Set<string>(),
          pullsOverride?: ReadonlyArray<PullRef>,
        ) =>
          Effect.gen(function* () {
            const [state, pulls] = yield* Effect.all([
              stateOverride ? Effect.succeed(stateOverride) : store.read(),
              pullsOverride ? Effect.succeed(pullsOverride) : codeHost.changes(),
            ]);
            const selectedPulls = yield* changesForLinks(state.links, pulls);
            const prs = new Map(selectedPulls.map((pull) => [String(pull.head), pull]));
            const info = yield* Effect.all(
              state.links
                .map((link) => link.pr)
                .filter((pr): pr is NonNullable<typeof pr> => pr !== null)
                .map((pr) =>
                  codeHost
                    .change(pr)
                    .pipe(
                      Effect.catchTag("CodeHostChangeNotFoundError", () => Effect.succeed(null)),
                    ),
                ),
              { concurrency: cfg.codeHostConcurrency },
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
            const completedTitles = yield* Effect.gen(function* () {
              if (codeHost.provider !== "gitlab") return new Map<number, string>();
              const numbers = [
                ...new Set(
                  info
                    .filter((item): item is PullMeta => item !== null)
                    .flatMap((item) => StackBlock.references(item.body)),
                ),
              ];
              const completed = yield* Effect.all(
                numbers.map((number) =>
                  codeHost
                    .change(number)
                    .pipe(
                      Effect.catchTag("CodeHostChangeNotFoundError", () => Effect.succeed(null)),
                    ),
                ),
                { concurrency: cfg.codeHostConcurrency },
              );
              return new Map(
                completed
                  .filter((item): item is PullMeta => item !== null)
                  .map((item) => [Number(item.number), item.title]),
              );
            });
            const graph = StackGraph.make({
              state,
              refs: [],
              pulls: selectedPulls,
              trunks: cfg.trunks,
              current: "",
            });
            const jobs = state.links
              .map((link) => prs.get(String(link.branch)))
              .filter((pull): pull is PullRef => Boolean(pull))
              .map((pull) =>
                Effect.gen(function* () {
                  const meta =
                    metasByNumber.get(Number(pull.number)) ?? (yield* codeHost.change(pull.number));
                  const next = StackBlock.splice(
                    meta.body,
                    StackBlock.render({
                      pulls: selectedPulls,
                      metas,
                      chain: graph.explicitChainFor(String(pull.head)),
                      completed,
                      branch: String(pull.head),
                      previous: meta.body,
                      reference,
                      showTitles:
                        codeHost.provider === "gitlab" || codeHost.provider === "azuredevops",
                      completedTitles,
                    }),
                  );
                  if (next === meta.body) return null;
                  if (apply) {
                    yield* step(`update ${reference(Number(pull.number))} stack block`);
                    yield* codeHost.body(pull.number, next);
                  }
                  return {
                    _tag: "UpdateStackLinks",
                    mode: apply ? "apply" : "dry-run",
                    pr: Number(pull.number),
                  } satisfies StackResult.StackResultItem;
                }),
              );

            const items = yield* Effect.all(jobs, {
              concurrency: cfg.codeHostConcurrency,
            });
            const actions = items.filter((item): item is NonNullable<typeof item> => item !== null);
            return {
              actions,
              lines:
                actions.length > 0
                  ? StackResult.renderAll(actions, reference, requestLabel)
                  : [apply ? "stack links are current" : "would make no description changes"],
            };
          }),
      );

      const links: StackService["links"] = Effect.fn("Stack.links")((apply = false) =>
        linksFor(null, apply).pipe(Effect.map((result) => result.lines)),
      );

      const last = Effect.fn("Stack.last")(() =>
        Effect.gen(function* () {
          const run = yield* store.readUndo();
          if (!run) return ["no applied mutation recorded"];
          const items = run.actions.length > 0 ? run.actions : ["no actions recorded"];
          return [`last mutation: ${run.at}`, ...items, "undo with: stack undo --apply"];
        }),
      );

      const doctor: StackService["doctor"] = Effect.fn("Stack.doctor")(() =>
        Effect.gen(function* () {
          const describe = (err: unknown) => {
            if (err instanceof ExecError) {
              const stderr = err.stderr.trim();
              if (!stderr) {
                if (err.tool === "az" && process.platform === "win32") {
                  return `${err.message}\n  (no stderr — rebuild and relink global stack: bun run build && npm link)`;
                }
                return err.message;
              }
              const snippet = stderr.length > 240 ? `${stderr.slice(0, 240)}…` : stderr;
              return `${err.message}\n  ${snippet}`;
            }
            return err instanceof Error ? err.message : String(err);
          };
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
          const pulls = yield* codeHost.changes().pipe(
            Effect.match({
              onFailure: (err) => `fail open ${requestLabel}s: ${describe(err)}`,
              onSuccess: (pulls) => `ok open ${requestLabel}s visible: ${pulls.length}`,
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
          const adoChecks =
            codeHost.provider === "azuredevops"
              ? yield* Effect.gen(function* () {
                  const maybeProc = yield* Effect.serviceOption(Proc.Service);
                  if (Option.isNone(maybeProc)) return [] as ReadonlyArray<string>;
                  const origin = yield* git.remote().pipe(
                    Effect.match({
                      onFailure: () => Option.none<string>(),
                      onSuccess: (remote) => remote,
                    }),
                  );
                  if (Option.isNone(origin)) {
                    return ["warn Azure DevOps: no origin remote configured"];
                  }
                  const ado = CodeHost.adoRemoteInfo(origin.value);
                  if (!ado) {
                    return [
                      "fail Azure DevOps: unable to parse organization, project, and repository from origin",
                    ];
                  }
                  return yield* CodeHostAzureDevOps.doctorChecks(maybeProc.value, cfg.root, ado);
                })
              : [];

          return [current, clean, ...trunks, ...adoChecks, pulls, state, undo];
        }),
      );

      const landTarget = Effect.fn("Stack.landTarget")((branch?: string) =>
        Effect.gen(function* () {
          const [state, refs, pulls, current] = yield* Effect.all([
            store.read(),
            git.refs(),
            codeHost.changes(),
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
          return { state, refs, pulls, current, graph, target };
        }),
      );

      const throughTarget = Effect.fn("Stack.land.throughTarget")(
        (branch: string | undefined, through: string) =>
          Effect.gen(function* () {
            const { state, pulls, graph, target } = yield* landTarget(branch);
            const input = through.trim();
            const prText = input.startsWith("#") || input.startsWith("!") ? input.slice(1) : input;
            const prNumber = /^\d+$/.test(prText) ? Number(prText) : null;
            const byPr = prNumber
              ? (pulls.find((item) => Number(item.number) === prNumber)?.head ??
                state.links.find((item) => Number(item.pr) === prNumber)?.branch ??
                null)
              : null;
            const throughBranch = byPr ? String(byPr) : input;
            const chain = graph.explicitChainFor(target);
            const targetIndex = chain.indexOf(target);
            const throughIndex = chain.indexOf(throughBranch);
            if (throughIndex === -1 || throughIndex < targetIndex) {
              return yield* Effect.fail(
                new StackOperationError(`${through} is not in the current stack from ${target}`),
              );
            }
            return throughBranch;
          }),
      );

      const landOne = Effect.fn("Stack.landOne")(
        (
          branch?: string,
          opts?: {
            readonly apply?: boolean;
            readonly auto?: boolean;
            readonly admin?: boolean;
            readonly through?: string;
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
              return yield* Effect.fail(new StackOperationError("use --admin only with --apply"));
            }
            if (admin && !codeHost.capabilities.adminMerge) {
              return yield* Effect.fail(
                new StackOperationError(`--admin is not supported by ${codeHost.provider}`),
              );
            }
            const active = apply || auto;

            if (active) yield* clean();
            const { state, refs, pulls, current, target } = yield* landTarget(branch);
            const link = state.links.find((item) => item.branch === target) ?? null;
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
                new StackOperationError(`${target} is not the oldest branch in its stack`),
              );
            }

            const branches = scopedBranches(state, target);
            const scopedState = filterState(state, branches);

            const pr = yield* changeForLink(link, pulls);
            if (!pr) {
              return yield* Effect.fail(
                new StackOperationError(`no open ${requestLabel} found for ${target}`),
              );
            }

            const root = link.parent;
            const stamp = yield* timestamp();
            const name = `backup/landed-${stamp}-${target}`;
            const hasLocalTarget = refs.some((item) => item.name === target);
            const next = scopedState.links.find((item) => item.parent === target)?.branch ?? null;
            const landed = new Set([reference(Number(pr.number)), String(target)]);
            const preRetargets = (yield* Effect.forEach(
              scopedState.links.filter((item) => item.parent === target),
              (child) =>
                changeForLink(child, pulls).pipe(
                  Effect.map((childPr) =>
                    childPr && childPr.base !== link.parent
                      ? {
                          pr: Number(childPr.number),
                          branch: String(child.branch),
                          base: String(link.parent),
                        }
                      : null,
                  ),
                ),
            )).filter((item): item is NonNullable<typeof item> => item !== null);
            const retargetChildren = Effect.forEach(
              preRetargets,
              (item) =>
                RepairExecution.applyRetargetPull(
                  { pr: item.pr, base: item.base },
                  {
                    checkpoint: checkpointRetargets,
                    step,
                    edit: codeHost.edit,
                    message: `retarget ${reference(item.pr)} (${item.branch}) to ${item.base} before merge`,
                    reference,
                  },
                ),
              { discard: true },
            );
            const landedState = stackState(
              scopedState.links.flatMap((item) => {
                if (item.branch === target) return [];
                return [
                  item.parent === target
                    ? stackLink({
                        branch: String(item.branch),
                        parent: String(root),
                        anchor: String(item.anchor),
                        pr: item.pr === null ? null : Number(item.pr),
                        headRepository: item.headRepository ?? null,
                      })
                    : item,
                ];
              }),
            );
            const beginPostMergeRepair = Effect.fn("Stack.land.beginPostMergeRepair")(function* () {
              yield* writeScopedState(branches)(landedState);
              yield* store.clearUndo();
            });
            const retargetEntries = preRetargets.map((item) =>
              undoEntry({
                branch: item.branch,
                backup: null,
                pr: item.pr,
                base: target,
                created: null,
              }),
            );
            const retargetActions = preRetargets.map(
              (item): StackResult.StackResultItem => ({
                _tag: "RetargetPull",
                mode: "apply",
                pr: item.pr,
                base: item.base,
              }),
            );
            const checkpointRetargets = () =>
              retargetEntries.length > 0
                ? store.writeUndo(
                    undoState(
                      stamp,
                      state,
                      retargetEntries,
                      StackResult.renderAll(retargetActions, reference, requestLabel),
                    ),
                  )
                : Effect.void;
            const plannedPulls = pulls.map((item) => {
              const retarget = preRetargets.find((next) => next.pr === item.number);
              return retarget
                ? pullRef({
                    number: item.number,
                    head: item.head,
                    headRepository: item.headRepository,
                    base: retarget.base,
                    url: item.url,
                    draft: item.draft,
                    checks: item.checks,
                  })
                : item;
            });
            const actions = [
              ...(current === target ? [`${active ? "" : "would "}switch to ${root}`] : []),
              ...(hasLocalTarget ? [`${active ? "" : "would "}backup ${target} -> ${name}`] : []),
              ...preRetargets.map(
                (item) =>
                  `${active ? "" : "would "}retarget ${reference(item.pr)} (${item.branch}) to ${item.base} before merge`,
              ),
              auto
                ? `enable auto-merge ${reference(Number(pr.number))} (${target})`
                : `${apply ? "" : "would "}${admin ? "admin " : ""}merge ${reference(Number(pr.number))} (${target})`,
              ...(auto ? [`wait for ${reference(Number(pr.number))} to merge`] : []),
            ];

            const repairAfterMerge = Effect.fn("Stack.land.repairAfterMerge")(() =>
              Effect.gen(function* () {
                yield* git.fetch();
                const [nextState, nextRefs, nextPulls] = yield* Effect.all([
                  store.read(),
                  git.refs(),
                  codeHost.changes(),
                ]);
                const repairPulls = yield* changesForLinks(
                  scopedState.links.filter((item) => item.branch !== target),
                  nextPulls,
                );
                const repair = yield* repairStack(
                  scopedState,
                  nextRefs.filter((item) => item.name !== target),
                  repairPulls,
                  {
                    apply: true,
                    saved: new Map([[target, name]]),
                    journalState: nextState,
                    journalActions: retargetActions,
                    writeState: writeScopedState(branches),
                  },
                );
                const repairedPulls = yield* changesForLinks(
                  repair.state.links,
                  yield* codeHost.changes(),
                );
                const notes = yield* linksFor(repair.state, true, landed, repairedPulls);
                if (current !== target) yield* git.switch(current);
                const tail = next ? `next root: ${next}` : "next root: none";
                const view = yield* diagram(branches);
                return [...actions, ...repair.lines, ...notes.lines, tail, ...view];
              }),
            );

            if (auto || apply) {
              yield* checkpointRetargets();
              if (current === target) {
                yield* step(`switch to ${root}`);
                yield* git.switch(root);
              }
              if (hasLocalTarget) {
                yield* step(`backup ${target} -> ${name}`);
                yield* git.backup(target, name);
              }
              yield* retargetChildren;
              if (auto) {
                yield* step(`enable auto-merge ${reference(Number(pr.number))} (${target})`);
                yield* codeHost.auto(pr.number);
                yield* wait(`waiting for ${reference(Number(pr.number))} to merge`);
                yield* codeHost.wait(pr.number);
              } else {
                yield* step(
                  `${admin ? "admin " : ""}merge ${reference(Number(pr.number))} (${target})`,
                );
                yield* codeHost.merge(pr.number, { admin }).pipe(Effect.mapError(mergeFailure));
              }
              yield* beginPostMergeRepair();
              if (hasLocalTarget) {
                yield* step(`drop local ${target}`);
                yield* git.drop(target);
              }
              return yield* repairAfterMerge();
            }

            const repairPulls = yield* changesForLinks(
              scopedState.links.filter((item) => item.branch !== target),
              plannedPulls,
            );
            const repair = yield* repairStack(
              scopedState,
              refs.filter((item) => item.name !== target),
              repairPulls,
              { apply: false },
            );
            const tail = next ? `next root: ${next}` : "next root: none";
            return [...actions, ...repair.lines, tail];
          }),
      );

      const land: StackService["land"] = Effect.fn("Stack.land")((branch, opts) => {
        const through = opts?.through;
        if (!through) return landOne(branch, opts);

        return Effect.gen(function* () {
          if (!opts?.auto) {
            return yield* Effect.fail(new StackOperationError("use --through only with --auto"));
          }

          const stop = yield* throughTarget(branch, through);
          const items = new Array<string>();
          let nextBranch = branch;

          for (;;) {
            const { target } = yield* landTarget(nextBranch);
            if (items.length > 0) items.push("");
            items.push(...(yield* landOne(target, { auto: true })));
            if (target === stop) {
              items.push(`merged through: ${stop}`);
              return items;
            }
            nextBranch = undefined;
          }
        });
      });

      const undo = Effect.fn("Stack.undo")((apply = false) =>
        Effect.gen(function* () {
          const current = yield* git.current();
          if (apply) yield* clean();
          const run = yield* store.readUndo();
          if (!run) return [apply ? "nothing to undo" : "would do nothing"];

          const mode = apply ? "" : "would ";
          const actions: Array<string> = [];
          const trunks = new Set(cfg.trunks.map(String));
          const stateTrunk = run.state.links.find((link) =>
            trunks.has(String(link.parent)),
          )?.parent;
          const trunk = stateTrunk ?? cfg.trunks[0] ?? branchName("dev");
          const restore = new Set(
            run.entries.flatMap((item) => (item.backup ? [String(item.branch)] : [])),
          );

          if (restore.has(current)) {
            actions.push(`${mode}switch to ${trunk}`);
            if (apply) yield* git.switch(trunk);
          }

          for (const item of run.entries) {
            if (!item.backup) continue;
            actions.push(`${mode}restore ${item.branch} from ${item.backup}`);
            const remotes = item.pushRemotes ?? ["origin"];
            actions.push(
              StackResult.render({
                _tag: "Push",
                mode: apply ? "apply" : "dry-run",
                branch: String(item.branch),
                remotes,
              }),
            );
            if (apply) {
              yield* git.restore(item.branch, item.backup);
              for (const remote of remotes) yield* git.push(item.branch, remote);
            }
          }

          for (const item of run.entries) {
            if (item.created) {
              actions.push(`${mode}close ${reference(Number(item.created))}`);
              if (apply) yield* codeHost.close(item.created);
            }
            if (item.pr && item.base) {
              actions.push(`${mode}retarget ${reference(Number(item.pr))} to ${item.base}`);
              if (apply) yield* codeHost.edit(item.pr, item.base);
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

      return Stack.of({ status, adopt, links, land, sync, doctor, last, undo });
    }),
  );
}
