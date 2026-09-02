import { Config, Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { causeMessage } from "../errors/index.js";

export interface AddBookmarkInput {
  url: string;
  archived?: boolean;
  tags?: string[];
  note?: string;
}

export interface KarakeepCredentials {
  readonly baseUrl: string;
  readonly apiKey: string | Redacted.Redacted<string>;
}

/** A Karakeep API call failed (transport, status, decode, or timeout). */
export class KarakeepError extends Data.TaggedError("KarakeepError")<{
  readonly operation: "createBookmark" | "attachTags";
  readonly url: string | undefined;
  readonly bookmarkId: string | undefined;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Karakeep ${this.operation} failed: ${causeMessage(this.cause)}`;
  }
}

/** `Karakeep.layerConfig` found no `KARAKEEP_URL` / `KARAKEEP_API_KEY`. */
export class KarakeepDisabledError extends Data.TaggedError("KarakeepDisabledError") {
  override get message(): string {
    return "Karakeep integration disabled (KARAKEEP_URL / KARAKEEP_API_KEY not set)";
  }
}

const BookmarkResponse = Schema.Struct({ id: Schema.String });

const REQUEST_TIMEOUT = "10 seconds";

export class Karakeep extends Context.Service<
  Karakeep,
  {
    readonly enabled: boolean;
    createBookmark(
      input: Omit<AddBookmarkInput, "tags">,
    ): Effect.Effect<{ id: string }, KarakeepError | KarakeepDisabledError>;
    attachTags(
      bookmarkId: string,
      tags: string[],
    ): Effect.Effect<void, KarakeepError | KarakeepDisabledError>;
    /** The dashboard URL of a bookmark. */
    bookmarkUrl(bookmarkId: string): string;
    /**
     * Creates the bookmark, attaches `tags`, and resolves the dashboard URL.
     * A tag failure still fails (with the `bookmarkId` on the error) so the
     * caller can see the bookmark exists.
     */
    addBookmark(
      input: AddBookmarkInput,
    ): Effect.Effect<string, KarakeepError | KarakeepDisabledError>;
  }
>()("@micthiesen/mitools/Karakeep") {
  static layer(
    credentials: KarakeepCredentials,
  ): Layer.Layer<Karakeep, never, HttpClient.HttpClient> {
    return Layer.effect(
      Karakeep,
      Effect.gen(function* () {
        const apiKey =
          typeof credentials.apiKey === "string"
            ? credentials.apiKey
            : Redacted.value(credentials.apiKey);
        const client = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest((request) =>
            request.pipe(
              HttpClientRequest.prependUrl(`${credentials.baseUrl}/api/v1`),
              HttpClientRequest.bearerToken(apiKey),
              HttpClientRequest.setHeader("Content-Type", "application/json"),
            ),
          ),
          HttpClient.filterStatusOk,
          HttpClient.retryTransient({ times: 2 }),
        );

        const bookmarkUrl = (bookmarkId: string) =>
          `${credentials.baseUrl}/dashboard/preview/${bookmarkId}`;

        const createBookmark = Effect.fn("Karakeep.createBookmark")(
          function* (input: Omit<AddBookmarkInput, "tags">) {
            const response = yield* client.post("/bookmarks", {
              body: HttpBody.jsonUnsafe({
                type: "link",
                url: input.url,
                archived: input.archived ?? false,
                note: input.note,
              }),
            });
            const json = yield* response.json;
            return yield* Schema.decodeUnknownEffect(BookmarkResponse)(json);
          },
          (effect, input) =>
            effect.pipe(
              Effect.timeout(REQUEST_TIMEOUT),
              Effect.mapError(
                (cause) =>
                  new KarakeepError({
                    operation: "createBookmark",
                    url: input.url,
                    bookmarkId: undefined,
                    cause,
                  }),
              ),
            ),
        );

        const attachTags = Effect.fn("Karakeep.attachTags")(
          function* (bookmarkId: string, tags: string[]) {
            yield* client.post(`/bookmarks/${bookmarkId}/tags`, {
              body: HttpBody.jsonUnsafe({ tags: tags.map((tagName) => ({ tagName })) }),
            });
          },
          (effect, bookmarkId) =>
            effect.pipe(
              Effect.timeout(REQUEST_TIMEOUT),
              Effect.mapError(
                (cause) =>
                  new KarakeepError({
                    operation: "attachTags",
                    url: undefined,
                    bookmarkId,
                    cause,
                  }),
              ),
            ),
        );

        const addBookmark = Effect.fn("Karakeep.addBookmark")(function* (
          input: AddBookmarkInput,
        ) {
          const { id } = yield* createBookmark(input);
          if (input.tags?.length) yield* attachTags(id, input.tags);
          return bookmarkUrl(id);
        });

        return Karakeep.of({
          enabled: true,
          createBookmark,
          attachTags,
          bookmarkUrl,
          addBookmark,
        });
      }),
    );
  }

  /** Every call fails with `KarakeepDisabledError`. */
  static readonly layerDisabled: Layer.Layer<Karakeep> = Layer.succeed(
    Karakeep,
    Karakeep.of({
      enabled: false,
      createBookmark: () => new KarakeepDisabledError(),
      attachTags: () => new KarakeepDisabledError(),
      bookmarkUrl: (bookmarkId) => bookmarkId,
      addBookmark: () => new KarakeepDisabledError(),
    }),
  );

  /** Reads `KARAKEEP_URL` and `KARAKEEP_API_KEY`; disabled when either is missing. */
  static readonly layerConfig: Layer.Layer<
    Karakeep,
    Config.ConfigError,
    HttpClient.HttpClient
  > = Layer.unwrap(
    Effect.gen(function* () {
      const { baseUrl, apiKey } = yield* Config.all({
        baseUrl: Config.string("KARAKEEP_URL").pipe(Config.withDefault(undefined)),
        apiKey: Config.redacted("KARAKEEP_API_KEY").pipe(Config.withDefault(undefined)),
      });
      if (!baseUrl || !apiKey) {
        yield* Effect.logDebug(
          "Karakeep disabled: KARAKEEP_URL / KARAKEEP_API_KEY not set",
        );
        return Karakeep.layerDisabled;
      }
      return Karakeep.layer({ baseUrl, apiKey });
    }),
  );
}

/** Adds a bookmark through the `Karakeep` service and resolves its dashboard URL. */
export const addBookmark = (input: AddBookmarkInput) =>
  Karakeep.use((karakeep) => karakeep.addBookmark(input));
