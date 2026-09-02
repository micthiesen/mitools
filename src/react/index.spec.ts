import { assert, describe, it } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, ManagedRuntime, Ref } from "effect";
import { globalRunner } from "../boundary/index.js";
import { fiberLifecycle } from "./index.js";

/**
 * `useEffectFiber` is a two-line `useEffect` wrapper over `fiberLifecycle`;
 * testing it directly would need a renderer (`react-dom`, `react-test-renderer`)
 * that this library deliberately does not depend on, so the lifecycle itself is
 * what is pinned here. Its typecheck against `@types/react` is covered by
 * `pnpm typecheck`.
 */
describe("fiberLifecycle", () => {
  it.effect("forks on start and interrupts on cleanup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const { start } = fiberLifecycle(
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        globalRunner,
      );

      const cleanup = start();
      assert.isDefined(cleanup);
      yield* Deferred.await(started);
      cleanup?.();
      yield* Deferred.await(interrupted);
    }),
  );

  it.effect("runs nothing and returns no cleanup when make returns null", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { start } = fiberLifecycle(() => {
        calls += 1;
        return null;
      }, globalRunner);

      assert.isUndefined(start());
      assert.strictEqual(calls, 1);
      yield* Effect.void;
    }),
  );

  it.effect("calls make again on every start, so a remount forks a new fiber", () =>
    Effect.gen(function* () {
      const forks = yield* Ref.make(0);
      const done = yield* Deferred.make<void>();
      const { start } = fiberLifecycle(
        () =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(forks, (x) => x + 1);
            if (n === 2) yield* Deferred.succeed(done, undefined);
          }),
        globalRunner,
      );

      start();
      start();
      yield* Deferred.await(done);
      assert.strictEqual(yield* Ref.get(forks), 2);
    }),
  );

  it.effect("runs the effect against the supplied runner's services", () =>
    Effect.gen(function* () {
      const runtime = ManagedRuntime.make(
        Layer.succeed(Greeter)({ greet: (name: string) => `hello ${name}` }),
      );
      const seen = yield* Deferred.make<string>();
      const { start } = fiberLifecycle(
        () =>
          Effect.gen(function* () {
            const greeter = yield* Greeter;
            yield* Deferred.succeed(seen, greeter.greet("mitools"));
          }),
        runtime,
      );

      start();
      assert.strictEqual(yield* Deferred.await(seen), "hello mitools");
      yield* runtime.disposeEffect;
    }),
  );
});

class Greeter extends Context.Service<
  Greeter,
  { readonly greet: (name: string) => string }
>()("test/Greeter") {}
