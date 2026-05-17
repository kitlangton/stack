import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ForgeError, PullMeta, PullRef } from "../domain/model.ts";

export interface Interface {
  readonly auto: (pr: number) => Effect.Effect<void, ForgeError>;
  readonly merge: (
    pr: number,
    opts?: { readonly admin?: boolean },
  ) => Effect.Effect<void, ForgeError>;
  readonly wait: (pr: number) => Effect.Effect<void, ForgeError>;
  readonly pulls: () => Effect.Effect<ReadonlyArray<PullRef>, ForgeError>;
  readonly pull: (pr: number) => Effect.Effect<PullMeta, ForgeError>;
  readonly edit: (pr: number, base: string) => Effect.Effect<void, ForgeError>;
  readonly body: (pr: number, body: string) => Effect.Effect<void, ForgeError>;
  readonly close: (pr: number) => Effect.Effect<void, ForgeError>;
  readonly create: (
    branch: string,
    base: string,
    title: string,
    body: string,
    labels: ReadonlyArray<string>,
  ) => Effect.Effect<PullRef, ForgeError>;
}

export class Service extends Context.Service<Service, Interface>()("@stack/Forge") {}

export type ForgeKind = "github" | "gitlab";

export interface RemoteInfo {
  readonly kind: ForgeKind;
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

const trimGit = (value: string) => (value.endsWith(".git") ? value.slice(0, -4) : value);

const classify = (host: string): ForgeKind | null => {
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return null;
};

const fromHostPath = (host: string, path: string): RemoteInfo | null => {
  const kind = classify(host);
  if (!kind) return null;
  const trimmed = trimGit(path.replace(/^\/+/, "").replace(/\/+$/, ""));
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1]!;
  const owner = segments.slice(0, -1).join("/");
  return { kind, host, owner, repo };
};

export const detect = (remote: string): RemoteInfo | null => {
  const https = remote.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)\/?$/);
  if (https) {
    const info = fromHostPath(https[1]!, https[2]!);
    if (info) return info;
  }
  const sshUrl = remote.match(/^(?:ssh|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)\/?$/);
  if (sshUrl) {
    const info = fromHostPath(sshUrl[1]!, sshUrl[2]!);
    if (info) return info;
  }
  const scp = remote.match(/^[^@\s]+@([^:]+):(.+?)\/?$/);
  if (scp) {
    const info = fromHostPath(scp[1]!, scp[2]!);
    if (info) return info;
  }
  return null;
};

export const fromEnv = (value: string | undefined): ForgeKind | null => {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "github") return "github";
  if (lower === "gitlab") return "gitlab";
  return null;
};

export const pullUrlBase = (info: RemoteInfo): string => {
  switch (info.kind) {
    case "github":
      return `https://${info.host}/${info.owner}/${info.repo}/pull`;
    case "gitlab":
      return `https://${info.host}/${info.owner}/${info.repo}/-/merge_requests`;
  }
};

export const pullUrlBaseFor = (remote: string): string | null => {
  const info = detect(remote);
  return info ? pullUrlBase(info) : null;
};
