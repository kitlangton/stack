import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ExecError } from "../domain/model.ts";

export interface Interface {
  readonly exec: (
    cwd: string,
    tool: string,
    args: ReadonlyArray<string>,
    ok?: ReadonlyArray<number>,
  ) => Effect.Effect<string, ExecError>;
}

export class Service extends Context.Service<Service, Interface>()("@stack/Proc") {}

const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => ""),
  );

export const live = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const exec = Effect.fn("Proc.exec")(function* (
      cwd: string,
      tool: string,
      args: ReadonlyArray<string>,
      ok: ReadonlyArray<number> = [0],
    ) {
      const cmd = ChildProcess.make(tool, [...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(cmd)
            .pipe(Effect.mapError((err) => new ExecError(tool, Array.from(args), 1, String(err))));

          const [stdout, stderr, exit] = yield* Effect.all([
            text(handle.stdout),
            text(handle.stderr),
            handle.exitCode.pipe(
              Effect.mapError((err) => new ExecError(tool, Array.from(args), 1, String(err))),
            ),
          ]);

          const code = Number(exit);
          if (!ok.includes(code)) {
            return yield* Effect.fail(new ExecError(tool, Array.from(args), code, stderr.trim()));
          }

          return stdout.trim();
        }),
      );
    });

    return Service.of({ exec });
  }),
);
