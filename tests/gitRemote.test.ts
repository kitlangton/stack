import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option } from "effect";
import * as FileSystem from "effect/FileSystem";
import { ExecError } from "../src/domain/model.ts";
import * as Proc from "../src/platform/proc.ts";
import { StackConfig } from "../src/services/Config.ts";
import { Git } from "../src/services/Git.ts";

const platform = Proc.live.pipe(Layer.provideMerge(NodeServices.layer));

const scenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const proc = yield* Proc.Service;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-git-remote-" });
  const repo = `${root}/repo`;
  const origin = `${root}/origin.git`;
  const other = `${root}/other.git`;
  yield* fs.makeDirectory(repo);
  const command = (args: ReadonlyArray<string>) => proc.exec(repo, "git", args);
  yield* command(["init", "--bare", origin]);
  yield* command(["init", "--bare", other]);
  yield* command(["init", "-b", "topic"]);
  yield* command(["config", "user.name", "Stack Test"]);
  yield* command(["config", "user.email", "stack@example.com"]);
  yield* command(["config", "commit.gpgsign", "false"]);
  yield* command(["commit", "--allow-empty", "-m", "base"]);
  const base = yield* command(["rev-parse", "HEAD"]);
  yield* command(["push", origin, `${base}:refs/heads/topic`]);
  yield* command(["push", other, `${base}:refs/heads/topic`]);
  yield* command(["remote", "add", "origin", origin]);
  yield* command(["fetch", "origin"]);
  yield* command(["commit", "--allow-empty", "-m", "ahead"]);
  const ahead = yield* command(["rev-parse", "HEAD"]);
  yield* command(["commit", "--allow-empty", "-m", "later"]);
  const later = yield* command(["rev-parse", "HEAD"]);
  const layer = Git.live.pipe(Layer.provide(StackConfig.layer({ root: repo })));
  const snapshot = () =>
    Effect.all({
      refs: command(["for-each-ref", "--format=%(refname) %(objectname)"]),
      head: fs.readFileString(`${repo}/.git/HEAD`),
      config: fs.readFileString(`${repo}/.git/config`),
      fetchHead: fs.readFileString(`${repo}/.git/FETCH_HEAD`),
    });
  return { command, origin, other, base, ahead, later, layer, snapshot };
});

it.effect(
  "pushRef publishes a literal ahead OID and restores the remote without moving local refs",
  () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      const before = yield* s.snapshot();
      yield* Effect.gen(function* () {
        const git = yield* Git.Service;
        expect(yield* git.remoteHead("topic", "origin")).toEqual(Option.some(s.base));
        yield* git.pushRef({ branch: "topic", remote: "origin", head: s.ahead, expected: s.base });
        expect(yield* git.remoteHead("topic", "origin")).toEqual(Option.some(s.ahead));
        expect(yield* git.head("topic")).toEqual(Option.some(s.later));
        expect(yield* s.snapshot()).toEqual(before);

        yield* git.pushRef({ branch: "topic", remote: "origin", head: s.base, expected: s.ahead });
        expect(yield* git.remoteHead("topic", "origin")).toEqual(Option.some(s.base));
        expect(yield* s.snapshot()).toEqual(before);
      }).pipe(Effect.provide(s.layer));
    }).pipe(Effect.provide(platform)),
);

it.effect("pushRef does not publish annotated tags when push.followTags is enabled", () =>
  Effect.gen(function* () {
    const s = yield* scenario;
    yield* s.command(["config", "push.followTags", "true"]);
    yield* s.command(["tag", "--no-sign", "-a", "unpublished", "-m", "unpublished", s.ahead]);
    const before = yield* s.snapshot();
    yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      yield* git.pushRef({ branch: "topic", remote: "origin", head: s.ahead, expected: s.base });
      expect(
        yield* s.command([
          "--git-dir",
          s.origin,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ]),
      ).toBe(`refs/heads/topic ${s.ahead}`);
      expect(yield* s.command(["ls-remote", "--tags", s.origin])).toBe("");
      expect(yield* s.snapshot()).toEqual(before);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("pushRef rejects a stale explicit lease rather than refreshing it", () =>
  Effect.gen(function* () {
    const s = yield* scenario;
    yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      const expected = Option.getOrNull(yield* git.remoteHead("topic", "origin"));
      yield* s.command(["push", s.origin, `${s.ahead}:refs/heads/topic`]);
      const before = yield* s.snapshot();

      const error = yield* Effect.flip(
        git.pushRef({ branch: "topic", remote: "origin", head: s.later, expected }),
      );
      expect(error).toBeInstanceOf(ExecError);
      expect(error.stderr).toContain("stale info");
      expect(yield* git.remoteHead("topic", "origin")).toEqual(Option.some(s.ahead));
      expect(yield* s.snapshot()).toEqual(before);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("pushRef deletes only with a matching lease and preserves the local branch", () =>
  Effect.gen(function* () {
    const s = yield* scenario;
    const before = yield* s.snapshot();
    yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      const error = yield* Effect.flip(
        git.pushRef({ branch: "topic", remote: "origin", head: null, expected: s.ahead }),
      );
      expect(error.stderr).toContain("stale info");
      expect(yield* git.remoteHead("topic", "origin")).toEqual(Option.some(s.base));

      yield* git.pushRef({ branch: "topic", remote: "origin", head: null, expected: s.base });
      expect(yield* git.remoteHead("topic", "origin")).toEqual(Option.none());
      expect(yield* git.head("topic")).toEqual(Option.some(s.later));
      expect(yield* s.snapshot()).toEqual(before);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect("missing refs return none and an empty lease only creates an absent remote ref", () =>
  Effect.gen(function* () {
    const s = yield* scenario;
    const before = yield* s.snapshot();
    yield* Effect.gen(function* () {
      const git = yield* Git.Service;
      expect(yield* git.head("missing")).toEqual(Option.none());
      expect(yield* git.head("refs/heads/missing")).toEqual(Option.none());
      expect(yield* git.head("origin/missing")).toEqual(Option.none());
      expect(yield* git.remoteHead("missing", "origin")).toEqual(Option.none());
      expect(yield* s.snapshot()).toEqual(before);

      yield* git.pushRef({ branch: "missing", remote: "origin", head: s.ahead, expected: null });
      expect(yield* git.remoteHead("missing", "origin")).toEqual(Option.some(s.ahead));
      const error = yield* Effect.flip(
        git.pushRef({ branch: "missing", remote: "origin", head: s.later, expected: null }),
      );
      expect(error.stderr).toContain("stale info");
      expect(yield* git.remoteHead("missing", "origin")).toEqual(Option.some(s.ahead));
      expect(yield* s.snapshot()).toEqual(before);
    }).pipe(Effect.provide(s.layer));
  }).pipe(Effect.provide(platform)),
);

it.effect(
  "remoteHead reads the fresh push URL without fetching and pushRef writes that destination",
  () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      yield* s.command(["remote", "set-url", "--push", "origin", s.other]);
      const remoteOnly = yield* s.command([
        "-c",
        "user.name=Stack Test",
        "-c",
        "user.email=stack@example.com",
        "--git-dir",
        s.other,
        "commit-tree",
        `${s.base}^{tree}`,
        "-p",
        s.base,
        "-m",
        "remote-only",
      ]);
      yield* s.command(["--git-dir", s.other, "update-ref", "refs/heads/topic", remoteOnly]);
      const before = yield* s.snapshot();

      yield* Effect.gen(function* () {
        const git = yield* Git.Service;
        expect(yield* git.remoteHead("topic", "origin")).toEqual(Option.some(remoteOnly));
        expect(yield* git.head(`${remoteOnly}^{commit}`)).toEqual(Option.none());
        expect(yield* git.head("origin/topic")).toEqual(Option.some(s.base));
        expect(yield* s.snapshot()).toEqual(before);

        yield* git.pushRef({
          branch: "topic",
          remote: "origin",
          head: s.ahead,
          expected: remoteOnly,
        });
        expect(yield* git.remoteHead("topic", "origin")).toEqual(Option.some(s.ahead));
        expect(yield* s.command(["--git-dir", s.origin, "rev-parse", "topic"])).toBe(s.base);
        expect(yield* s.command(["--git-dir", s.other, "rev-parse", "topic"])).toBe(s.ahead);
        expect(yield* s.snapshot()).toEqual(before);
      }).pipe(Effect.provide(s.layer));
    }).pipe(Effect.provide(platform)),
);

it.effect(
  "remoteHead and pushRef reject multiple push destinations before touching either repo",
  () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      yield* s.command(["config", "--add", "remote.origin.pushurl", s.origin]);
      yield* s.command(["config", "--add", "remote.origin.pushurl", s.other]);
      yield* Effect.gen(function* () {
        const git = yield* Git.Service;
        for (const explicitPushUrls of [true, false]) {
          if (!explicitPushUrls) {
            yield* s.command(["config", "--unset-all", "remote.origin.pushurl"]);
            yield* s.command(["config", "--add", "remote.origin.url", s.other]);
          }
          const before = yield* s.snapshot();
          const readError = yield* Effect.flip(git.remoteHead("topic", "origin"));
          const pushError = yield* Effect.flip(
            git.pushRef({ branch: "topic", remote: "origin", head: s.ahead, expected: s.base }),
          );
          expect(readError).toBeInstanceOf(ExecError);
          expect(readError.stderr).toContain("exactly one push URL");
          expect(pushError.stderr).toContain("exactly one push URL");
          expect(yield* s.command(["--git-dir", s.origin, "rev-parse", "topic"])).toBe(s.base);
          expect(yield* s.command(["--git-dir", s.other, "rev-parse", "topic"])).toBe(s.base);
          expect(yield* s.snapshot()).toEqual(before);
        }
      }).pipe(Effect.provide(s.layer));
    }).pipe(Effect.provide(platform)),
);
