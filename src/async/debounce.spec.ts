import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";
import { makeDebounced } from "./debounce.js";

/** A counter the debounced callback can bump from synchronous code. */
function counter() {
  const state = { calls: 0 };
  return { state, onChange: () => void state.calls++ };
}

describe("makeDebounced", () => {
  it.effect("calls back once the quiet window has passed", () =>
    Effect.gen(function* () {
      const { state, onChange } = counter();
      const debounced = yield* makeDebounced(onChange, 100);

      yield* debounced.trigger;
      yield* TestClock.adjust("99 millis");
      assert.strictEqual(state.calls, 0);

      yield* TestClock.adjust("1 millis");
      assert.strictEqual(state.calls, 1);
    }),
  );

  it.effect("a retrigger replaces the pending callback", () =>
    Effect.gen(function* () {
      const { state, onChange } = counter();
      const debounced = yield* makeDebounced(onChange, 100);

      yield* debounced.trigger;
      yield* TestClock.adjust("50 millis");
      yield* debounced.trigger;
      yield* TestClock.adjust("50 millis");
      assert.strictEqual(state.calls, 0, "the first wait was restarted");

      yield* TestClock.adjust("50 millis");
      assert.strictEqual(state.calls, 1);

      // A whole burst still collapses into a single call.
      yield* debounced.trigger;
      yield* debounced.trigger;
      yield* debounced.trigger;
      yield* TestClock.adjust("100 millis");
      assert.strictEqual(state.calls, 2);
    }),
  );

  it.effect("closing the scope drops the pending callback", () =>
    Effect.gen(function* () {
      const { state, onChange } = counter();
      const scope = yield* Scope.make();
      const debounced = yield* Scope.provide(makeDebounced(onChange, 100), scope);

      yield* debounced.trigger;
      yield* TestClock.adjust("50 millis");
      yield* Scope.close(scope, Exit.void);

      yield* TestClock.adjust("500 millis");
      assert.strictEqual(state.calls, 0);
    }),
  );

  it.effect("cancel is idempotent and disposes the debouncer", () =>
    Effect.gen(function* () {
      const { state, onChange } = counter();
      const debounced = yield* makeDebounced(onChange, 100);

      yield* debounced.trigger;
      yield* TestClock.adjust("50 millis");
      yield* debounced.cancel;
      yield* debounced.cancel;
      yield* TestClock.adjust("500 millis");
      assert.strictEqual(state.calls, 0);

      // Disposed for good: later triggers do nothing.
      yield* debounced.trigger;
      yield* TestClock.adjust("500 millis");
      assert.strictEqual(state.calls, 0);
    }),
  );

  it.effect("triggerUnsafe debounces a synchronous burst", () =>
    Effect.gen(function* () {
      const { state, onChange } = counter();
      const debounced = yield* makeDebounced(onChange, 100);

      debounced.triggerUnsafe();
      debounced.triggerUnsafe();
      debounced.triggerUnsafe();
      yield* TestClock.adjust("100 millis");
      assert.strictEqual(state.calls, 1);
    }),
  );

  it.effect("triggerUnsafe after cancel is a no-op", () =>
    Effect.gen(function* () {
      const { state, onChange } = counter();
      const debounced = yield* makeDebounced(onChange, 100);

      yield* debounced.cancel;
      debounced.triggerUnsafe();
      yield* TestClock.adjust("500 millis");
      assert.strictEqual(state.calls, 0);
    }),
  );

  it.effect("cancelUnsafe drops the pending callback", () =>
    Effect.gen(function* () {
      const { state, onChange } = counter();
      const debounced = yield* makeDebounced(onChange, 100);

      yield* debounced.trigger;
      yield* TestClock.adjust("50 millis");
      debounced.cancelUnsafe();
      yield* TestClock.adjust("500 millis");
      assert.strictEqual(state.calls, 0);
    }),
  );

  it.effect("the callback sees state written before the trigger", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<number>>([]);
      const values: number[] = [];
      const debounced = yield* makeDebounced(() => values.push(values.length), 10);

      yield* debounced.trigger;
      yield* TestClock.adjust("10 millis");
      yield* Ref.set(seen, values);

      assert.deepStrictEqual(yield* Ref.get(seen), [0]);
    }),
  );
});
