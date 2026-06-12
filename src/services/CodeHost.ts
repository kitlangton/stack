import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { CodeHostError, PullMeta, PullRef } from "../domain/model.ts";

export type Provider = "github" | "gitlab" | "azuredevops";

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

export interface AdoRemoteInfo {
  readonly organizationUrl: string;
  readonly project: string;
  readonly repository: string;
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

const parseAdoGitPath = (path: string, organizationUrl: string): AdoRemoteInfo | null => {
  const normalized = trimGit(path.replace(/^\/+/, "").replace(/\/+$/, ""));
  const match = normalized.match(/^(.*)\/_git\/([^/]+)$/);
  if (!match) return null;
  const before = match[1]!;
  const repository = match[2]!;
  const segments = before.split("/").filter(Boolean);
  if (segments.length < 1) return null;
  const project = segments[segments.length - 1]!;
  return { organizationUrl, project, repository };
};

export const adoRemoteInfo = (remote: string): AdoRemoteInfo | null => {
  const devAzure = remote.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/(.+)$/i);
  if (devAzure) {
    const segments = devAzure[1]!.split("/").filter(Boolean);
    const org = segments[0];
    if (!org) return null;
    return parseAdoGitPath(devAzure[1]!, `https://dev.azure.com/${org}`);
  }

  const legacy = remote.match(/^https?:\/\/(?:[^@/]+@)?([^.]+)\.visualstudio\.com\/(.+)$/i);
  if (legacy) {
    return parseAdoGitPath(legacy[2]!, `https://dev.azure.com/${legacy[1]}`);
  }

  const ssh = remote.match(/^[^@\s]+@ssh\.dev\.azure\.com:v3\/(.+?)\/?$/i);
  if (ssh) {
    const parts = ssh[1]!.split("/").filter(Boolean);
    if (parts.length < 3) return null;
    const [org, project, repository] = parts;
    return {
      organizationUrl: `https://dev.azure.com/${org}`,
      project: project!,
      repository: trimGit(repository!),
    };
  }

  const https = remote.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)\/?$/);
  if (https && !/^dev\.azure\.com$/i.test(https[1]!.replace(/:\d+$/, ""))) {
    const host = https[1]!.replace(/:\d+$/, "");
    const path = https[2]!;
    if (!path.includes("_git/")) return null;
    const segments = path.split("/").filter(Boolean);
    const collection = segments[0];
    if (!collection) return null;
    return parseAdoGitPath(path, `https://${host}/${collection}`);
  }

  return null;
};

export const adoChangeUrlBase = (remote: string): string | null => {
  const info = adoRemoteInfo(remote);
  return info
    ? `${info.organizationUrl}/${info.project}/_git/${info.repository}/pullrequest`
    : null;
};

export const detectProvider = (remote: string): Provider | null => {
  const lower = remote.toLowerCase();
  if (lower.includes("dev.azure.com") || lower.includes("ssh.dev.azure.com")) {
    return "azuredevops";
  }
  if (lower.includes(".visualstudio.com") && adoRemoteInfo(remote) !== null) {
    return "azuredevops";
  }
  const host = remoteInfo(remote)?.host.replace(/:\d+$/, "").toLowerCase();
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  return null;
};

export const providerFrom = (value: string | undefined): Provider | null => {
  const lower = value?.trim().toLowerCase();
  if (lower === "github") return "github";
  if (lower === "gitlab") return "gitlab";
  if (lower === "azuredevops" || lower === "ado") return "azuredevops";
  return null;
};

export const repositoryFor = (remote: string, origin?: string): string | null => {
  const ado = adoRemoteInfo(remote);
  const originAdo = origin ? adoRemoteInfo(origin) : null;
  if (ado) {
    if (
      originAdo &&
      ado.organizationUrl.toLowerCase() !== originAdo.organizationUrl.toLowerCase()
    ) {
      return null;
    }
    return `${ado.project}/${ado.repository}`.toLowerCase();
  }
  const info = remoteInfo(remote);
  const originInfo = origin ? remoteInfo(origin) : null;
  if (info && originInfo && info.host.toLowerCase() !== originInfo.host.toLowerCase()) return null;
  return info ? `${info.owner}/${info.repo}` : null;
};

export * as CodeHost from "./CodeHost.ts";
