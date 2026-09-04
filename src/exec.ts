import { execFile } from "node:child_process";

import { CommandError, CommandTimeoutError, ToolchainError } from "#/errors";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export type ExecResult = { stdout: string; stderr: string };

/**
 * The process boundary, as a seam. Tests substitute this so that everything
 * above it — argv construction, JSON envelope handling, error mapping — still
 * runs for real; mocking the command wrapper itself would skip exactly the
 * code those guarantees live in.
 */
export type ExecImpl = (path: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

/**
 * The words a failure is explained with. Every one of these is target-specific —
 * "unlock the device" means nothing to a simulator, and "boot it first" means
 * nothing to a phone — so they arrive from the server rather than being written
 * here.
 */
export type ExecCopy = {
  /** Remedy for a killed-on-timeout child. */
  timeout?: string;
  /** Remedy for a missing `xcrun` / `sips`. */
  toolchain?: string;
  /**
   * Map a tool's own stderr prose onto a fix. The interesting failures are
   * reported in prose and each has a different remedy, so saying which one it is
   * here is the difference between one retry and five.
   */
  remedyFor?: (stderr: string) => string | undefined;
};

// A tool's own `--json-output` files are small, but `sips` and a base64
// screenshot are not. 64 MiB is well clear of a 1320x2868 PNG.
const MAX_BUFFER = 64 * 1024 * 1024;

// Inherit nothing but a PATH. xcrun resolves DEVELOPER_DIR from the active
// toolchain on its own, and a minimal environment removes any question of a
// stray locale or SDK override changing the output shape.
const MINIMAL_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

const describeFailure = (path: string, args: string[], stderr: string, stdout: string): string => {
  const label = `${path.split("/").pop()} ${args.slice(0, 3).join(" ")}`.trim();
  const detail = (stderr || stdout).trim().split("\n").slice(0, 6).join(" ").slice(0, 400);
  return detail ? `\`${label}\` failed: ${detail}` : `\`${label}\` failed with no output.`;
};

/** The shared failure mapping, over whichever stdout representation was captured. */
const toError = (
  err: NodeJS.ErrnoException & { killed?: boolean; code?: string | number },
  path: string,
  args: string[],
  timeoutMs: number,
  stdout: string,
  stderr: string,
  copy: ExecCopy,
): Error => {
  if (err.killed) {
    return new CommandTimeoutError(`${path} ${args[0] ?? ""}`.trim(), timeoutMs, copy.timeout);
  }
  if (err.code === "ENOENT") return new ToolchainError(path, copy.toolchain);
  const remedy = copy.remedyFor?.(stderr);
  return new CommandError(describeFailure(path, args, stderr, stdout), {
    command: `${path} ${args.join(" ")}`,
    exitCode: typeof err.code === "number" ? err.code : null,
    ...(remedy ? { remedy } : {}),
    details: (stderr || stdout).trim().slice(0, 2000),
  });
};

/**
 * `execFile`, never `exec` — there is no shell, so there is no quoting question
 * to get wrong. Every caller-supplied value (a bundle id, a device name, a file
 * path) arrives as its own argv entry and is therefore data, not syntax. There
 * is no code path in either server where a command is built by interpolating a
 * string, and `assertNoShellMetachars` below is the tripwire that keeps it so.
 */
export const createExec =
  (copy: ExecCopy = {}): ExecImpl =>
  (path, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        path,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
          killSignal: "SIGKILL",
          encoding: "utf8",
          env: MINIMAL_ENV,
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ stdout, stderr });
            return;
          }
          reject(toError(err as never, path, args, timeoutMs, stdout, stderr, copy));
        },
      );
    });

/**
 * Refuse a value that looks like it was meant to be interpreted by a shell.
 * Crude on purpose: nothing here ever reaches a shell, so a false positive costs
 * one renamed file and a false negative would be the bug these servers must
 * never have. It runs on paths, which are the one argument class that also flows
 * into `sips` output filenames.
 */
export const assertNoShellMetachars = (label: string, value: string): void => {
  if (/[;&|`$<>\n\r]/.test(value)) {
    throw new CommandError(`Refusing to use ${label} containing shell metacharacters: ${value}`, {
      command: label,
      exitCode: null,
      remedy: "Pass a plain path or identifier with no `;` `&` `|` `` ` `` `$` `<` `>` in it.",
    });
  }
};
