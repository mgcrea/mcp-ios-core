import { IosError } from "#/errors";

export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: (TextContent | ImageContent)[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. `null, 2` adds a fifth to a third to every
 * response, worst on wide lists of short-keyed objects — which is exactly the
 * shape a flattened UI tree returns.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/** Return text as-is, for anything a model should read rather than parse. */
export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

/**
 * An image plus its metadata, in that order. The metadata line is not optional
 * decoration: it carries the coordinate space, and a caller that reads pixel
 * positions off the image without knowing what space it is in will tap the
 * wrong place with nothing looking wrong.
 */
export const okImage = (image: ImageContent, meta: unknown): ToolResult => ({
  content: [image, { type: "text", text: JSON.stringify(meta) }],
});

/**
 * `extra` is spread at the top level, not nested under `details`, so a `remedy`
 * lands beside the error rather than three levels inside an envelope. The remedy
 * is the half a model should act on, and a nested one gets skimmed past.
 */
export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/** Render a thrown value as a tool error, preserving the remedy and any detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof IosError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
  }
  if (err instanceof Error) return fail(err.message);
  return fail("Unknown error", { details: err });
};

/** Run a tool body, JSON-formatting the result and turning throws into tool errors. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/** Like `wrap`, but the body chooses its own result shape (an image, raw text). */
export const wrapResult = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return toFailure(err);
  }
};

/** Drop undefined values so an optional argument is omitted rather than sent empty. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
