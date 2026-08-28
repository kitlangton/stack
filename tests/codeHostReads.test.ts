import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { CodeHostDecodeError, ExecError } from "../src/domain/model.ts";
import * as Proc from "../src/platform/proc.ts";
import { CodeHost } from "../src/services/CodeHost.ts";
import { StackConfig } from "../src/services/Config.ts";
import { CodeHostGitHub } from "../src/services/code-host/GitHub.ts";
import { CodeHostGitLab } from "../src/services/code-host/GitLab.ts";

const github = {
  number: 1,
  title: "topic",
  body: "",
  head: { ref: "topic", repo: null },
  base: { ref: "main" },
  html_url: "https://example.com/1",
  draft: false,
  labels: [],
};
const gitlab = {
  iid: 1,
  title: "topic",
  description: "",
  source_branch: "topic",
  target_branch: "main",
  web_url: "https://example.com/1",
  draft: false,
  state: "opened",
  labels: [],
  source_project_id: null,
};
const cfg = StackConfig.layer({ root: "/repo" }).pipe(Layer.provide(NodeServices.layer));

for (const [provider, adapter] of [
  ["github", CodeHostGitHub.layer],
  ["gitlab", CodeHostGitLab.layer],
] as const) {
  describe(`${provider} read recovery`, () => {
    for (const operation of ["changes", "change", "wait"] as const) {
      it.effect(`retries a timed-out ${operation} read after backoff`, () => {
        let calls = 0;
        const proc = Layer.succeed(Proc.Service, {
          exec: (_cwd, tool, args) =>
            Effect.gen(function* () {
              calls += 1;
              if (calls === 1)
                return yield* Effect.fail(
                  new ExecError(tool, args, 1, "net/http: TLS handshake timeout"),
                );
              return JSON.stringify(
                operation === "wait"
                  ? provider === "github"
                    ? { state: "MERGED", mergedAt: "now" }
                    : { state: "merged", merged_at: "now" }
                  : operation === "changes"
                    ? provider === "github"
                      ? [[github]]
                      : gitlab
                    : provider === "github"
                      ? github
                      : gitlab,
              );
            }),
        });
        return Effect.gen(function* () {
          const host = yield* CodeHost.Service;
          const request =
            operation === "changes"
              ? host.changes()
              : operation === "change"
                ? host.change(1)
                : host.wait(1);
          const fiber = yield* request.pipe(Effect.forkChild({ startImmediately: true }));
          expect(calls).toBe(1);
          yield* TestClock.adjust("500 millis");
          expect(calls).toBe(1);
          yield* TestClock.adjust("10 seconds");
          yield* Fiber.join(fiber);
          expect(calls).toBe(2);
        }).pipe(Effect.provide(adapter.pipe(Layer.provide(cfg), Layer.provide(proc))));
      });
    }

    it.effect("stops after three failed read attempts and preserves the last error", () => {
      let calls = 0;
      const error = new ExecError(provider, ["api"], 1, "i/o timeout");
      const proc = Layer.succeed(Proc.Service, {
        exec: () =>
          Effect.gen(function* () {
            calls += 1;
            return yield* Effect.fail(error);
          }),
      });
      return Effect.gen(function* () {
        const host = yield* CodeHost.Service;
        const fiber = yield* Effect.flip(host.changes()).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(fiber)).toBe(error);
        expect(calls).toBe(3);
      }).pipe(Effect.provide(adapter.pipe(Layer.provide(cfg), Layer.provide(proc))));
    });

    it.effect("does not retry authentication errors or invalid JSON", () => {
      let calls = 0;
      let invalidJson = false;
      const error = new ExecError(provider, ["api"], 1, "HTTP 403: forbidden");
      const proc = Layer.succeed(Proc.Service, {
        exec: () =>
          Effect.gen(function* () {
            calls += 1;
            return invalidJson ? "invalid JSON" : yield* Effect.fail(error);
          }),
      });
      return Effect.gen(function* () {
        const host = yield* CodeHost.Service;
        expect(yield* Effect.flip(host.changes())).toBe(error);
        expect(calls).toBe(1);
        invalidJson = true;
        expect(yield* Effect.flip(host.changes())).toBeInstanceOf(CodeHostDecodeError);
        expect(calls).toBe(2);
      }).pipe(Effect.provide(adapter.pipe(Layer.provide(cfg), Layer.provide(proc))));
    });

    it.effect("never retries mutations whose timeout could follow a successful write", () => {
      let calls = 0;
      const error = new ExecError(provider, ["write"], 1, "i/o timeout");
      const proc = Layer.succeed(Proc.Service, {
        exec: () =>
          Effect.gen(function* () {
            calls += 1;
            return yield* Effect.fail(error);
          }),
      });
      return Effect.gen(function* () {
        const host = yield* CodeHost.Service;
        const writes = [
          host.auto(1),
          host.merge(1),
          host.edit(1, "main"),
          host.body(1, "body"),
          host.close(1),
          host.create("topic", "main", "title", "body", []),
        ];
        for (const write of writes) expect(yield* Effect.flip(write)).toBe(error);
        expect(calls).toBe(writes.length);
      }).pipe(Effect.provide(adapter.pipe(Layer.provide(cfg), Layer.provide(proc))));
    });

    it.effect("cancelling a delayed read prevents further attempts", () => {
      let calls = 0;
      const proc = Layer.succeed(Proc.Service, {
        exec: () =>
          Effect.gen(function* () {
            calls += 1;
            return yield* Effect.fail(new ExecError(provider, ["api"], 1, "i/o timeout"));
          }),
      });
      return Effect.gen(function* () {
        const host = yield* CodeHost.Service;
        const fiber = yield* host.changes().pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust("10 seconds");
        expect(calls).toBe(1);
      }).pipe(Effect.provide(adapter.pipe(Layer.provide(cfg), Layer.provide(proc))));
    });
  });
}

it.effect("does not retain failed GitLab source-project lookups in the cache", () => {
  let calls = 0;
  const error = new ExecError("glab", ["api", "projects/7"], 1, "HTTP 403: forbidden");
  const proc = Layer.succeed(Proc.Service, {
    exec: (_cwd, _tool, args) =>
      Effect.gen(function* () {
        if (args[1] !== "projects/7") return JSON.stringify({ ...gitlab, source_project_id: 7 });
        calls += 1;
        if (calls === 1) return yield* Effect.fail(error);
        return JSON.stringify({ path_with_namespace: "owner/project" });
      }),
  });
  return Effect.gen(function* () {
    const host = yield* CodeHost.Service;
    expect(yield* Effect.flip(host.changes())).toBe(error);
    expect((yield* host.changes())[0]?.headRepository).toBe("owner/project");
    yield* host.changes();
    expect(calls).toBe(2);
  }).pipe(Effect.provide(CodeHostGitLab.layer.pipe(Layer.provide(cfg), Layer.provide(proc))));
});

it.effect.each([
  "HTTP 502: Bad Gateway",
  "HTTP 503: Service Unavailable",
  "HTTP 504: Gateway Timeout",
  "context deadline exceeded",
  "Client.Timeout exceeded while awaiting headers",
  "read: connection reset by peer",
  "unexpected EOF",
])("retries a recognized transient read failure: %s", (stderr) =>
  Effect.gen(function* () {
    let calls = 0;
    const read = Effect.gen(function* () {
      calls += 1;
      if (calls === 1) return yield* Effect.fail(new ExecError("gh", ["api"], 1, stderr));
      return "ok";
    }).pipe(CodeHost.retryRead);
    const fiber = yield* read.pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(fiber)).toBe("ok");
    expect(calls).toBe(2);
  }),
);

it.effect("GitLab project retries stay within the existing concurrency budget", () => {
  let active = 0;
  let peak = 0;
  const calls = new Map<string, number>();
  const rows = Array.from({ length: 8 }, (_, index) => ({
    ...gitlab,
    iid: index + 1,
    source_project_id: index + 1,
  }));
  const proc = Layer.succeed(Proc.Service, {
    exec: (_cwd, tool, args) =>
      Effect.gen(function* () {
        const endpoint = args[1] ?? "";
        if (endpoint.includes("merge_requests"))
          return rows.map((row) => JSON.stringify(row)).join("\n");
        const attempts = (calls.get(endpoint) ?? 0) + 1;
        calls.set(endpoint, attempts);
        active += 1;
        peak = Math.max(peak, active);
        yield* Effect.yieldNow;
        active -= 1;
        if (attempts === 1) return yield* Effect.fail(new ExecError(tool, args, 1, "i/o timeout"));
        return JSON.stringify({ path_with_namespace: "owner/project" });
      }),
  });
  return Effect.gen(function* () {
    const host = yield* CodeHost.Service;
    const fiber = yield* host.changes().pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(fiber)).toHaveLength(8);
    expect(peak).toBe(2);
    expect([...calls.values()]).toEqual(Array(8).fill(2));
  }).pipe(
    Effect.provide(
      CodeHostGitLab.layer.pipe(
        Layer.provide(
          StackConfig.layer({ root: "/repo", codeHostConcurrency: 2 }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(proc),
      ),
    ),
  );
});
