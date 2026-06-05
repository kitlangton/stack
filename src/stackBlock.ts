import { PullMeta, PullRef } from "./domain/model.ts";

const start = "<!-- stack:links:start -->";
const end = "<!-- stack:links:end -->";
const heading = "### Stack";

const inlineTitle = (value: string | null) => {
  const title = value?.replace(/\s+/g, " ").trim();
  return title ? ` - ${title}` : "";
};

const format = (
  branch: string,
  prs: ReadonlyMap<string, PullRef>,
  metas: ReadonlyMap<string, PullMeta>,
  reference: (number: number) => string,
  showTitles: boolean,
) => {
  const pr = prs.get(branch);
  const meta = metas.get(branch);
  if (pr) {
    const ref = reference(Number(pr.number));
    return showTitles ? `${ref}${inlineTitle(pr.title ?? meta?.title ?? null)}` : ref;
  }
  if (meta) {
    const ref = reference(Number(meta.number));
    return showTitles ? `${ref}${inlineTitle(meta.title)}` : ref;
  }
  return `\`${branch}\``;
};

const completedLines = (
  body: string,
  liveKeys: ReadonlySet<string>,
  completedKeys: ReadonlySet<string>,
  completedTitles: ReadonlyMap<number, string>,
) => {
  const prior = body.match(new RegExp(`${start}([\\s\\S]*?)${end}`))?.[1];
  if (!prior) return [];
  return prior
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- [") || /^\d+\.\s+/.test(line))
    .flatMap((line) => {
      const checked = line.startsWith("- [x]");
      const numbered = /^\d+\.\s+/.test(line);
      const branch = line.match(/`([^`]+)`/)?.[1] ?? null;
      const pr = line.match(/[#!]\d+/)?.[0] ?? null;
      const key = branch ?? pr;
      if (!key || liveKeys.has(key)) return [];
      if (completedKeys.size > 0 && !numbered && !checked && !completedKeys.has(key)) {
        return [];
      }
      if (completedKeys.size === 0 && line.startsWith("- [") && !checked) {
        return [];
      }
      const cleaned = line
        .replace(/^- \[[ x]\]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replaceAll("**", "")
        .replace(/([#!]\d+)\s+`[^`]+`/g, "$1")
        .replace(/\s*(?:←|👈) current$/, "");
      const number = Number(pr?.slice(1));
      const title = Number.isInteger(number) ? completedTitles.get(number) : undefined;
      return [/[#!]\d+\s+-\s+/.test(cleaned) ? cleaned : `${cleaned}${inlineTitle(title ?? null)}`];
    });
};

export const references = (body: string) => {
  const prior = body.match(new RegExp(`${start}([\\s\\S]*?)${end}`))?.[1];
  if (!prior) return [];
  return [...new Set([...prior.matchAll(/[#!](\d+)/g)].map((match) => Number(match[1])))]
    .filter((number) => Number.isInteger(number))
    .sort((a, b) => a - b);
};

export const render = (opts: {
  readonly pulls: ReadonlyArray<PullRef>;
  readonly metas: ReadonlyMap<string, PullMeta>;
  readonly chain: ReadonlyArray<string>;
  readonly completed?: ReadonlySet<string>;
  readonly branch: string;
  readonly previous: string;
  readonly reference?: (number: number) => string;
  readonly showTitles?: boolean;
  readonly completedTitles?: ReadonlyMap<number, string>;
}) => {
  const reference = opts.reference ?? ((number: number) => `#${number}`);
  const showTitles = opts.showTitles ?? false;
  const prs = new Map(opts.pulls.map((pull) => [String(pull.head), pull]));
  const chain = opts.chain;
  const liveKeys = new Set(
    chain.flatMap((branch) => {
      const pr = prs.get(branch) ?? opts.metas.get(branch) ?? null;
      return pr ? [branch, `#${pr.number}`, `!${pr.number}`] : [branch];
    }),
  );
  const line = (name: string) => {
    const head = format(name, prs, opts.metas, reference, showTitles);
    if (name === opts.branch) return `**${head}** 👈 current`;
    return head;
  };
  const items = [
    ...completedLines(
      opts.previous,
      liveKeys,
      opts.completed ?? new Set(),
      showTitles ? (opts.completedTitles ?? new Map()) : new Map(),
    ),
    ...chain.map(line),
  ];

  return [start, heading, "", ...items.map((item, index) => `${index + 1}. ${item}`), end].join(
    "\n",
  );
};

export const splice = (body: string, next: string) => {
  const cleaned = body.replace(new RegExp(`${start}[\\s\\S]*?${end}\n*`, "g"), "").trimEnd();
  return cleaned ? `${cleaned}\n\n${next}` : next;
};
