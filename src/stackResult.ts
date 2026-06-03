import type { StackLink } from "./domain/model.ts";

export type Mode = "apply" | "dry-run";

export type StackResultItem =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Track"; readonly link: StackLink }
  | {
      readonly _tag: "RemoveLink";
      readonly mode: Mode;
      readonly branch: string;
      readonly reason: string;
    }
  | {
      readonly _tag: "UpdateLink";
      readonly mode: Mode;
      readonly branch: string;
      readonly from: string;
      readonly to: string;
      readonly anchor: string;
    }
  | {
      readonly _tag: "Reparent";
      readonly mode: Mode;
      readonly branch: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly _tag: "Backup";
      readonly mode: Mode;
      readonly branch: string;
      readonly backup: string;
    }
  | {
      readonly _tag: "Rebase";
      readonly mode: Mode;
      readonly branch: string;
      readonly parent: string;
    }
  | {
      readonly _tag: "Push";
      readonly mode: Mode;
      readonly branch: string;
      readonly remotes: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "RetargetPull";
      readonly mode: Mode;
      readonly pr: number;
      readonly base: string;
    }
  | {
      readonly _tag: "CreatePull";
      readonly mode: Mode;
      readonly branch: string;
      readonly base: string;
      readonly pr: number | null;
    }
  | { readonly _tag: "UpdateStackLinks"; readonly mode: Mode; readonly pr: number };

export const text = (value: string): StackResultItem => ({
  _tag: "Text",
  text: value,
});

export const track = (link: StackLink): StackResultItem => ({
  _tag: "Track",
  link,
});

const prefix = (mode: Mode) => (mode === "apply" ? "" : "would ");

export const render = (
  item: StackResultItem,
  reference: (number: number) => string = (number) => `#${number}`,
  requestLabel = "PR",
) => {
  switch (item._tag) {
    case "Text":
      return item.text;
    case "Track":
      return `infer link: ${item.link.branch} -> ${item.link.parent} @ ${item.link.anchor}`;
    case "RemoveLink":
      return `${prefix(item.mode)}remove stale link: ${item.branch} (${item.reason})`;
    case "UpdateLink":
      return `${prefix(item.mode)}update link: ${item.branch} ${item.from} -> ${item.to} @ ${item.anchor}`;
    case "Reparent":
      return `${prefix(item.mode)}reparent ${item.branch}: ${item.from} -> ${item.to}`;
    case "Backup":
      return `${prefix(item.mode)}backup ${item.branch} -> ${item.backup}`;
    case "Rebase":
      return `${prefix(item.mode)}rebase ${item.branch} onto ${item.parent}`;
    case "Push":
      return item.remotes.length === 1 && item.remotes[0] === "origin"
        ? `${prefix(item.mode)}push ${item.branch}`
        : `${prefix(item.mode)}push ${item.branch} to ${item.remotes.join(", ")}`;
    case "RetargetPull":
      return `${prefix(item.mode)}retarget ${reference(item.pr)} to ${item.base}`;
    case "CreatePull":
      return item.mode === "apply" && item.pr !== null
        ? `create ${requestLabel.toLowerCase()} ${reference(item.pr)} for ${item.branch} -> ${item.base}`
        : `would create ${requestLabel.toLowerCase()} for ${item.branch} -> ${item.base}`;
    case "UpdateStackLinks":
      return `${item.mode === "apply" ? "update" : "would update"} ${requestLabel} body: ${reference(item.pr)} Stack block`;
  }
};

export const renderAll = (
  items: ReadonlyArray<StackResultItem>,
  reference?: (number: number) => string,
  requestLabel?: string,
) => items.map((item) => render(item, reference, requestLabel));
