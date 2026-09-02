/**
 * The process entry point for an Effect CLI: render a failure the way a user
 * expects, map an exit to an exit code, and run the program.
 *
 * This is the one module in the library that runs an effect. A process entry
 * point is an external contract (Node hands you a synchronous `main`, and the
 * exit code is the only thing the shell sees), so `Effect.runFork` lives here
 * and nowhere else.
 *
 * ```ts
 * const AppLayer = Layer.mergeAll(Logger.layerConfig(), Sqlite.layerConfig());
 *
 * runMain(main.pipe(Effect.provide(AppLayer)), {
 *   debug: process.env.MYTOOL_DEBUG !== undefined,
 *   flush: Logger.flush.pipe(Effect.provide(AppLayer)),
 * });
 * ```
 */
import { Cause, Effect, Exit } from "effect";

/**
 * What a CLI program resolves to: an explicit exit code, or nothing when the
 * command simply succeeded.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: an Effect that returns nothing has `void`, not `undefined`
export type MainResult = number | void;

/** Options for {@link renderFailure}. */
export interface RenderFailureOptions {
  /** Append the stack to a tagged failure too. Defects always keep their stack. */
  readonly debug?: boolean;
}

/**
 * What the user sees when the program fails.
 *
 * A tagged failure is an expected error whose `message` already reads
 * `operation: cause` down the chain, so print that. A defect is an untyped
 * throw whose stack is the only clue it carries, so print the stack.
 * Interruption renders as `interrupted`.
 */
export function renderFailure(
  cause: Cause.Cause<unknown>,
  options?: RenderFailureOptions,
): string {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted";
  const error = Cause.squash(cause);
  if (error instanceof Error && "_tag" in error) {
    const text = error.message || String(error);
    return options?.debug === true && error.stack !== undefined
      ? `${text}\n${error.stack}`
      : text;
  }
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/**
 * The exit code for a finished program: a number result is the code itself,
 * a void result is 0, interruption is 130 (the shell's convention for
 * SIGINT), and any other failure is 1. Pure, so the mapping can be tested
 * without a process.
 */
export function exitCodeFor(exit: Exit.Exit<MainResult, unknown>): number {
  if (Exit.isSuccess(exit)) return typeof exit.value === "number" ? exit.value : 0;
  return Cause.hasInterruptsOnly(exit.cause) ? 130 : 1;
}

/** Options for {@link runMain}. `EF` is the flush effect's error type, if any. */
export interface RunMainOptions<EF = never> {
  /** Add stacks to tagged failures. Usually driven by a `*_DEBUG` env var. */
  readonly debug?: boolean;
  /**
   * Run on every path, success or failure, before exiting. Typically
   * `Logger.flush` provided with the same layer as the program, so queued log
   * writes land before the process goes away. Its own failures are swallowed:
   * flushing never changes the exit code.
   */
  readonly flush?: Effect.Effect<void, EF>;
  /** Where a failure is printed. Defaults to `process.stderr`. */
  readonly stderr?: (text: string) => void;
  /** How the process ends. Defaults to `process.exit`; inject in tests. */
  readonly exit?: (code: number) => void;
  /** Install SIGINT/SIGTERM handlers that interrupt the program. Defaults to `true`. */
  readonly signals?: boolean;
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Runs `program` as the process entry point.
 *
 * The program is provided in full by the caller: `runMain` requires
 * `Effect<number | void, unknown, never>`, so every layer is already applied
 * and `flush` (which usually needs the same layers) is passed separately
 * rather than inferred.
 *
 * SIGINT and SIGTERM interrupt the running fiber, which lets finalizers run
 * and exits 130. A typed failure or a defect prints through `renderFailure`
 * and exits 1.
 */
export function runMain<E, EF = never>(
  program: Effect.Effect<MainResult, E, never>,
  options?: RunMainOptions<EF>,
): void {
  const writeError =
    options?.stderr ??
    ((text: string) => {
      process.stderr.write(`${text}\n`);
    });
  const exitProcess = options?.exit ?? ((code: number) => process.exit(code));
  const flush = options?.flush;
  const withFlush =
    flush === undefined
      ? program
      : Effect.ensuring(
          program,
          Effect.catchCause(flush, () => Effect.void),
        );

  const fiber = Effect.runFork(withFlush);

  const listeners: Array<() => void> = [];
  if (options?.signals !== false) {
    for (const signal of SIGNALS) {
      const listener = () => {
        fiber.interruptUnsafe();
      };
      process.on(signal, listener);
      listeners.push(() => process.removeListener(signal, listener));
    }
  }

  fiber.addObserver((exit) => {
    for (const remove of listeners) remove();
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      writeError(renderFailure(exit.cause, { debug: options?.debug }));
    }
    exitProcess(exitCodeFor(exit));
  });
}
