import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
    Stream.decodeText({ encoding: "utf-8" }),
    Stream.mkString,
    Effect.orElseSucceed(() => ""),
  );

/** Prefer az.cmd over az.bat / extensionless shims from `where az`. */
export const pickWindowsAzExecutable = (lines: ReadonlyArray<string>): string | null => {
  const candidates = lines.map((line) => line.trim()).filter(Boolean);
  const cmd = candidates.find((line) => /\.cmd$/i.test(line));
  return cmd ?? candidates[0] ?? null;
};

const findWindowsAzCmd = (): string | null => {
  if (typeof Bun !== "undefined") {
    const fromBun = Bun.which("az.cmd") ?? Bun.which("az");
    if (fromBun) return fromBun;
  }
  try {
    const out = execFileSync("where", ["az"], { encoding: "utf8", windowsHide: true });
    return pickWindowsAzExecutable(out.split(/\r?\n/));
  } catch {
    return null;
  }
};

/** Azure CLI on Windows uses isolated Python; PYTHONUTF8 is ignored without `-X utf8`. */
export const resolveWindowsAzFromInstall = (
  azCmd: string,
): { readonly command: string; readonly prefix: ReadonlyArray<string> } | null => {
  const python = join(dirname(azCmd), "..", "python.exe");
  if (!existsSync(python)) return null;
  return { command: python, prefix: ["-X", "utf8", "-IBm", "azure.cli"] };
};

const resolveWindowsAz = (): { readonly command: string; readonly prefix: ReadonlyArray<string> } | null => {
  if (process.platform !== "win32") return null;
  const azCmd = findWindowsAzCmd();
  if (!azCmd) return null;
  return resolveWindowsAzFromInstall(azCmd);
};

const windowsSpawnOptions = (): ChildProcess.CommandOptions | undefined => {
  if (process.platform !== "win32") return undefined;
  return {
    env: {
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      AZURE_CORE_NO_COLOR: "true",
    },
    extendEnv: true,
  };
};

export const spawnCommand = (
  tool: string,
  args: ReadonlyArray<string>,
  cwd: string,
): { readonly command: string; readonly args: ReadonlyArray<string>; readonly options: ChildProcess.CommandOptions } => {
  const base = {
    cwd,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    ...windowsSpawnOptions(),
  };
  if (tool !== "az") {
    return { command: tool, args, options: base };
  }
  const az = resolveWindowsAz();
  if (!az) {
    return { command: tool, args, options: base };
  }
  return {
    command: az.command,
    args: [...az.prefix, ...args],
    options: base,
  };
};

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
      const { command, args: childArgs, options } = spawnCommand(tool, args, cwd);
      const cmd = ChildProcess.make(command, [...childArgs], options);

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
