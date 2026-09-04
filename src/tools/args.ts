import { z } from "zod";

import { toolNames, type ScreenNaming } from "#/screen";

/**
 * The argument atoms every shared tool is built from.
 *
 * A factory rather than a set of constants because each one names sibling tools
 * inside its `.describe()`, and those names differ per server. The discipline
 * that keeps this readable: **interpolate names, never assemble a sentence from
 * clauses.** The prose below is the only thing a model reads before choosing a
 * tool and deciding what to put in it, so it stays written out in full.
 */
export const createArgs = (naming: ScreenNaming) => {
  const names = toolNames(naming);
  const { noun } = naming;

  return {
    /** Which target to act on. Optional — one is the normal case. */
    targetArg: z
      .string()
      .optional()
      .describe(
        naming.copy?.target ??
          `Which ${noun}: its identifier or name as shown by ${names.listTargets}. Omit it when ` +
            `only one is available, and set ${naming.envPrefix}_ID to pin it when more than one is.`,
      ),

    bundleIdArg: z
      .string()
      .regex(
        /^[A-Za-z0-9.-]+$/,
        "A bundle id is dot-separated alphanumerics, e.g. `io.mgcrea.Canopy` — not an app name or a path.",
      )
      .describe(
        `The app's bundle identifier, e.g. "io.mgcrea.Canopy". List them with ${names.listApps}.`,
      ),

    /**
     * Every coordinate these servers accept or return is in points. That is not
     * an arbitrary choice: it is the space the UI tree's rects are in, and the
     * space a default screenshot image is scaled to, so a position read from
     * either can be passed here unchanged.
     */
    xArg: z
      .number()
      .describe(
        "Horizontal position in points, from the left edge. This is the same space as the `tap` " +
          `field from ${names.uiTree} and as a default ${names.screenshot} image — no conversion.`,
      ),

    yArg: z
      .number()
      .describe(
        `Vertical position in points, from the top edge. Same space as ${names.uiTree} \`tap\` and ` +
          `a default ${names.screenshot} image.`,
      ),

    /** Destructive tools require this, so an agent can never trigger one in passing. */
    confirmArg: z
      .literal(true)
      .describe(
        `Must be true. Explicit acknowledgement that this changes state on a real ${noun}.`,
      ),

    detailArg: z
      .enum(["interactive", "labelled", "all"])
      .default("interactive")
      .describe(
        "How much of the hierarchy to return. `interactive` (default) is controls only — buttons, " +
          "cells, fields, switches — and is what you want to decide where to tap. `labelled` adds " +
          "text and images that carry a label, for reading the screen's content. `all` is every " +
          "visible node and is usually far too large to be useful.",
      ),

    screenshotArg: z
      .boolean()
      .default(true)
      .describe(
        "Return a screenshot of the resulting screen. On by default, and worth leaving on: it is " +
          "how you find out that the action landed where you meant it to. Turn it off only for a " +
          "sequence whose intermediate states you do not need to see.",
      ),

    settleArg: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(600)
      .describe(
        "Milliseconds to wait before the follow-up screenshot, so an animation finishes first. " +
          "Raise it for a screen that loads data; a capture taken mid-transition shows neither state.",
      ),
  };
};

export type ScreenArgs = ReturnType<typeof createArgs>;
