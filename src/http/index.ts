import { HttpClientError } from "effect/unstable/http";

export interface HttpErrorInfo {
  /** The failing reason's tag: TransportError, StatusCodeError, DecodeError, ... */
  kind: string;
  statusCode?: number;
  url: string;
  method: string;
  description?: string;
  message: string;
}

/**
 * Extracts clean, loggable info from an `HttpClientError` (effect/unstable/http).
 * Returns the original value if it's not an HttpClientError.
 */
export function httpErrorInfo(error: unknown): HttpErrorInfo | unknown {
  if (!HttpClientError.isHttpClientError(error)) return error;
  const { reason } = error;
  return {
    kind: reason._tag,
    statusCode: error.response?.status,
    url: error.request.url,
    method: error.request.method,
    description: "description" in reason ? reason.description : undefined,
    message: error.message,
  } satisfies HttpErrorInfo;
}
