import {
  BranchRef,
  branchName,
  pullUrl,
  PullRef,
  type Issue,
  type Source,
  type StackState,
  StatusNode,
  StatusReport,
} from "./domain/model.ts";

export interface StackGraphInput {
  readonly state: StackState;
  readonly refs: ReadonlyArray<BranchRef>;
  readonly pulls: ReadonlyArray<PullRef>;
  readonly prUrls?: ReadonlyMap<number, string>;
  readonly trunks: ReadonlyArray<string>;
  readonly current: string;
}

export interface StatusTree {
  readonly trunk: string;
  readonly nodes: ReadonlyMap<string, StatusNode>;
  readonly roots: ReadonlyArray<string>;
  readonly children: ReadonlyMap<string, ReadonlyArray<string>>;
}

export interface StackGraph {
  readonly report: StatusReport;
  readonly tree: StatusTree;
  readonly explicitChainFor: (branch: string) => ReadonlyArray<string>;
  readonly rank: (branch: string) => number;
  readonly rootOf: (branch: string) => string;
  readonly wouldCreateCycle: (branch: string, parent: string) => boolean;
}

const sort = <A extends string>(list: ReadonlyArray<A>) =>
  Array.from(list).sort((a, b) => a.localeCompare(b));

export const wouldCreateCycle = (
  links: ReadonlyMap<string, string>,
  trunks: ReadonlySet<string>,
  branch: string,
  parent: string,
) => {
  const nextLinks = new Map(links);
  nextLinks.set(branch, parent);
  for (let name = parent; ; ) {
    if (trunks.has(name)) return false;
    if (name === branch) return true;
    const next = nextLinks.get(name);
    if (!next) return false;
    name = next;
  }
};

export const treeFromStatus = (report: StatusReport): StatusTree => {
  const trunks = new Set(report.trunks.map(String));
  const nodes = new Map(report.nodes.map((node) => [String(node.branch), node]));
  const roots = new Array<string>();
  const children = new Map<string, Array<string>>();
  const referencedTrunk = report.trunks.find((name) =>
    report.nodes.some((node) => node.parent !== null && String(node.parent) === String(name)),
  );
  const trunk = String(referencedTrunk ?? report.trunks[0] ?? "root");

  for (const node of report.nodes) {
    const branch = String(node.branch);
    if (trunks.has(branch)) continue;
    const parent = node.parent ? String(node.parent) : trunk;
    if (!nodes.has(parent) || trunks.has(parent)) {
      roots.push(branch);
      continue;
    }

    const list = children.get(parent) ?? [];
    list.push(branch);
    children.set(parent, list);
  }

  roots.sort((a, b) => a.localeCompare(b));
  for (const list of children.values()) {
    list.sort((a, b) => a.localeCompare(b));
  }

  return { trunk, nodes, roots, children };
};

export const make = (input: StackGraphInput): StackGraph => {
  const trunks = new Set(input.trunks.map(String));
  const names = new Set(input.refs.map((ref) => String(ref.name)));
  const links = new Map(input.state.links.map((link) => [String(link.branch), link]));
  const parents = new Map(
    input.state.links.map((link) => [String(link.branch), String(link.parent)]),
  );
  const prs = new Map(input.pulls.map((pull) => [String(pull.head), pull]));
  const pullBases = new Map(input.pulls.map((pull) => [String(pull.head), String(pull.base)]));

  const linkUrl = (pr: number | null | undefined) => {
    const url = pr ? input.prUrls?.get(pr) : null;
    return url ? pullUrl(url) : null;
  };

  const rawNodes = input.refs.map((ref) => {
    const branch = String(ref.name);
    const link = links.get(branch) ?? null;
    const pr = prs.get(branch) ?? null;
    const hint =
      pr && names.has(String(pr.base)) && !trunks.has(String(pr.base)) && pr.base !== ref.name
        ? pr.base
        : null;
    const parent = link?.parent ?? hint;
    const source: Source = link ? "explicit" : parent ? "inferred" : "root";
    const errs: Array<Issue> = [];

    if (link && !names.has(String(link.parent)) && !trunks.has(String(link.parent))) {
      errs.push("missing-parent");
    }
    if (!link && hint) errs.push("inferred-parent");
    if (link && pr && pr.base !== link.parent) errs.push("base-mismatch");

    return new StatusNode({
      branch: ref.name,
      head: ref.head,
      parent,
      anchor: link?.anchor ?? null,
      pr: pr?.number ?? link?.pr ?? null,
      title: pr?.title ?? null,
      url: pr?.url ?? linkUrl(link?.pr ? Number(link.pr) : null) ?? null,
      checks: pr?.checks ?? null,
      base: pr?.base ?? null,
      draft: pr?.draft ?? false,
      source,
      issues: errs,
    });
  });

  const rawGraph = new Map(rawNodes.map((node) => [String(node.branch), node]));
  const ancestors = (name: string, seen = new Set<string>()): ReadonlyArray<string> => {
    if (seen.has(name)) return [name];
    const node = rawGraph.get(name);
    if (!node?.parent || !rawGraph.has(String(node.parent))) return [];
    seen.add(name);
    return [String(node.parent), ...ancestors(String(node.parent), seen)];
  };

  const nodes = rawNodes.map((node) =>
    ancestors(String(node.branch)).includes(String(node.branch))
      ? new StatusNode({ ...node, issues: sort([...node.issues, "cycle"]) })
      : new StatusNode({ ...node, issues: sort(node.issues) }),
  );

  const report = new StatusReport({
    current: input.current,
    trunks: input.trunks.map((name) => branchName(name)),
    nodes: [...nodes].sort((a, b) => a.branch.localeCompare(b.branch)),
  });
  const tree = treeFromStatus(report);

  const explicitChainFor = (branch: string) => {
    let root = branch;
    const seenRoots = new Set<string>();
    for (;;) {
      if (seenRoots.has(root)) break;
      seenRoots.add(root);
      const link = links.get(root);
      if (!link || trunks.has(String(link.parent))) break;
      root = String(link.parent);
    }

    const chain = [root];
    const seenChain = new Set(chain);
    for (;;) {
      const next = input.state.links.find(
        (link) => String(link.parent) === chain[chain.length - 1],
      );
      if (!next) break;
      const name = String(next.branch);
      if (seenChain.has(name)) break;
      seenChain.add(name);
      chain.push(name);
    }

    return chain;
  };

  const rank = (branch: string, seen = new Set<string>()): number => {
    if (seen.has(branch)) return 0;
    const link = links.get(branch);
    if (!link) return 0;
    if (trunks.has(String(link.parent))) return 1;
    seen.add(branch);
    return rank(String(link.parent), seen) + 1;
  };

  const rootOf = (start: string) => {
    let root = start;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(root)) return start;
      seen.add(root);
      const parent = parents.get(root) ?? pullBases.get(root) ?? null;
      if (!parent || trunks.has(parent)) return root;
      root = parent;
    }
  };

  return {
    report,
    tree,
    explicitChainFor,
    rank,
    rootOf,
    wouldCreateCycle: (branch: string, parent: string) =>
      wouldCreateCycle(parents, trunks, branch, parent),
  };
};
