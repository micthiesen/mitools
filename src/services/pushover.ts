import { Config, Console, Context, Data, Effect, Layer, Redacted } from "effect";
import { HttpBody, HttpClient, HttpClientError } from "effect/unstable/http";
import { causeMessage } from "../errors/index.js";
import type { LogHook } from "../logging/types.js";

export interface PushoverMessage {
  message: string;
  title: string;
  url?: string;
  url_title?: string;
  priority?: number;
  sound?: string;
  timestamp?: number;
  /** Overrides the configured application token for this message. */
  token?: string;
}

export interface PushoverCredentials {
  /**
   * The application token. Optional: a message may carry its own `token`;
   * a message with no token at all is skipped (debug log), as in v3.
   */
  readonly token?: string | Redacted.Redacted<string> | undefined;
  readonly user: string;
}

/** The Pushover API rejected the message, or the request never completed. */
export class PushoverError extends Data.TaggedError("PushoverError")<{
  /** HTTP status of the rejection, or undefined when the request failed before a response. */
  readonly status: number | undefined;
  readonly body: string | undefined;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.status === undefined
      ? `Pushover request failed: ${causeMessage(this.cause)}`
      : `Pushover API returned status code ${this.status}: ${this.body ?? ""}`;
  }
}

const API_URL = "https://api.pushover.net/1/messages.json";
// A hung request would otherwise hang `Logger.flush` (and shutdown) with it.
const REQUEST_TIMEOUT = "10 seconds";

/**
 * Pushover notifications. `layerConfig` turns into a silent no-op when the
 * credentials are absent, so a dev environment needs no configuration.
 */
export class Pushover extends Context.Service<
  Pushover,
  {
    readonly enabled: boolean;
    notify(message: PushoverMessage): Effect.Effect<void, PushoverError>;
  }
>()("@micthiesen/mitools/Pushover") {
  /** Sends through the `HttpClient` service (provide `FetchHttpClient.layer`). */
  static layer(
    credentials: PushoverCredentials,
  ): Layer.Layer<Pushover, never, HttpClient.HttpClient> {
    return Layer.effect(
      Pushover,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const configuredToken =
          credentials.token === undefined
            ? undefined
            : typeof credentials.token === "string"
              ? credentials.token
              : Redacted.value(credentials.token);

        const notify = Effect.fn("Pushover.notify")(
          function* (message: PushoverMessage) {
            const token = message.token ?? configuredToken;
            if (!token) {
              yield* Effect.logDebug(
                "Pushover message skipped: no token configured or given",
              );
              return;
            }
            const body = HttpBody.urlParams({
              token,
              user: credentials.user,
              message: message.message,
              ...(message.title && { title: message.title }),
              ...(message.url && { url: message.url }),
              ...(message.url_title && { url_title: message.url_title }),
              ...(message.priority !== undefined && {
                priority: message.priority.toString(),
              }),
              ...(message.sound && { sound: message.sound }),
              ...(message.timestamp && { timestamp: message.timestamp.toString() }),
            });
            const response = yield* client.post(API_URL, { body });
            if (response.status < 200 || response.status >= 300) {
              const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
              return yield* new PushoverError({
                status: response.status,
                body: text,
                cause: undefined,
              });
            }
          },
          (effect) =>
            effect.pipe(
              Effect.timeout(REQUEST_TIMEOUT),
              Effect.catchIf(
                (error) => !(error instanceof PushoverError),
                (cause) =>
                  new PushoverError({
                    status: HttpClientError.isHttpClientError(cause)
                      ? cause.response?.status
                      : undefined,
                    body: undefined,
                    cause,
                  }),
              ),
            ),
        );

        return Pushover.of({ enabled: true, notify });
      }),
    );
  }

  /** Never sends anything. */
  static readonly layerNoop: Layer.Layer<Pushover> = Layer.succeed(
    Pushover,
    Pushover.of({ enabled: false, notify: () => Effect.void }),
  );

  /**
   * Reads `PUSHOVER_TOKEN` and `PUSHOVER_USER`. Without a user the service is
   * the no-op (a debug line says so); without a token only messages that carry
   * their own `token` are sent.
   */
  static readonly layerConfig: Layer.Layer<
    Pushover,
    Config.ConfigError,
    HttpClient.HttpClient
  > = Layer.unwrap(
    Effect.gen(function* () {
      const { token, user } = yield* Config.all({
        token: Config.redacted("PUSHOVER_TOKEN").pipe(Config.withDefault(undefined)),
        user: Config.string("PUSHOVER_USER").pipe(Config.withDefault(undefined)),
      });
      if (!user) {
        yield* Effect.logDebug("Pushover disabled: PUSHOVER_USER not set");
        return Pushover.layerNoop;
      }
      return Pushover.layer({ token, user });
    }),
  );

  /**
   * A `Logger` error hook that forwards every `error` log to Pushover: the
   * old default behaviour, now opt-in via `Logger.layer({ onError: Pushover.logHook })`.
   * A delivery failure is written to the console (never re-logged, which would loop).
   */
  static readonly logHook: LogHook<Pushover> = (notification) =>
    Pushover.use((pushover) =>
      pushover.notify({
        title: `Error: ${notification.title}`,
        message: notification.body,
      }),
    ).pipe(
      Effect.catch((error) =>
        Console.error("Failed to send Pushover notification:", error.message),
      ),
    );
}

/** Sends through the `Pushover` service. */
export const notify = (message: PushoverMessage) =>
  Pushover.use((pushover) => pushover.notify(message));
