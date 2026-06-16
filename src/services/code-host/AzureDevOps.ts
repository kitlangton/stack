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

/** Azure DevOps enterprise app — required `az rest --resource` for dev.azure.com APIs. */
export const restResource = "499b84ac-1321-427f-aa17-267ca6975798";

const branchName = (ref: string) => ref.replace(/^refs\/heads\//, "");

const targetRefName = (branch: string) =>
  branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;

const LabelEntry = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]);

const labelName = (entry: typeof LabelEntry.Type): string =>
  typeof entry === "string" ? entry : entry.name;

class PRListRow extends Schema.Class<PRListRow>("PRListRow")({
  pullRequestId: Schema.Number,
  title: Schema.String,
  sourceRefName: Schema.String,
  targetRefName: Schema.String,
  url: Schema.optional(Schema.String),
  isDraft: Schema.optional(Schema.Boolean),
}) {}

type PRData = {
  readonly pullRequestId: number;
  readonly title: string;
  readonly sourceRefName: string;
  readonly targetRefName: string;
  readonly url: string;
  readonly isDraft: boolean;
};

const normalizeListRow = (row: PRListRow, urlBase: string): PRData => ({
  pullRequestId: row.pullRequestId,
  title: row.title,
  sourceRefName: row.sourceRefName,
  targetRefName: row.targetRefName,
  url: row.url ?? `${urlBase}/${row.pullRequestId}`,
  isDraft: row.isDraft ?? false,
});

class PRViewRow extends Schema.Class<PRViewRow>("PRViewRow")({
  pullRequestId: Schema.Number,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  sourceRefName: Schema.String,
  targetRefName: Schema.String,
  url: Schema.optional(Schema.String),
  isDraft: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.NullOr(Schema.Array(LabelEntry))),
}) {}

type PRViewData = {
  readonly pullRequestId: number;
  readonly title: string;
  readonly description: string;
  readonly sourceRefName: string;
  readonly targetRefName: string;
  readonly url: string;
  readonly isDraft: boolean;
  readonly status: string;
  readonly labels: ReadonlyArray<typeof LabelEntry.Type>;
};

const normalizePRView = (row: PRViewRow, urlBase: string): PRViewData => ({
  pullRequestId: row.pullRequestId,
  title: row.title,
  description: row.description ?? "",
  sourceRefName: row.sourceRefName,
  targetRefName: row.targetRefName,
  url: row.url ?? `${urlBase}/${row.pullRequestId}`,
  isDraft: row.isDraft ?? false,
  status: row.status ?? "active",
  labels: row.labels ?? [],
});

class PRCreated extends Schema.Class<PRCreated>("PRCreated")({
  pullRequestId: Schema.Number,
  title: Schema.String,
  sourceRefName: Schema.String,
  targetRefName: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
}) {}

class PRWatch extends Schema.Class<PRWatch>("PRWatch")({
  status: Schema.String,
}) {}

const parseJsonArray = (out: string): ReadonlyArray<unknown> => {
  const trimmed = out.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [];
};

const decodePRList = (args: ReadonlyArray<string>, out: string, urlBase: string) =>
  Effect.try({
    try: () =>
      parseJsonArray(out).map((row) =>
        normalizeListRow(Schema.decodeUnknownSync(PRListRow)(row), urlBase),
      ),
    catch: (err) => new CodeHostDecodeError("az", args, out, String(err)),
  });

const decodePRView = (args: ReadonlyArray<string>, out: string, urlBase: string) =>
  Effect.try({
    try: () => normalizePRView(Schema.decodeUnknownSync(PRViewRow)(JSON.parse(out)), urlBase),
    catch: (err) => new CodeHostDecodeError("az", args, out, String(err)),
  });

const decodePRWatch = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PRWatch)(JSON.parse(out)),
    catch: (err) => new CodeHostDecodeError("az", args, out, String(err)),
  });

const decodePRCreated = (args: ReadonlyArray<string>, out: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PRCreated)(JSON.parse(out)),
    catch: (err) => new CodeHostDecodeError("az", args, out, String(err)),
  });

const isShowCommand = (args: ReadonlyArray<string>) =>
  args[0] === "repos" && args[1] === "pr" && args[2] === "show";

const missingPull = (err: ExecError) => {
  const detail = `${err.stderr}\n${err.message}`;
  if (/not found|does not exist|404|TF401180/i.test(detail)) return true;
  // Windows az can surface missing PRs with empty stderr.
  return isShowCommand(err.args) && err.code !== 0 && !err.stderr.trim();
};

const listRef = (row: PRData) =>
  pullRef({
    number: row.pullRequestId,
    title: row.title,
    head: branchName(row.sourceRefName),
    headRepository: null,
    base: branchName(row.targetRefName),
    url: row.url,
    draft: row.isDraft,
  });

const meta = (row: PRViewData) =>
  pullMeta({
    number: row.pullRequestId,
    title: row.title,
    body: row.description,
    head: branchName(row.sourceRefName),
    headRepository: null,
    base: branchName(row.targetRefName),
    url: row.url,
    draft: row.isDraft,
    state: row.status,
    labels: row.labels.map((item) => new PullLabel({ name: labelName(item) })),
  });

const properties = {
  provider: "azuredevops" as const,
  capabilities: { adminMerge: false },
  requestLabel: "PR" as const,
  reference: (number: number) => `!${number}`,
  repository: CodeHost.repositoryFor,
  changeUrlBase: CodeHost.adoChangeUrlBase,
} satisfies CodeHost.AdapterProperties;

/** org + project + repository — `az repos pr list` and `create`. */
export const repoScope = (
  ado: { readonly organizationUrl: string; readonly project: string; readonly repository: string },
  tail: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "repos",
  "pr",
  ...tail,
  "--organization",
  ado.organizationUrl,
  "--project",
  ado.project,
  "--repository",
  ado.repository,
];

/** organization only — `az repos pr show` and `update` (PR id is globally unique in the org). */
export const prScope = (
  organizationUrl: string,
  tail: ReadonlyArray<string>,
): ReadonlyArray<string> => ["repos", "pr", ...tail, "--organization", organizationUrl];

/** Retarget an active PR — `az repos pr update` has no target-branch flag; use REST PATCH. */
export const retargetArgs = (
  ado: { readonly organizationUrl: string; readonly project: string; readonly repository: string },
  pr: number,
  base: string,
): ReadonlyArray<string> => [
  "rest",
  "--method",
  "patch",
  "--uri",
  `${ado.organizationUrl}/${encodeURIComponent(ado.project)}/_apis/git/repositories/${encodeURIComponent(ado.repository)}/pullrequests/${pr}?api-version=7.1`,
  "--resource",
  restResource,
  "--body",
  JSON.stringify({ targetRefName: targetRefName(base) }),
];

/** Add a label to a PR — `az repos pr create` has no label flag; use REST POST. */
export const labelArgs = (
  ado: { readonly organizationUrl: string; readonly project: string; readonly repository: string },
  prId: number,
  label: string,
): ReadonlyArray<string> => [
  "rest",
  "--method",
  "post",
  "--uri",
  `${ado.organizationUrl}/${encodeURIComponent(ado.project)}/_apis/git/repositories/${encodeURIComponent(ado.repository)}/pullrequests/${prId}/labels?api-version=7.1`,
  "--resource",
  restResource,
  "--body",
  JSON.stringify({ name: label }),
];

const describeAzFailure = (err: unknown) => {
  if (err instanceof ExecError) {
    const detail = `${err.stderr}\n${err.message}`;
    return detail.trim() || err.message;
  }
  return err instanceof Error ? err.message : String(err);
};

/** Read-only Azure DevOps prerequisite checks for `stack doctor`. */
export const doctorChecks = (
  proc: Proc.Interface,
  root: string,
  ado: { readonly organizationUrl: string; readonly project: string; readonly repository: string },
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    const version = yield* proc.exec(root, "az", ["version"], [0]).pipe(
      Effect.match({
        onFailure: () => "fail Azure CLI: az not found or not on PATH (install Azure CLI)",
        onSuccess: () => "ok Azure CLI: az available",
      }),
    );
    const extension = yield* proc
      .exec(root, "az", ["extension", "show", "--name", "azure-devops"], [0])
      .pipe(
        Effect.match({
          onFailure: (err) => {
            const detail = describeAzFailure(err);
            if (/not found|is not installed|No extension/i.test(detail)) {
              return "fail azure-devops extension: not installed (run: az extension add --name azure-devops)";
            }
            return `fail azure-devops extension: ${detail}`;
          },
          onSuccess: () => "ok azure-devops extension: installed",
        }),
      );
    const listArgs = repoScope(ado, [
      "list",
      "--status",
      "active",
      "--top",
      "1",
      "--output",
      "json",
    ]);
    const prAccess = yield* proc.exec(root, "az", listArgs, [0]).pipe(
      Effect.match({
        onFailure: (err) => {
          const detail = describeAzFailure(err);
          if (/login|unauthorized|authentication|401|AAD|not logged in/i.test(detail)) {
            return "fail Azure DevOps auth: run az login and set AZURE_DEVOPS_EXT_PAT when needed";
          }
          return `fail Azure DevOps pull requests: ${detail}`;
        },
        onSuccess: () => "ok Azure DevOps pull requests: accessible",
      }),
    );
    return [version, extension, prAccess];
  });

export const layer = Layer.effect(
  CodeHost.Service,
  Effect.gen(function* () {
    const cfg = yield* StackConfig;
    const proc = yield* Proc.Service;

    const originUrl = yield* proc
      .exec(cfg.root, "git", ["remote", "get-url", "origin"], [0, 1])
      .pipe(Effect.catch(() => Effect.succeed("")));
    const ado = CodeHost.adoRemoteInfo(originUrl.trim());
    if (!ado) {
      return yield* Effect.fail(
        new CodeHostDecodeError(
          "az",
          ["repos", "pr"],
          originUrl,
          "unable to parse Azure DevOps organization, project, and repository from origin",
        ),
      );
    }

    const run = Effect.fn("CodeHost.azuredevops.run")(function* (
      args: ReadonlyArray<string>,
      ok: ReadonlyArray<number> = [0],
    ) {
      return yield* proc.exec(cfg.root, "az", args, ok);
    });

    const changeUrlBase =
      CodeHost.adoChangeUrlBase(originUrl.trim()) ??
      `${ado.organizationUrl}/${ado.project}/_git/${ado.repository}/pullrequest`;

    const runListPage = Effect.fn("CodeHost.azuredevops.runListPage")(function* (
      args: ReadonlyArray<string>,
    ) {
      const out = yield* run(args, [0, 1]);
      return yield* decodePRList(args, out, changeUrlBase);
    });

    const changes = Effect.fn("CodeHost.azuredevops.changes")(function* () {
      const collected: Array<PullRef> = [];
      for (let skip = 0; ; skip += 100) {
        const args = repoScope(ado, [
          "list",
          "--status",
          "active",
          "--output",
          "json",
          "--top",
          "100",
          "--skip",
          `${skip}`,
        ]);
        const rows = yield* runListPage(args);
        if (rows.length === 0) break;
        collected.push(...rows.map(listRef));
        if (rows.length < 100) break;
      }
      return collected;
    });

    const change = Effect.fn("CodeHost.azuredevops.change")((pr: number) => {
      const args = prScope(ado.organizationUrl, ["show", "--id", `${pr}`, "--output", "json"]);
      return run(args).pipe(
        Effect.catchIf(missingPull, () => Effect.fail(new CodeHostChangeNotFoundError(pr))),
        Effect.flatMap((out) => decodePRView(args, out, changeUrlBase)),
        Effect.map(meta),
      );
    });

    const auto = Effect.fn("CodeHost.azuredevops.auto")((pr: number) =>
      run(
        prScope(ado.organizationUrl, [
          "update",
          "--id",
          `${pr}`,
          "--auto-complete",
          "true",
          "--squash",
          "true",
        ]),
      ).pipe(Effect.asVoid),
    );

    const merge = Effect.fn("CodeHost.azuredevops.merge")(function* (
      pr: number,
      opts?: { readonly admin?: boolean },
    ) {
      if (opts?.admin) {
        return yield* Effect.fail(new UnsupportedCodeHostOperation("azuredevops", "admin merge"));
      }
      yield* run(
        prScope(ado.organizationUrl, [
          "update",
          "--id",
          `${pr}`,
          "--status",
          "completed",
          "--squash",
          "true",
        ]),
      );
    });

    const wait = Effect.fn("CodeHost.azuredevops.wait")((pr: number) =>
      Effect.gen(function* () {
        for (;;) {
          const args = prScope(ado.organizationUrl, ["show", "--id", `${pr}`, "--output", "json"]);
          const out = yield* run(args);
          const row = yield* decodePRWatch(args, out);

          if (row.status === "completed") return;
          if (row.status === "abandoned") {
            return yield* Effect.fail(
              new ExecError(
                "az",
                ["repos", "pr", "show", `${pr}`],
                1,
                `PR #${pr} closed without merging`,
              ),
            );
          }

          yield* Effect.sleep(cfg.codeHostWaitIntervalMillis);
        }
      }),
    );

    const edit = Effect.fn("CodeHost.azuredevops.edit")((pr: number, base: string) =>
      run(retargetArgs(ado, pr, base)).pipe(Effect.asVoid),
    );

    const body = Effect.fn("CodeHost.azuredevops.body")((pr: number, body: string) =>
      run(prScope(ado.organizationUrl, ["update", "--id", `${pr}`, "--description", body])).pipe(
        Effect.asVoid,
      ),
    );

    const close = Effect.fn("CodeHost.azuredevops.close")((pr: number) =>
      run(prScope(ado.organizationUrl, ["update", "--id", `${pr}`, "--status", "abandoned"])).pipe(
        Effect.asVoid,
      ),
    );

    const create = Effect.fn("CodeHost.azuredevops.create")(function* (
      branch: string,
      base: string,
      title: string,
      body: string,
      labels: ReadonlyArray<string>,
      _headRepository?: string | null,
    ) {
      const args = repoScope(ado, [
        "create",
        "--source-branch",
        branch,
        "--target-branch",
        base,
        "--title",
        title,
        "--description",
        body,
        "--squash",
        "true",
        "--output",
        "json",
      ]);
      const out = yield* run(args);
      const row = yield* decodePRCreated(args, out);
      for (const label of labels) {
        yield* run(labelArgs(ado, row.pullRequestId, label)).pipe(Effect.catch(() => Effect.void));
      }
      return pullRef({
        number: row.pullRequestId,
        title: row.title,
        head: branchName(row.sourceRefName),
        headRepository: null,
        base: branchName(row.targetRefName),
        url: row.url,
        draft: row.isDraft,
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
    state: "active",
    url: (number) => `https://dev.azure.com/example/project/_git/repo/pullrequest/${number}`,
  });

export const decodePullListFixture = (
  args: ReadonlyArray<string>,
  out: string,
  urlBase = "https://dev.azure.com/example/project/_git/repo/pullrequest",
) => decodePRList(args, out, urlBase);

export const decodePullViewFixture = (
  args: ReadonlyArray<string>,
  out: string,
  urlBase = "https://dev.azure.com/example/project/_git/repo/pullrequest",
) => decodePRView(args, out, urlBase);

export * as CodeHostAzureDevOps from "./AzureDevOps.ts";
