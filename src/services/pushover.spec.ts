import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { TestConsole } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { LogLevel } from "../logging/types.js";
import { Pushover, PushoverError } from "./pushover.js";

const API_URL = "https://api.pushover.net/1/messages.json";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
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

const ok = () => new Response(JSON.stringify({ status: 1 }), { status: 200 });

const pushoverLayer = (http: FakeHttp) =>
  Pushover.layer({ token: "tok", user: "usr" }).pipe(Layer.provide(http.layer));

const configuredLayer = (http: FakeHttp, env: Record<string, string>) =>
  Pushover.layerConfig.pipe(
    Layer.provide(http.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const failureOf = <A, E>(result: Result.Result<A, E>): E =>
  Result.isFailure(result) ? result.failure : assert.fail("expected a failure");

const formFields = (body: string | undefined) => new URLSearchParams(body ?? "");

describe("Pushover", () => {
  it.effect("without a configured token sends only messages that carry one", () =>
    Effect.gen(function* () {
      const http = fakeFetch(ok);
      const layer = Pushover.layer({ user: "usr" }).pipe(Layer.provide(http.layer));
      yield* Effect.gen(function* () {
        const pushover = yield* Pushover;
        yield* pushover.notify({ title: "t", message: "skipped" });
        yield* pushover.notify({ title: "t", message: "sent", token: "per-message" });
      }).pipe(Effect.provide(layer));
      assert.strictEqual(http.calls.length, 1);
      assert.strictEqual(formFields(http.calls[0]?.body).get("token"), "per-message");
      assert.strictEqual(formFields(http.calls[0]?.body).get("message"), "sent");
    }),
  );

  it.effect("layerConfig with a user but no token still sends per-message tokens", () =>
    Effect.gen(function* () {
      const http = fakeFetch(ok);
      const enabled = yield* Effect.map(Pushover, (p) => p.enabled).pipe(
        Effect.provide(configuredLayer(http, { PUSHOVER_USER: "usr" })),
      );
      assert.isTrue(enabled);
    }),
  );

  it.effect("posts a form-encoded message to the Pushover API", () =>
    Effect.gen(function* () {
      const http = fakeFetch(ok);
      yield* Pushover.use((pushover) =>
        pushover.notify({
          message: "the body",
          title: "the title",
          url: "https://example.test",
          priority: 1,
        }),
      ).pipe(Effect.provide(pushoverLayer(http)));

      assert.strictEqual(http.calls.length, 1);
      const call = http.calls[0];
      assert.strictEqual(call?.url, API_URL);
      assert.strictEqual(call?.method, "POST");
      assert.strictEqual(
        call?.headers.get("content-type"),
        "application/x-www-form-urlencoded",
      );
      const params = formFields(call?.body);
      assert.strictEqual(params.get("token"), "tok");
      assert.strictEqual(params.get("user"), "usr");
      assert.strictEqual(params.get("message"), "the body");
      assert.strictEqual(params.get("title"), "the title");
      assert.strictEqual(params.get("url"), "https://example.test");
      assert.strictEqual(params.get("priority"), "1");
    }),
  );

  it.effect("fails with the status and body when the API rejects the message", () =>
    Effect.gen(function* () {
      const http = fakeFetch(
        () => new Response("application token is invalid", { status: 400 }),
      );
      const result = yield* Pushover.use((pushover) =>
        pushover.notify({ message: "m", title: "t" }),
      ).pipe(Effect.result, Effect.provide(pushoverLayer(http)));

      const error = failureOf(result);
      assert.instanceOf(error, PushoverError);
      assert.strictEqual(error.status, 400);
      assert.strictEqual(error.body, "application token is invalid");
      assert.include(error.message, "status code 400");
    }),
  );

  it.effect("fails without a status when the request never completes", () =>
    Effect.gen(function* () {
      const http = fakeFetch(() => Promise.reject(new Error("network down")));
      const result = yield* Pushover.use((pushover) =>
        pushover.notify({ message: "m", title: "t" }),
      ).pipe(Effect.result, Effect.provide(pushoverLayer(http)));

      const error = failureOf(result);
      assert.instanceOf(error, PushoverError);
      assert.strictEqual(error.status, undefined);
      assert.include(error.message, "Pushover request failed");
    }),
  );

  it.effect("layerNoop sends nothing", () =>
    Effect.gen(function* () {
      const http = fakeFetch(ok);
      const enabled = yield* Pushover.use((pushover) =>
        pushover.notify({ message: "m", title: "t" }).pipe(Effect.as(pushover.enabled)),
      ).pipe(Effect.provide(Layer.merge(Pushover.layerNoop, http.layer)));

      assert.isFalse(enabled);
      assert.strictEqual(http.calls.length, 0);
    }),
  );

  it.effect("layerConfig is disabled without credentials", () =>
    Effect.gen(function* () {
      const http = fakeFetch(ok);
      const enabled = yield* Pushover.use((pushover) =>
        Effect.succeed(pushover.enabled),
      ).pipe(Effect.provide(configuredLayer(http, {})));

      assert.isFalse(enabled);
    }),
  );

  it.effect(
    "layerConfig is enabled when PUSHOVER_TOKEN and PUSHOVER_USER are set",
    () =>
      Effect.gen(function* () {
        const http = fakeFetch(ok);
        const enabled = yield* Pushover.use((pushover) =>
          pushover
            .notify({ message: "m", title: "t" })
            .pipe(Effect.as(pushover.enabled)),
        ).pipe(
          Effect.provide(
            configuredLayer(http, {
              PUSHOVER_TOKEN: "env-token",
              PUSHOVER_USER: "env-user",
            }),
          ),
        );

        assert.isTrue(enabled);
        const params = formFields(http.calls[0]?.body);
        assert.strictEqual(params.get("token"), "env-token");
        assert.strictEqual(params.get("user"), "env-user");
      }),
  );

  it.effect("logHook forwards an error notification", () =>
    Effect.gen(function* () {
      const http = fakeFetch(ok);
      yield* Pushover.logHook({
        level: LogLevel.ERROR,
        loggerName: "Main",
        title: "it broke",
        body: "the details",
      }).pipe(Effect.provide(pushoverLayer(http)));

      const params = formFields(http.calls[0]?.body);
      assert.strictEqual(params.get("title"), "Error: it broke");
      assert.strictEqual(params.get("message"), "the details");
    }),
  );

  it.effect("logHook swallows a delivery failure and reports it to the console", () =>
    Effect.gen(function* () {
      const http = fakeFetch(() => new Response("nope", { status: 500 }));
      yield* Pushover.logHook({
        level: LogLevel.ERROR,
        loggerName: "Main",
        title: "it broke",
        body: "the details",
      }).pipe(Effect.provide(pushoverLayer(http)));

      const errors = yield* TestConsole.errorLines;
      assert.include(
        errors.map((line) => String(line)).join(" "),
        "Failed to send Pushover notification:",
      );
    }),
  );
});
