// How the three tools that address an element by name turn a caller's argument
// into something WebDriverAgent can search for.
//
// This used to live inline in `tap_element`, with a hand-copied half of it in
// `type`. The two had already drifted — `type` accepted `id` and `label`
// together and silently let `id` win — which is the drift the core exists to
// prevent, so the whole thing is one module now.

import { IosError } from "#/errors";
import { INTERACTIVE_TYPES } from "#/ui-tree";
import type { Locator } from "#/wda/client";

/** NSPredicate strings are double-quoted; a label containing one would end it early. */
export const quote = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The clause that keeps a tap off a container.
 *
 * A label is not unique and the hierarchy is nested, so the visible text of a
 * screen is carried by the button *and* by the navigation bar, the cell and the
 * `Other` wrapping both. `findElements` answers in depth-first order, which puts
 * the outermost of those first — so an unqualified label match lands on the
 * container roughly as often as on the control, and a tap on a container is a
 * no-op that reports success.
 *
 * Built from `INTERACTIVE_TYPES` rather than a second list: the set of things
 * worth tapping is the same question `ui_tree` answers with `detail:
 * "interactive"`, and two lists would disagree the first time either was
 * corrected.
 */
export const CONTROL_PREDICATE = [...INTERACTIVE_TYPES]
  .map((type) => `type == "XCUIElementType${type}"`)
  .join(" OR ");

export type ElementQuery = { using: Locator; value: string };

/** Matched against both, because SwiftUI puts the visible text in either one. */
export const labelQuery = (label: string): ElementQuery => ({
  using: "predicate string",
  value: `label == ${quote(label)} OR name == ${quote(label)}`,
});

/** The same query, narrowed to things a tap does something to. */
export const preferControls = (query: ElementQuery): ElementQuery => ({
  using: "predicate string",
  value: `(${query.value}) AND (${CONTROL_PREDICATE})`,
});

/**
 * Resolve the `id` / `label` / `predicate` trio to one WebDriverAgent query.
 *
 * `id` keeps the `accessibility id` strategy rather than becoming a predicate
 * over `name`: WDA resolves that strategy against the identifier itself, and
 * rewriting it as a predicate would quietly change which elements match.
 */
export const elementQuery = (
  args: { id?: string | undefined; label?: string | undefined; predicate?: string | undefined },
  uiTreeName: string,
): ElementQuery => {
  const given = [args.id, args.label, args.predicate].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new IosError("Give exactly one of `id`, `label` or `predicate`.", {
      remedy: `Call ${uiTreeName} to see which identifiers and labels the screen actually has.`,
    });
  }
  if (args.id !== undefined) return { using: "accessibility id", value: args.id };
  if (args.label !== undefined) return labelQuery(args.label);
  return { using: "predicate string", value: args.predicate as string };
};
