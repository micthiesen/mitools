import { HTTPError } from "got";

export interface HttpErrorInfo {
  statusCode: number;
  statusMessage: string;
  body: unknown;
  url: string;
  method: string;
}

/**
 * Extracts clean, loggable info from a got HTTPError.
 * Returns the original error if it's not an HTTPError.
 */
export function extractHttpError(error: unknown): HttpErrorInfo | unknown {
  if (!(error instanceof HTTPError)) return error;

  const { response } = error;
  let body: unknown = response.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // keep as string
    }
  }

  return {
    statusCode: response.statusCode,
    statusMessage: response.statusMessage ?? "",
    body,
    url: response.url,
    method: response.request?.options?.method ?? "UNKNOWN",
  };
}
