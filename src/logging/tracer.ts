import { Cause, Effect, Exit, Layer, Option, Tracer } from "effect";
import { Logger } from "./Logger.js";
import { LogLevel } from "./types.js";

const TRACER_LOGGER = "Tracer";

/** Outcome text for an ended span. */
function outcome(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return "ok";
  if (Cause.hasInterruptsOnly(exit.cause)) return "interrupted";
  return `failed: ${Cause.squash(exit.cause) instanceof Error ? (Cause.squash(exit.cause) as Error).message : Cause.pretty(exit.cause)}`;
}

function parentName(parent: Option.Option<Tracer.AnySpan>): string | undefined {
  return Option.match(parent, {
    onNone: () => undefined,
    onSome: (span) => (span._tag === "Span" ? span.name : span.spanId),
  });
}

/**
 * A `Tracer` whose spans, when ended, write one debug line to the mitools
 * `Logger`: `<name> <duration>ms` with the parent span, the outcome and any
 * span attributes as args. `Effect.fn("Service.method")` names every effect
 * in this library; this is what makes those names visible.
 */
export const layerTracer: Layer.Layer<never, never, Logger> = Layer.effect(
  Tracer.Tracer,
  // A generator, not `Effect.map(Logger, ...)`: `Logger` is read when the
  // layer is built, which keeps the import cycle with `Logger.ts` harmless.
  Effect.gen(function* () {
    const logger = yield* Logger;
    return Tracer.make({
      span(options) {
        return new LoggedSpan(options, logger);
      },
    });
  }),
);

class LoggedSpan extends Tracer.NativeSpan {
  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    private readonly logger: Logger["Service"],
  ) {
    super(options);
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    const durationMs = Number(endTime - this.startTime) / 1_000_000;
    const parent = parentName(this.parent);
    const details: Record<string, unknown> = { outcome: outcome(exit) };
    if (parent !== undefined) details.parent = parent;
    if (this.attributes.size > 0)
      details.attributes = Object.fromEntries(this.attributes);
    const args = [details];
    this.logger.emitUnsafe({
      timestamp: Number(endTime / 1_000_000n),
      level: LogLevel.DEBUG,
      loggerName: TRACER_LOGGER,
      message: `${this.name} ${durationMs.toFixed(durationMs < 10 ? 1 : 0)}ms`,
      args,
      formattedArgs: JSON.stringify(details),
    });
  }
}
