import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  pickWindowsAzExecutable,
  resolveWindowsAzFromInstall,
  spawnCommand,
} from "../src/platform/proc.ts";

describe("pickWindowsAzExecutable", () => {
  it("prefers az.cmd over other where results", () => {
    const picked = pickWindowsAzExecutable([
      "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az",
      "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd",
      "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.bat",
    ]);
    expect(picked).toMatch(/az\.cmd$/i);
  });

  it("falls back to the first line when no cmd shim exists", () => {
    expect(pickWindowsAzExecutable(["C:\\tools\\az.bat", "C:\\tools\\az"])).toBe("C:\\tools\\az.bat");
    expect(pickWindowsAzExecutable(["C:\\tools\\az"])).toBe("C:\\tools\\az");
  });

  it("returns null for empty output", () => {
    expect(pickWindowsAzExecutable([])).toBeNull();
    expect(pickWindowsAzExecutable(["", "  "])).toBeNull();
  });
});

describe("resolveWindowsAzFromInstall", () => {
  it("returns null when bundled python.exe is missing", () => {
    expect(resolveWindowsAzFromInstall("C:\\missing\\az.cmd")).toBeNull();
  });
});

describe("spawnCommand", () => {
  it("leaves non-az tools unchanged", () => {
    const spawned = spawnCommand("git", ["status"], "C:\\repo");
    expect(spawned.command).toBe("git");
    expect(spawned.args).toEqual(["status"]);
  });

  it("merges Windows UTF-8 env for az on win32", () => {
    if (process.platform !== "win32") return;
    const spawned = spawnCommand("az", ["account", "show"], "C:\\repo");
    expect(spawned.options.extendEnv).toBe(true);
    expect(spawned.options.env).toMatchObject({
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      AZURE_CORE_NO_COLOR: "true",
    });
  });

  it("uses python -m azure.cli when install layout matches Azure CLI", () => {
    if (process.platform !== "win32") return;
    const azCmd = findWindowsAzOnPath();
    if (!azCmd) return;
    const resolved = resolveWindowsAzFromInstall(azCmd);
    if (!resolved) return;
    const spawned = spawnCommand("az", ["repos", "pr", "list"], "C:\\repo");
    expect(spawned.command).toBe(resolved.command);
    expect(spawned.args.slice(0, 4)).toEqual(["-X", "utf8", "-IBm", "azure.cli"]);
    expect(spawned.args.slice(4)).toEqual(["repos", "pr", "list"]);
  });
});

const findWindowsAzOnPath = (): string | null => {
  try {
    const out = execFileSync("where", ["az"], { encoding: "utf8", windowsHide: true });
    return pickWindowsAzExecutable(out.split(/\r?\n/));
  } catch {
    return null;
  }
};
