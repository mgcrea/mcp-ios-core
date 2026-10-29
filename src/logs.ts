import { open, stat } from "node:fs/promises";

import { IosError } from "#/errors";

/**
 * Reading an app's captured console, for either server.
 *
 * How the console gets into a file differs completely between the two — a
 * phone's comes through `devicectl … launch --console`, a simulator's through
 * `simctl launch --stdout/--stderr` — but once it is a growing file on this Mac
 * the reading is the same, and so are its traps: the file can be tens of
 * megabytes an hour in, its last line is usually half-written, and every line
 * carries the same thirty characters of date, zone, process and thread ids.
 */

export type LogReadOptions = {
  /** Byte offset returned as `next` by the previous read; 0 or absent reads from the start. */
  cursor?: number | undefined;
  /** Case-insensitive regular expression a line must match. */
  filter?: string | undefined;
  /** Most matching lines to return; the newest are kept. */
  limit: number;
  /**
   * Whether the writer has finished. While it runs, a final line with no
   * newline is still being written and is left for the next read; once it has
   * stopped, nothing more is coming and that line is complete.
   */
  complete: boolean;
};

export type LogReadResult = {
  lines: string[];
  /** Lines in the window that matched `filter` (all of them, with no filter). */
  matched: number;
  /** Matching lines dropped to honour `limit` — always the oldest. */
  omitted: number;
  /** Pass back as `cursor` to read only what arrives after this read. */
  next: number;
  /** Bytes between `cursor` and this window that were never read; see `MAX_READ_BYTES`. */
  skippedBytes: number;
};

/**
 * One read never looks at more than this much of the file. A chatty app was
 * measured at ~200 lines a second, and a read starting from 0 an hour in would
 * otherwise load tens of megabytes to return its last 200 lines.
 */
export const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_LINE_CHARS = 500;

/**
 * `2026-10-08 22:09:45.583026+0200 SandboxApp[13938:5106663] message` is how
 * unified logging prints when mirrored to stderr, and the date, the zone, the
 * process name and both ids are identical on every line of one app's capture.
 * Cutting them to `22:09:45.583 message` halves a typical line.
 */
const XCODE_PREFIX = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}\.\d{3})\d*[+-]\d{4} \S+\[\d+:\d+\] /;

export const compactLogLine = (line: string): string => {
  const short = line.replace(XCODE_PREFIX, "$1 ");
  return short.length > MAX_LINE_CHARS ? `${short.slice(0, MAX_LINE_CHARS)}…` : short;
};

/**
 * Read what a log file has gathered since `cursor`.
 *
 * The cursor is a byte offset, not a line number, so a read costs the same an
 * hour into a capture as it does a second in, and it only ever advances to the
 * end of the last complete line — a line still being written is never returned
 * in two halves.
 */
export const readLogFile = async (path: string, opts: LogReadOptions): Promise<LogReadResult> => {
  let pattern: RegExp | undefined;
  if (opts.filter) {
    try {
      pattern = new RegExp(opts.filter, "i");
    } catch (err) {
      throw new IosError(`\`filter\` is not a valid regular expression: ${String(err)}`, {
        remedy: "Escape regex characters, e.g. `\\[Sync\\]`, or pass a plain word.",
      });
    }
  }

  const size = (await stat(path)).size;
  let start = Math.min(Math.max(opts.cursor ?? 0, 0), size);
  let skippedBytes = 0;
  if (size - start > MAX_READ_BYTES) {
    skippedBytes = size - MAX_READ_BYTES - start;
    start = size - MAX_READ_BYTES;
  }

  const handle = await open(path, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
  } finally {
    await handle.close();
  }

  // Cut on the raw bytes, not the decoded text: a window that starts inside a
  // multi-byte character, or a line of invalid UTF-8, decodes to U+FFFD, which
  // re-encodes longer than the bytes it replaced and would push `next` past
  // the start of the following line.
  const end = opts.complete ? buffer.length : buffer.lastIndexOf(0x0a) + 1;
  const next = start + end;
  const text = buffer.subarray(0, end).toString("utf8");
  // `\r\n`, not `\n`: an app's stdout bridged through `devicectl --console`
  // arrives with CRLF endings — measured on iOS 27.0 — while its mirrored
  // unified log on stderr does not, so one capture holds both.
  let lines = text.split(/\r?\n/);
  if (skippedBytes > 0) lines = lines.slice(1); // started mid-line
  lines = lines.filter((line) => line.length > 0);

  const matching = pattern ? lines.filter((line) => pattern.test(line)) : lines;
  const kept = matching.slice(-opts.limit);
  return {
    lines: kept.map(compactLogLine),
    matched: matching.length,
    omitted: matching.length - kept.length,
    next,
    skippedBytes,
  };
};
