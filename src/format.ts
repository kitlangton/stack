import { StatusReport } from "./domain/model.ts";
import { treeFromStatus } from "./stackGraph.ts";
import * as Terminal from "./terminal.ts";

export interface RenderStatusOptions {
  readonly pretty?: boolean;
  readonly reference?: (number: number) => string;
  readonly requestLabel?: string;
}

const isBackup = (branch: string) => branch.startsWith("backup/");

const truncate = (text: string, max = 72) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const filterReport = (report: StatusReport) => {
  const nodes = new Map(report.nodes.map((node) => [String(node.branch), node]));
  const tree = treeFromStatus(report);
  const stacked = new Set<string>();
  for (const node of report.nodes) {
    const branch = String(node.branch);
    if (isBackup(branch)) continue;
    const hasChild = (tree.children.get(branch) ?? []).some((child) => !isBackup(child));
    if (hasChild || node.source !== "root") stacked.add(branch);
  }
  const keep = new Set<string>();
  const addAncestors = (name: string) => {
    for (let next: string | null = name; next; ) {
      if (keep.has(next)) break;
      keep.add(next);
      const parent: string | null = nodes.get(next)?.parent
        ? String(nodes.get(next)?.parent)
        : null;
      next = parent && nodes.has(String(parent)) ? String(parent) : null;
    }
  };
  const addDescendants = (name: string) => {
    if (isBackup(name)) return;
    keep.add(name);
    for (const child of tree.children.get(name) ?? []) addDescendants(child);
  };

  const current = nodes.get(report.current);
  const currentIsStack =
    current && !isBackup(String(current.branch)) && stacked.has(String(current.branch));

  if (currentIsStack) {
    addAncestors(report.current);
    addDescendants(report.current);
  } else {
    for (const node of report.nodes) {
      const branch = String(node.branch);
      if (isBackup(branch)) continue;
      if (stacked.has(branch)) addAncestors(branch);
    }
  }

  return new StatusReport({
    current: report.current,
    trunks: report.trunks,
    nodes: report.nodes.filter((node) => {
      const branch = String(node.branch);
      return keep.has(branch) && !isBackup(branch);
    }),
  });
};

export const renderStatus = (report: StatusReport, opts: RenderStatusOptions = {}) => {
  const tree = treeFromStatus(filterReport(report));
  const style = { pretty: opts.pretty ?? false };
  const reference = opts.reference ?? ((number: number) => `#${number}`);
  const requestLabel = opts.requestLabel ?? "PR";

  const lines: Array<string> = [];

  const renderNode = (name: string, prefix: string, connector: string) => {
    const node = tree.nodes.get(name);
    if (!node) return;
    const current = String(node.branch) === report.current;
    const branch = Terminal.paint(
      style,
      current ? Terminal.color.bold : Terminal.color.cyan,
      String(node.branch),
    );
    const pr = node.pr
      ? Terminal.link(
          style,
          node.url ? String(node.url) : null,
          Terminal.paint(style, Terminal.color.magenta, reference(Number(node.pr))),
        )
      : null;
    const url = node.url ? String(node.url) : null;
    const source =
      node.source === "inferred"
        ? ` ${Terminal.paint(style, Terminal.color.yellow, "inferred")}`
        : "";
    const issues =
      node.issues.length > 0
        ? ` ${Terminal.paint(style, Terminal.color.red, `[${node.issues.join(", ")}]`)}`
        : "";
    const marker = current ? ` ${Terminal.paint(style, Terminal.color.green, "👈 current")}` : "";
    lines.push(`${prefix}${connector} ${branch}${marker}${source}${issues}`);
    if (pr) {
      lines.push(
        `${prefix}   ${requestLabel}: ${pr}${url ? ` ${Terminal.paint(style, Terminal.color.dim, url)}` : ""}`,
      );
    }
    if (node.title) {
      lines.push(`${prefix}   Title: ${truncate(String(node.title))}`);
    }
    if (node.base) {
      lines.push(
        `${prefix}   Base: ${Terminal.paint(style, Terminal.color.green, String(node.base))}`,
      );
    }
    if (node.checks) {
      const statusColor = node.checks.includes("failed")
        ? Terminal.color.red
        : node.checks.includes("pending")
          ? Terminal.color.yellow
          : Terminal.color.green;
      lines.push(`${prefix}   CI: ${Terminal.paint(style, statusColor, node.checks)}`);
    }
  };

  const walk = (name: string, prefix: string, last: boolean) => {
    const node = tree.nodes.get(name);
    if (!node) return;
    renderNode(name, prefix, last ? "└─" : "├─");
    const kids = tree.children.get(name) ?? [];
    kids.forEach((child, index) =>
      walk(child, `${prefix}${last ? "   " : "│  "}`, index === kids.length - 1),
    );
  };

  const trunk = Terminal.paint(style, Terminal.color.dim, tree.trunk);
  lines.push(trunk);
  if (tree.roots.length === 0) return `${trunk}\n└─ (no matching stack branches)`;
  tree.roots.forEach((root, index) => walk(root, "", index === tree.roots.length - 1));
  return lines.length > 0 ? lines.join("\n") : "(no matching stack branches)";
};

export const renderDiagram = (
  report: StatusReport,
  reference: (number: number) => string = (number) => `#${number}`,
) => {
  const tree = treeFromStatus(report);

  const label = (name: string) => {
    const node = tree.nodes.get(name);
    if (!node) return name;
    const pr = node.pr ? ` ${reference(Number(node.pr))}` : "";
    const current = node.branch === report.current ? " ← current" : "";
    const source = node.source === "inferred" ? " (inferred)" : "";
    const issues = node.issues.length > 0 ? ` [${node.issues.join(", ")}]` : "";
    return `${node.branch}${pr}${source}${issues}${current}`;
  };

  const lines = [tree.trunk];
  const walk = (name: string, prefix: string, last: boolean) => {
    lines.push(`${prefix}${last ? "└─" : "├─"} ${label(name)}`);
    const kids = tree.children.get(name) ?? [];
    kids.forEach((child, index) =>
      walk(child, `${prefix}${last ? "   " : "│  "}`, index === kids.length - 1),
    );
  };

  if (tree.roots.length === 0) return `${lines[0]}\n└─ (no open stack branches)`;
  tree.roots.forEach((root, index) => walk(root, "", index === tree.roots.length - 1));
  return lines.join("\n");
};
