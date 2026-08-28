import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Latch, Layer, Sink, Stream } from "effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ExecError } from "../src/domain/model.ts";
import * as Proc from "../src/platform/proc.ts";

it.effect.each([
  { code: 0, ok: undefined },
  { code: 7, ok: undefined },
  { code: 7, ok: [0, 7] },
])(
  "exec drains interdependent pipes (exit $code, accepted $ok)",
  ({ code, ok }) =>
    Effect.gen(function* () {
      const stderrDrained = yield* Latch.make();
      const stdoutDrained = yield* Latch.make();
      const encode = (text: string) => new TextEncoder().encode(text);
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        // Model a child blocked on stderr before it can finish stdout and exit.
        stdout: Stream.fromEffect(stderrDrained.await.pipe(Effect.as(encode("  ready\n")))).pipe(
          Stream.ensuring(stdoutDrained.open),
        ),
        stderr: Stream.make(encode("  first\n"), encode("second  \n")).pipe(
          Stream.ensuring(stderrDrained.open),
        ),
        exitCode: stdoutDrained.await.pipe(Effect.as(ChildProcessSpawner.ExitCode(code))),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
      const layer = Proc.live.pipe(
        Layer.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.succeed(handle)),
          ),
        ),
      );
      const proc = yield* Proc.Service.asEffect().pipe(Effect.provide(layer));
      const exec = proc.exec("/repo", "child", ["arg"], ok);
      if ((ok ?? [0]).includes(code)) {
        expect(yield* exec).toBe("ready");
      } else {
        const error = yield* Effect.flip(exec);
        expect(error).toBeInstanceOf(ExecError);
        expect(error).toMatchObject({
          tool: "child",
          args: ["arg"],
          code,
          stderr: "first\nsecond",
        });
      }
    }),
  1000,
);

it.effect(
  "exec drains a real child's stderr beyond pipe capacity before stdout",
  () =>
    Effect.gen(function* () {
      const proc = yield* Proc.Service;
      for (const code of [0, 7]) {
        const args = [
          "-e",
          `process.stderr.write("  " + "x".repeat(2 * 1024 * 1024) + "\\n", () => {
            process.stdout.write("  ready\\n");
            process.exitCode = ${code};
          });`,
        ];
        const exec = proc.exec(process.cwd(), process.execPath, args);
        if (code === 0) {
          expect(yield* exec).toBe("ready");
        } else {
          const error = yield* Effect.flip(exec);
          expect(error).toBeInstanceOf(ExecError);
          expect(error).toMatchObject({ tool: process.execPath, args, code });
          expect(error.stderr).toBe("x".repeat(2 * 1024 * 1024));
        }
      }
    }).pipe(Effect.provide(Proc.live.pipe(Layer.provide(NodeServices.layer)))),
  5000,
);
