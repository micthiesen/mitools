import { once } from "node:events";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { Karakeep, KarakeepDisabledError, KarakeepError } from "./index.js";

const BASE_URL = "https://kk.test";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
  readonly signal: AbortSignal | null | undefined;
}

const decodeBody = (body: BodyInit | null | undefined): string => {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return String(body);
};

/** A `Fetch` implementation that records every call and replies from `respond`. */
const fakeFetch = (
  respond: (call: FetchCall, index: number) => Response | Promise<Response>,
) => {
  const calls: FetchCall[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: decodeBody(init?.body),
      signal: init?.signal,
    };
    calls.push(call);
    return Promise.resolve(respond(call, calls.length - 1));
  };
  return {
    calls,
    layer: FetchHttpClient.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
      ),
    ),
  };
};

type FakeHttp = ReturnType<typeof fakeFetch>;

/** A response that only settles when the caller aborts the request. */
const untilAborted = (call: FetchCall): Promise<Response> =>
  call.signal
    ? once(call.signal, "abort").then((): Response => {
        throw new Error("request aborted");
      })
    : Promise.reject(new Error("expected an abort signal"));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const karakeepLayer = (http: FakeHttp) =>
  Karakeep.layer({ baseUrl: BASE_URL, apiKey: "k" }).pipe(Layer.provide(http.layer));

const configuredLayer = (http: FakeHttp, env: Record<string, string>) =>
  Karakeep.layerConfig.pipe(
    Layer.provide(http.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const failureOf = <A, E>(result: Result.Result<A, E>): E =>
  Result.isFailure(result) ? result.failure : assert.fail("expected a failure");

const karakeepError = (error: KarakeepError | KarakeepDisabledError): KarakeepError =>
  error instanceof KarakeepError
    ? error
    : assert.fail(`expected a KarakeepError, got ${error._tag}`);

describe("Karakeep", () => {
  it.effect("createBookmark posts an authenticated link bookmark", () =>
    Effect.gen(function* () {
      const http = fakeFetch(() => json({ id: "bm-1" }));
      const bookmark = yield* Karakeep.use((karakeep) =>
        karakeep.createBookmark({ url: "https://example.test/post" }),
      ).pipe(Effect.provide(karakeepLayer(http)));

      assert.deepStrictEqual(bookmark, { id: "bm-1" });
      assert.strictEqual(http.calls.length, 1);
      const call = http.calls[0];
      assert.strictEqual(call?.url, `${BASE_URL}/api/v1/bookmarks`);
      assert.strictEqual(call?.method, "POST");
      assert.strictEqual(call?.headers.get("authorization"), "Bearer k");
      assert.deepStrictEqual(JSON.parse(call?.body ?? "null"), {
        type: "link",
        url: "https://example.test/post",
        archived: false,
      });
    }),
  );

  it.effect("attachTags posts tag names for a bookmark", () =>
    Effect.gen(function* () {
      const http = fakeFetch(() => json({}));
      yield* Karakeep.use((karakeep) =>
        karakeep.attachTags("bm-1", ["alpha", "beta"]),
      ).pipe(Effect.provide(karakeepLayer(http)));

      const call = http.calls[0];
      assert.strictEqual(call?.url, `${BASE_URL}/api/v1/bookmarks/bm-1/tags`);
      assert.strictEqual(call?.method, "POST");
      assert.deepStrictEqual(JSON.parse(call?.body ?? "null"), {
        tags: [{ tagName: "alpha" }, { tagName: "beta" }],
      });
    }),
  );

  it.effect("addBookmark creates, tags and resolves the dashboard URL", () =>
    Effect.gen(function* () {
      const http = fakeFetch((call) =>
        call.url.endsWith("/tags") ? json({}) : json({ id: "bm-42" }),
      );
      const url = yield* Karakeep.use((karakeep) =>
        karakeep.addBookmark({ url: "https://example.test/post", tags: ["alpha"] }),
      ).pipe(Effect.provide(karakeepLayer(http)));

      assert.strictEqual(url, `${BASE_URL}/dashboard/preview/bm-42`);
      assert.strictEqual(http.calls.length, 2);
    }),
  );

  it.effect("retries a transient tag failure and reports the bookmark id", () =>
    Effect.gen(function* () {
      const http = fakeFetch(() => json({ error: "boom" }, 500));
      const result = yield* Karakeep.use((karakeep) =>
        karakeep.attachTags("bm-7", ["alpha"]),
      ).pipe(Effect.result, Effect.provide(karakeepLayer(http)));

      const error = karakeepError(failureOf(result));
      assert.strictEqual(error.operation, "attachTags");
      assert.strictEqual(error.bookmarkId, "bm-7");
      assert.strictEqual(error.url, undefined);
      // The client retries transient errors twice.
      assert.strictEqual(http.calls.length, 3);
    }),
  );

  it.effect("does not retry a 401 and reports the bookmark url", () =>
    Effect.gen(function* () {
      const http = fakeFetch(() => json({ error: "unauthorized" }, 401));
      const result = yield* Karakeep.use((karakeep) =>
        karakeep.createBookmark({ url: "https://example.test/post" }),
      ).pipe(Effect.result, Effect.provide(karakeepLayer(http)));

      const error = karakeepError(failureOf(result));
      assert.strictEqual(error.operation, "createBookmark");
      assert.strictEqual(error.url, "https://example.test/post");
      assert.strictEqual(error.bookmarkId, undefined);
      assert.strictEqual(http.calls.length, 1);
    }),
  );

  it.effect("fails when the response body is not a bookmark", () =>
    Effect.gen(function* () {
      const http = fakeFetch(() => json({ identifier: 7 }));
      const result = yield* Karakeep.use((karakeep) =>
        karakeep.createBookmark({ url: "https://example.test/post" }),
      ).pipe(Effect.result, Effect.provide(karakeepLayer(http)));

      const error = karakeepError(failureOf(result));
      assert.strictEqual(error.operation, "createBookmark");
      assert.instanceOf(error.cause, Schema.SchemaError);
    }),
  );

  it.effect("times out a request that never responds", () =>
    Effect.gen(function* () {
      const http = fakeFetch(untilAborted);
      const fiber = yield* Effect.forkChild(
        Karakeep.use((karakeep) =>
          karakeep.createBookmark({ url: "https://example.test/post" }),
        ).pipe(Effect.result, Effect.provide(karakeepLayer(http))),
      );

      yield* TestClock.adjust("10 seconds");
      const error = karakeepError(failureOf(yield* Fiber.join(fiber)));
      assert.strictEqual(error.operation, "createBookmark");
      assert.strictEqual(error.url, "https://example.test/post");
    }),
  );

  it.effect("layerDisabled fails every call", () =>
    Effect.gen(function* () {
      const results = yield* Karakeep.use((karakeep) =>
        Effect.all(
          [
            Effect.result(karakeep.createBookmark({ url: "https://example.test" })),
            Effect.result(karakeep.attachTags("bm-1", ["alpha"])),
            Effect.result(karakeep.addBookmark({ url: "https://example.test" })),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map((all) => ({
            all,
            enabled: karakeep.enabled,
            url: karakeep.bookmarkUrl("bm-1"),
          })),
        ),
      ).pipe(Effect.provide(Karakeep.layerDisabled));

      assert.isFalse(results.enabled);
      assert.strictEqual(results.url, "bm-1");
      const [created, tagged, added] = results.all;
      assert.instanceOf(failureOf(created), KarakeepDisabledError);
      assert.instanceOf(failureOf(tagged), KarakeepDisabledError);
      assert.instanceOf(failureOf(added), KarakeepDisabledError);
    }),
  );

  it.effect("layerConfig is disabled without credentials", () =>
    Effect.gen(function* () {
      const http = fakeFetch(() => json({}));
      const enabled = yield* Karakeep.use((karakeep) =>
        Effect.succeed(karakeep.enabled),
      ).pipe(Effect.provide(configuredLayer(http, {})));

      assert.isFalse(enabled);
    }),
  );

  it.effect("layerConfig is enabled with KARAKEEP_URL and KARAKEEP_API_KEY", () =>
    Effect.gen(function* () {
      const http = fakeFetch(() => json({ id: "bm-9" }));
      const bookmark = yield* Karakeep.use((karakeep) =>
        karakeep.createBookmark({ url: "https://example.test" }),
      ).pipe(
        Effect.provide(
          configuredLayer(http, {
            KARAKEEP_URL: BASE_URL,
            KARAKEEP_API_KEY: "env-key",
          }),
        ),
      );

      assert.deepStrictEqual(bookmark, { id: "bm-9" });
      assert.strictEqual(http.calls[0]?.headers.get("authorization"), "Bearer env-key");
    }),
  );
});
