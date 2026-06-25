import { describe, expect, it } from "@effect/vitest";
import { configuredTrunks } from "../src/cli.ts";

describe("configuredTrunks", () => {
  it("uses built-in trunks when no extra trunks are configured", () => {
    expect(configuredTrunks(undefined, "")).toEqual(["dev", "main", "master"]);
  });

  it("adds git configured trunks to built-in trunks", () => {
    expect(configuredTrunks(undefined, "develop\nmain\n")).toEqual([
      "dev",
      "main",
      "master",
      "develop",
    ]);
  });

  it("uses environment trunks instead of git config additions", () => {
    expect(configuredTrunks("develop,release", "staging")).toEqual([
      "dev",
      "main",
      "master",
      "develop",
      "release",
    ]);
  });
});
