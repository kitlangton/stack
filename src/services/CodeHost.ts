import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { CodeHostError, PullMeta, PullRef } from "../domain/model.ts";

export type Provider = "github" | "gitlab";

export interface Capabilities {
  readonly adminMerge: boolean;
}

export interface Interface {
  readonly provider: Provider;
  readonly capabilities: Capabilities;
  readonly requestLabel: "PR" | "MR";
  readonly reference: (number: number) => string;
  readonly repository: (remote: string, origin?: string) => string | null;
  readonly changeUrlBase: (remote: string) => string | null;
  readonly auto: (pr: number) => Effect.Effect<void, CodeHostError>;
  readonly merge: (
    pr: number,
    opts?: { readonly admin?: boolean },
  ) => Effect.Effect<void, CodeHostError>;
  readonly wait: (pr: number) => Effect.Effect<void, CodeHostError>;
  readonly changes: () => Effect.Effect<ReadonlyArray<PullRef>, CodeHostError>;
  readonly change: (number: number) => Effect.Effect<PullMeta, CodeHostError>;
  readonly edit: (pr: number, base: string) => Effect.Effect<void, CodeHostError>;
  readonly body: (pr: number, body: string) => Effect.Effect<void, CodeHostError>;
  readonly close: (pr: number) => Effect.Effect<void, CodeHostError>;
  readonly create: (
    branch: string,
    base: string,
    title: string,
    body: string,
    labels: ReadonlyArray<string>,
    headRepository?: string | null,
  ) => Effect.Effect<PullRef, CodeHostError>;
}

export type AdapterProperties = Pick<
  Interface,
  "provider" | "capabilities" | "requestLabel" | "reference" | "repository" | "changeUrlBase"
>;

export class Service extends Context.Service<Service, Interface>()("@stack/CodeHost") {}

export interface RemoteInfo {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

const trimGit = (value: string) => (value.endsWith(".git") ? value.slice(0, -4) : value);

const fromHostPath = (host: string, path: string): RemoteInfo | null => {
  const trimmed = trimGit(path.replace(/^\/+/, "").replace(/\/+$/, ""));
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1]!;
  const owner = segments.slice(0, -1).join("/");
  return { host, owner, repo };
};

export const remoteInfo = (remote: string): RemoteInfo | null => {
  const https = remote.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)\/?$/);
  if (https) return fromHostPath(https[1]!, https[2]!);
  const sshUrl = remote.match(/^(?:ssh|git\+ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)\/?$/);
  if (sshUrl) return fromHostPath(sshUrl[1]!, sshUrl[2]!);
  const scp = remote.match(/^[^@\s]+@([^:]+):(.+?)\/?$/);
  if (scp) return fromHostPath(scp[1]!, scp[2]!);
  return null;
};

export const detectProvider = (remote: string): Provider | null => {
  const host = remoteInfo(remote)?.host.replace(/:\d+$/, "").toLowerCase();
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  return null;
};

export const providerFrom = (value: string | undefined): Provider | null => {
  const lower = value?.trim().toLowerCase();
  if (lower === "github") return "github";
  if (lower === "gitlab") return "gitlab";
  return null;
};

export const repositoryFor = (remote: string, origin?: string): string | null => {
  const info = remoteInfo(remote);
  const originInfo = origin ? remoteInfo(origin) : null;
  if (info && originInfo && info.host.toLowerCase() !== originInfo.host.toLowerCase()) return null;
  return info ? `${info.owner}/${info.repo}` : null;
};

export * as CodeHost from "./CodeHost.ts";
