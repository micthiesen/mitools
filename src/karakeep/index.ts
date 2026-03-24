import got, { type Got } from "got";
import { z } from "zod";
import { tryCatch } from "../async/index.js";
import { extractHttpError } from "../http/index.js";
import type { Logger } from "../logging/Logger.js";

export interface AddBookmarkInput {
  url: string;
  archived?: boolean;
  tags?: string[];
  note?: string;
}

const bookmarkResponseSchema = z.object({
  id: z.string(),
});

export class KarakeepClient {
  private client: Got;

  constructor(
    private baseUrl: string,
    apiKey: string,
  ) {
    this.client = got.extend({
      prefixUrl: `${baseUrl}/api/v1`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: { request: 10_000 },
      retry: { limit: 2, methods: ["POST"] },
      responseType: "json",
    });
  }

  async createBookmark(input: Omit<AddBookmarkInput, "tags">) {
    const response = await this.client.post("bookmarks", {
      json: {
        type: "link",
        url: input.url,
        archived: input.archived ?? false,
        note: input.note,
      },
    });
    return bookmarkResponseSchema.parse(response.body);
  }

  async attachTags(bookmarkId: string, tags: string[]) {
    await this.client.post(`bookmarks/${bookmarkId}/tags`, {
      json: { tags: tags.map((tagName) => ({ tagName })) },
    });
  }

  getBookmarkUrl(bookmarkId: string) {
    return `${this.baseUrl}/dashboard/preview/${bookmarkId}`;
  }
}

function getClient(): KarakeepClient | null {
  const url = process.env.KARAKEEP_URL;
  const apiKey = process.env.KARAKEEP_API_KEY;
  if (!url || !apiKey) return null;
  return new KarakeepClient(url, apiKey);
}

/**
 * Add a URL as a bookmark in Karakeep, optionally with tags and a note.
 * Returns the bookmark URL on success, undefined if disabled or on failure.
 */
export async function addBookmark(
  input: AddBookmarkInput,
  logger: Logger,
): Promise<string | undefined> {
  const client = getClient();
  if (!client) {
    logger.info("Karakeep integration disabled (missing env vars)");
    return undefined;
  }

  const result = await tryCatch(() => client.createBookmark(input));
  if (!result.ok) {
    logger.warn("Failed to add bookmark to Karakeep", {
      error: extractHttpError(result.error),
      url: input.url,
    });
    return undefined;
  }

  const bookmarkId = result.value.id;

  if (input.tags?.length) {
    const tagResult = await tryCatch(() => client.attachTags(bookmarkId, input.tags!));
    if (!tagResult.ok) {
      logger.warn("Failed to attach tags to Karakeep bookmark", {
        error: extractHttpError(tagResult.error),
        bookmarkId,
        tags: input.tags,
      });
    }
  }

  return client.getBookmarkUrl(bookmarkId);
}
