import { describe, expect, it } from "@effect/vitest";
import {
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { type HttpErrorInfo, httpErrorInfo } from "./index.js";

const request = HttpClientRequest.get("https://example.com/x");

const statusCodeError = (status: number, description?: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: HttpClientResponse.fromWeb(request, new Response("body", { status })),
      description,
    }),
  });

describe("httpErrorInfo", () => {
  it("returns non-HttpClientError values unchanged", () => {
    const error = new Error("plain");
    expect(httpErrorInfo(error)).toBe(error);
    expect(httpErrorInfo("nope")).toBe("nope");
    expect(httpErrorInfo(undefined)).toBeUndefined();
    expect(httpErrorInfo(null)).toBeNull();
  });

  it("extracts kind, status, url and method from a StatusCodeError", () => {
    const info = httpErrorInfo(statusCodeError(503, "nope")) as HttpErrorInfo;

    expect(info.kind).toBe("StatusCodeError");
    expect(info.statusCode).toBe(503);
    expect(info.url).toBe("https://example.com/x");
    expect(info.method).toBe("GET");
    expect(info.description).toBe("nope");
    expect(info.message).toBeTypeOf("string");
  });

  it("leaves description undefined when the reason has none", () => {
    const info = httpErrorInfo(statusCodeError(404)) as HttpErrorInfo;

    expect(info.kind).toBe("StatusCodeError");
    expect(info.statusCode).toBe(404);
    expect(info.description).toBeUndefined();
  });

  it("omits statusCode for reasons without a response", () => {
    const error = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        description: "socket hang up",
      }),
    });

    const info = httpErrorInfo(error) as HttpErrorInfo;

    expect(info.kind).toBe("TransportError");
    expect(info.statusCode).toBeUndefined();
    expect(info.url).toBe("https://example.com/x");
    expect(info.method).toBe("GET");
    expect(info.description).toBe("socket hang up");
  });

  it("reports the method of a non-GET request", () => {
    const post = HttpClientRequest.make("POST")("https://example.com/y");
    const error = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request: post }),
    });

    const info = httpErrorInfo(error) as HttpErrorInfo;

    expect(info.method).toBe("POST");
    expect(info.url).toBe("https://example.com/y");
  });
});
