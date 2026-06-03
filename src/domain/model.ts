import * as Schema from "effect/Schema";

export type Issue = "base-mismatch" | "cycle" | "inferred-parent" | "missing-parent";

export type Source = "explicit" | "inferred" | "root";

export const version = 1;

export const BranchName = Schema.String.pipe(Schema.brand("BranchName"));
export type BranchName = typeof BranchName.Type;

export const PullUrl = Schema.String.pipe(Schema.brand("PullUrl"));
export type PullUrl = typeof PullUrl.Type;

export const PrNumber = Schema.Int.pipe(Schema.brand("PrNumber"));
export type PrNumber = typeof PrNumber.Type;

export const branchName = Schema.decodeSync(BranchName);
export const pullUrl = Schema.decodeSync(PullUrl);
export const prNumber = Schema.decodeSync(PrNumber);

export const issues: ReadonlyArray<Issue> = [
  "base-mismatch",
  "cycle",
  "inferred-parent",
  "missing-parent",
];

export class BranchRef extends Schema.Class<BranchRef>("BranchRef")({
  name: BranchName,
  head: Schema.String,
}) {}

export class PullRef extends Schema.Class<PullRef>("PullRef")({
  number: PrNumber,
  title: Schema.NullOr(Schema.String),
  head: BranchName,
  headRepository: Schema.NullOr(Schema.String),
  base: BranchName,
  url: PullUrl,
  draft: Schema.Boolean,
  checks: Schema.NullOr(Schema.String),
}) {}

export class PullLabel extends Schema.Class<PullLabel>("PullLabel")({
  name: Schema.String,
}) {}

export class PullMeta extends Schema.Class<PullMeta>("PullMeta")({
  number: PrNumber,
  title: Schema.String,
  body: Schema.String,
  head: BranchName,
  headRepository: Schema.NullOr(Schema.String),
  base: BranchName,
  url: PullUrl,
  draft: Schema.Boolean,
  state: Schema.String,
  labels: Schema.Array(PullLabel),
}) {}

export class StackLink extends Schema.Class<StackLink>("StackLink")({
  branch: BranchName,
  parent: BranchName,
  anchor: Schema.String,
  pr: Schema.NullOr(PrNumber),
  headRepository: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class StackState extends Schema.Class<StackState>("StackState")({
  version: Schema.Literal(version),
  links: Schema.Array(StackLink),
}) {}

export class UndoEntry extends Schema.Class<UndoEntry>("UndoEntry")({
  branch: BranchName,
  backup: Schema.NullOr(BranchName),
  pr: Schema.NullOr(PrNumber),
  base: Schema.NullOr(BranchName),
  created: Schema.NullOr(PrNumber),
  pushRemotes: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class UndoState extends Schema.Class<UndoState>("UndoState")({
  version: Schema.Literal(version),
  at: Schema.String,
  state: StackState,
  entries: Schema.Array(UndoEntry),
  actions: Schema.Array(Schema.String),
}) {}

export class StatusNode extends Schema.Class<StatusNode>("StatusNode")({
  branch: BranchName,
  head: Schema.String,
  parent: Schema.NullOr(BranchName),
  anchor: Schema.NullOr(Schema.String),
  pr: Schema.NullOr(PrNumber),
  title: Schema.NullOr(Schema.String),
  url: Schema.NullOr(PullUrl),
  checks: Schema.NullOr(Schema.String),
  base: Schema.NullOr(BranchName),
  draft: Schema.Boolean,
  source: Schema.Union([
    Schema.Literal("explicit"),
    Schema.Literal("inferred"),
    Schema.Literal("root"),
  ]),
  issues: Schema.Array(
    Schema.Union([
      Schema.Literal("base-mismatch"),
      Schema.Literal("cycle"),
      Schema.Literal("inferred-parent"),
      Schema.Literal("missing-parent"),
    ]),
  ),
}) {}

export class StatusReport extends Schema.Class<StatusReport>("StatusReport")({
  current: Schema.String,
  trunks: Schema.Array(BranchName),
  nodes: Schema.Array(StatusNode),
}) {}

export class ExecError extends Schema.TaggedErrorClass<ExecError>()("ExecError", {
  tool: Schema.String,
  args: Schema.Array(Schema.String),
  code: Schema.Number,
  stderr: Schema.String,
  message: Schema.String,
}) {
  constructor(
    readonly tool: string,
    readonly args: ReadonlyArray<string>,
    readonly code: number,
    readonly stderr: string,
  ) {
    super({
      tool,
      args: Array.from(args),
      code,
      stderr,
      message: `${tool} ${args.join(" ")} failed (${code})`,
    });
  }
}

export class StateError extends Schema.TaggedErrorClass<StateError>()("StateError", {
  path: Schema.String,
  op: Schema.String,
  detail: Schema.String,
  message: Schema.String,
}) {
  constructor(
    readonly path: string,
    readonly op: string,
    readonly detail: string,
  ) {
    super({ path, op, detail, message: `${op} ${path}: ${detail}` });
  }
}

export class BranchError extends Schema.TaggedErrorClass<BranchError>()("BranchError", {
  branch: Schema.String,
  message: Schema.String,
}) {
  constructor(readonly branch: string) {
    super({ branch, message: `unknown branch: ${branch}` });
  }
}

export class MergeBaseError extends Schema.TaggedErrorClass<MergeBaseError>()("MergeBaseError", {
  branch: Schema.String,
  parent: Schema.String,
  message: Schema.String,
}) {
  constructor(
    readonly branch: string,
    readonly parent: string,
  ) {
    super({ branch, parent, message: `no merge base for ${branch} and ${parent}` });
  }
}

export class DirtyWorktreeError extends Schema.TaggedErrorClass<DirtyWorktreeError>()(
  "DirtyWorktreeError",
  {
    lines: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {
  constructor(readonly lines: ReadonlyArray<string>) {
    super({
      lines: Array.from(lines),
      message: lines.length > 0 ? `worktree is dirty:\n${lines.join("\n")}` : "worktree is dirty",
    });
  }
}

export class StackOperationError extends Schema.TaggedErrorClass<StackOperationError>()(
  "StackOperationError",
  {
    message: Schema.String,
  },
) {
  constructor(message: string) {
    super({ message });
  }
}

export class CodeHostDecodeError extends Schema.TaggedErrorClass<CodeHostDecodeError>()(
  "CodeHostDecodeError",
  {
    tool: Schema.String,
    args: Schema.Array(Schema.String),
    output: Schema.String,
    detail: Schema.String,
    message: Schema.String,
  },
) {
  constructor(
    readonly tool: string,
    readonly args: ReadonlyArray<string>,
    readonly output: string,
    readonly detail: string,
  ) {
    super({
      tool,
      args: Array.from(args),
      output,
      detail,
      message: `${tool} ${args.join(" ")} returned invalid JSON`,
    });
  }
}

export class CodeHostChangeNotFoundError extends Schema.TaggedErrorClass<CodeHostChangeNotFoundError>()(
  "CodeHostChangeNotFoundError",
  {
    number: Schema.Number,
    message: Schema.String,
  },
) {
  constructor(readonly number: number) {
    super({ number, message: `change ${number} was not found` });
  }
}

export class UnsupportedCodeHostOperation extends Schema.TaggedErrorClass<UnsupportedCodeHostOperation>()(
  "UnsupportedCodeHostOperation",
  {
    provider: Schema.String,
    operation: Schema.String,
    message: Schema.String,
  },
) {
  constructor(
    readonly provider: string,
    readonly operation: string,
  ) {
    super({ provider, operation, message: `${operation} is not supported by ${provider}` });
  }
}

export type StoreError = StateError;
export type CodeHostError =
  | ExecError
  | CodeHostDecodeError
  | CodeHostChangeNotFoundError
  | UnsupportedCodeHostOperation;
export type StackError =
  | ExecError
  | CodeHostDecodeError
  | CodeHostChangeNotFoundError
  | UnsupportedCodeHostOperation
  | StateError
  | BranchError
  | MergeBaseError
  | DirtyWorktreeError
  | StackOperationError;

export const stackState = (links: ReadonlyArray<StackLink>) =>
  new StackState({ version, links: Array.from(links) });

export const branchRef = (value: { name: string; head: string }) =>
  new BranchRef({ name: branchName(value.name), head: value.head });

export const pullRef = (value: {
  number: number;
  title?: string | null;
  head: string;
  headRepository?: string | null;
  base: string;
  url: string;
  draft: boolean;
  checks?: string | null;
}) =>
  new PullRef({
    number: prNumber(value.number),
    title: value.title ?? null,
    head: branchName(value.head),
    headRepository: value.headRepository ?? null,
    base: branchName(value.base),
    url: pullUrl(value.url),
    draft: value.draft,
    checks: value.checks ?? null,
  });

export const pullMeta = (value: {
  number: number;
  title: string;
  body: string;
  head: string;
  headRepository?: string | null;
  base: string;
  url: string;
  draft: boolean;
  state: string;
  labels: ReadonlyArray<PullLabel>;
}) =>
  new PullMeta({
    number: prNumber(value.number),
    title: value.title,
    body: value.body,
    head: branchName(value.head),
    headRepository: value.headRepository ?? null,
    base: branchName(value.base),
    url: pullUrl(value.url),
    draft: value.draft,
    state: value.state,
    labels: Array.from(value.labels),
  });

export const stackLink = (value: {
  branch: string;
  parent: string;
  anchor: string;
  pr: number | null;
  headRepository?: string | null;
}) =>
  new StackLink({
    branch: branchName(value.branch),
    parent: branchName(value.parent),
    anchor: value.anchor,
    pr: value.pr === null ? null : prNumber(value.pr),
    ...(value.headRepository === undefined ? {} : { headRepository: value.headRepository }),
  });

export const undoEntry = (value: {
  branch: string;
  backup: string | null;
  pr: number | null;
  base: string | null;
  created: number | null;
  pushRemotes?: ReadonlyArray<string>;
}) =>
  new UndoEntry({
    branch: branchName(value.branch),
    backup: value.backup === null ? null : branchName(value.backup),
    pr: value.pr === null ? null : prNumber(value.pr),
    base: value.base === null ? null : branchName(value.base),
    created: value.created === null ? null : prNumber(value.created),
    ...(value.pushRemotes === undefined ? {} : { pushRemotes: Array.from(value.pushRemotes) }),
  });

export const undoState = (
  at: string,
  state: StackState,
  entries: ReadonlyArray<UndoEntry>,
  actions: ReadonlyArray<string>,
) =>
  new UndoState({
    version,
    at,
    state,
    entries: Array.from(entries),
    actions: Array.from(actions),
  });
