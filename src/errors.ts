/**
 * One class per failure mode, and each carries the remedy separately from the
 * message. The message says what happened; the remedy is the half a model should
 * act on, and `fail()` lifts it to a top-level field rather than burying it.
 *
 * Nothing here names a tool, an environment variable or a kind of target. That
 * is deliberate and it is what makes the taxonomy shareable: a physical device
 * and a simulator fail in the same shapes but are fixed by different words, so
 * the words arrive as arguments. The two servers hand in their own copy, and a
 * consumer of this module that hands in none still gets a correct — if terser —
 * message.
 */
export class IosError extends Error {
  override readonly name: string = "IosError";
  readonly remedy: string | undefined;
  readonly details: unknown;

  constructor(message: string, opts: { remedy?: string; details?: unknown } = {}) {
    super(message);
    this.remedy = opts.remedy;
    this.details = opts.details;
  }
}

/** An `xcrun` / `sips` invocation exited non-zero. */
export class CommandError extends IosError {
  override readonly name = "CommandError";
  readonly command: string;
  readonly exitCode: number | null;

  constructor(
    message: string,
    opts: { command: string; exitCode: number | null; remedy?: string; details?: unknown },
  ) {
    super(message, opts);
    this.command = opts.command;
    this.exitCode = opts.exitCode;
  }
}

/** The child process outlived its budget and was killed. */
export class CommandTimeoutError extends IosError {
  override readonly name = "CommandTimeoutError";

  constructor(command: string, timeoutMs: number, remedy?: string) {
    super(
      `\`${command}\` did not finish within ${timeoutMs}ms and was killed.`,
      remedy ? { remedy } : {},
    );
  }
}

/** Xcode's command line tools are not where we expected them. */
export class ToolchainError extends IosError {
  override readonly name = "ToolchainError";

  constructor(path: string, remedy?: string) {
    super(
      `${path} not found — this server only runs on macOS with Xcode installed.`,
      remedy ? { remedy } : {},
    );
  }
}

/**
 * WebDriverAgent is not answering. Distinguished from every other failure
 * because the fix is entirely different — nothing is wrong with the target, the
 * runner just is not up.
 */
export class WdaUnavailableError extends IosError {
  override readonly name = "WdaUnavailableError";

  constructor(url: string, cause: string, remedy?: string) {
    super(`WebDriverAgent is not reachable at ${url} (${cause}).`, remedy ? { remedy } : {});
  }
}

/** WebDriverAgent answered, but with an error. */
export class WdaError extends IosError {
  override readonly name = "WdaError";
  readonly status: number;
  readonly wdaCode: string | undefined;

  constructor(
    message: string,
    opts: { status: number; wdaCode?: string; remedy?: string; details?: unknown },
  ) {
    super(message, opts);
    this.status = opts.status;
    this.wdaCode = opts.wdaCode;
  }
}
