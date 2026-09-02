import type { Effect } from "effect";

/**
 * A task the `Scheduler` runs on a cron schedule. Runs of one task never
 * overlap: the next fire is computed after the previous run completes.
 */
export interface ScheduledTask<E = never, R = never> {
  /** Human-readable name for logging. */
  readonly name: string;
  /**
   * Cron expression, seconds first: `second minute hour day month weekday`.
   * A five-field expression is accepted (seconds = 0).
   */
  readonly schedule: string;
  /** Max jitter in ms added before each run (default 0). */
  readonly jitterMs?: number;
  /** Whether to run once immediately after `start` (default false). */
  readonly runOnStartup?: boolean;
  /** The work. A failure or defect is logged as an error and never stops the schedule. */
  readonly run: Effect.Effect<void, E, R>;
}
