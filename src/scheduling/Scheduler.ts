import {
  Clock,
  Context,
  Cron,
  Data,
  Effect,
  Fiber,
  Layer,
  Random,
  Ref,
  Result,
  Schedule,
  type Scope,
} from "effect";
import { causeMessage } from "../errors/index.js";
import type { ScheduledTask } from "./ScheduledTask.js";

/** `register` rejected a task whose cron expression does not parse. */
export class InvalidScheduleError extends Data.TaggedError("InvalidScheduleError")<{
  readonly task: string;
  readonly schedule: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid cron expression "${this.schedule}" for task "${this.task}": ${causeMessage(this.cause)}`;
  }
}

interface Registered {
  readonly name: string;
  readonly schedule: string;
  /** The task's runner with its services already provided. */
  readonly runOnce: Effect.Effect<void>;
  readonly cron: Cron.Cron;
  readonly runOnStartup: boolean;
}

export interface SchedulerShape {
  /**
   * Registers a task. Its requirements are captured from the caller's context
   * now, so register inside the layer or program that has them.
   */
  register<E, R>(
    task: ScheduledTask<E, R>,
  ): Effect.Effect<void, InvalidScheduleError, R>;
  /**
   * Forks one fiber per registered task into the caller's scope. Closing that
   * scope (or calling `shutdown`) stops scheduling and waits for any run in
   * flight to finish; runs are never interrupted midway.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /** Stops scheduling and waits for runs in flight. Idempotent. */
  readonly shutdown: Effect.Effect<void>;
  /** Names and expressions of the registered tasks. */
  readonly tasks: Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly schedule: string }>
  >;
}

/**
 * Runs `ScheduledTask`s on Effect's `Cron`/`Schedule`. Each task runs in its
 * own fiber, so a slow task never delays another; within a task, runs are
 * sequential (a fire that lands during a run is skipped, the next match after
 * completion fires).
 */
export class Scheduler extends Context.Service<Scheduler, SchedulerShape>()(
  "@micthiesen/mitools/Scheduler",
) {
  static readonly layer: Layer.Layer<Scheduler> = Layer.effect(Scheduler, make());
}

const annotate = Effect.annotateLogs({ logger: "Scheduler" });

function make(): Effect.Effect<SchedulerShape> {
  return Effect.gen(function* () {
    const registered = yield* Ref.make<ReadonlyArray<Registered>>([]);
    const fibers = yield* Ref.make<ReadonlyArray<Fiber.Fiber<void>>>([]);

    const register = Effect.fn("Scheduler.register")(function* <E, R>(
      task: ScheduledTask<E, R>,
    ) {
      const parsed = Cron.parse(task.schedule);
      if (Result.isFailure(parsed)) {
        return yield* new InvalidScheduleError({
          task: task.name,
          schedule: task.schedule,
          cause: parsed.failure,
        });
      }
      // An expression can parse yet never match (e.g. "0 0 0 30 2 *");
      // `Cron.next` then throws, so probe it now instead of inside the loop.
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.try({
        try: () => Cron.next(parsed.success, now),
        catch: (cause) =>
          new InvalidScheduleError({ task: task.name, schedule: task.schedule, cause }),
      });
      const services = yield* Effect.context<R>();
      const jitterMs = task.jitterMs ?? 0;
      const runOnce = Effect.gen(function* () {
        if (jitterMs > 0) {
          yield* Effect.sleep(yield* Random.nextIntBetween(0, jitterMs));
        }
        yield* Effect.logDebug(`Running task: ${task.name}`);
        // Uninterruptible so shutdown waits for a run in flight instead of
        // cutting it off halfway; a task that must stop early adds its own
        // `Effect.timeout`.
        yield* task.run.pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`Error running task "${task.name}"`, cause),
          ),
          Effect.uninterruptible,
        );
      }).pipe(annotate, Effect.provide(services));
      yield* Ref.update(registered, (tasks) => [
        ...tasks,
        {
          name: task.name,
          schedule: task.schedule,
          runOnce,
          cron: parsed.success,
          runOnStartup: task.runOnStartup ?? false,
        },
      ]);
      yield* Effect.logInfo(
        `Registered task "${task.name}" with schedule "${task.schedule}"`,
      );
    }, annotate);

    const loop = (task: Registered) =>
      Effect.gen(function* () {
        if (task.runOnStartup) yield* task.runOnce;
        yield* Effect.schedule(task.runOnce, Schedule.cron(task.cron));
      }).pipe(
        // A forked fiber's death is otherwise invisible: say so, then die.
        Effect.tapCause((cause) =>
          Effect.logError(`Scheduler loop for "${task.name}" stopped`, cause),
        ),
        annotate,
        Effect.orDie,
      );

    const start = Effect.gen(function* () {
      const tasks = yield* Ref.get(registered);
      const started: Fiber.Fiber<void>[] = [];
      for (const task of tasks) started.push(yield* Effect.forkScoped(loop(task)));
      yield* Ref.update(fibers, (existing) => [...existing, ...started]);
      yield* Effect.logInfo(`Started ${started.length} scheduled task(s)`);
    }).pipe(annotate);

    const shutdown = Effect.gen(function* () {
      const running = yield* Ref.getAndSet(fibers, []);
      if (running.length === 0) return;
      yield* Effect.logInfo(`Stopping ${running.length} scheduled task(s)...`);
      yield* Fiber.interruptAll(running);
    }).pipe(annotate);

    const tasks = Ref.get(registered).pipe(
      Effect.map((tasks) => tasks.map(({ name, schedule }) => ({ name, schedule }))),
    );

    return Scheduler.of({ register, start, shutdown, tasks });
  });
}
