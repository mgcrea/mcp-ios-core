// The context-window layer for a WebDriverAgent accessibility tree.
//
// A `/source` for one real screen is tens of KB of nested JSON, and passing it
// through would not merely cost tokens — it would make the model walk a tree to
// find a tappable rect, which is a join it can silently get wrong. So the tree
// is flattened to addressable elements with the tap point already computed.
//
// None of this knows or cares what is on the other end of WebDriverAgent: the
// hierarchy XCUITest reports for a simulator is the same hierarchy it reports
// for a phone.

import type { WdaNode, WdaRect } from "#/wda/client";

export type UiElement = {
  type: string;
  label?: string;
  id?: string;
  value?: string;
  /** `[x, y, width, height]`, in points. Array rather than an object: four keys per element adds up. */
  rect: [number, number, number, number];
  /**
   * The point to tap, precomputed. Without it every caller re-derives
   * `x + width / 2` from the rect, and the one that gets it wrong taps a
   * neighbour with nothing looking wrong.
   */
  tap: [number, number];
  disabled?: true;
};

export type UiTreeResult = {
  coordinateSpace: "points";
  elements: UiElement[];
  /** How many matched before the byte cap, so a truncated answer is obviously partial. */
  matched: number;
  truncated?: string;
  /**
   * What the *filters* removed, as opposed to what the byte cap removed.
   *
   * Without this a filtered screen and a bare screen return the same thing — a
   * short, plausible list — and the reader has no way to tell which they are
   * looking at. Measured case: a `PHPicker` over Safari answers eleven elements
   * at the default detail, all of them chrome, while nine photo cells sit on
   * screen and tappable. Reporting a count is the whole fix; it is a tally of
   * what this function already decided, so it cannot be wrong the way a guess
   * about remote views would be.
   */
  filtered?: { notVisible?: number; onlyAtWiderDetail?: number; note: string };
};

export type UiDetail = "interactive" | "labelled" | "all";

/**
 * The controls a tap can meaningfully land on. Deliberately a list rather than
 * "anything with an action": XCUITest reports almost every node as hittable, so
 * an is-it-tappable heuristic returns the whole tree and defeats the point.
 */
export const INTERACTIVE_TYPES = new Set([
  "Button",
  "Cell",
  "CheckBox",
  "DatePicker",
  // A home-screen app icon and a keyboard key are both plain taps, and both are
  // reported as their own type rather than as buttons.
  "Icon",
  "Key",
  "Link",
  "MenuItem",
  "PickerWheel",
  "RadioButton",
  "SearchField",
  "SecureTextField",
  "SegmentedControl",
  "Slider",
  "Stepper",
  "Switch",
  "Tab",
  "TextField",
  "TextView",
  "Toggle",
]);

/**
 * `XCUIElementTypeButton` → `Button`. A live WDA already reports the short form
 * in `/source`; the long one is what predicates and older builds use, so both
 * have to land on the same name or a `types` filter matches nothing.
 */
export const shortType = (type: string | undefined): string =>
  (type ?? "Unknown").replace(/^XCUIElementType/, "");

/**
 * WDA's JSON source reports booleans as the strings `"1"` and `"0"` — not
 * `"true"`/`"false"`, and not JSON booleans. Measured against WDA 16.12.3 on
 * iOS 26.6.1; accepting all three costs nothing and the narrow version of this
 * check silently filtered out every element on the screen.
 */
export const isTrue = (value: string | boolean | undefined): boolean =>
  value === true || value === "true" || value === "1";

const textOf = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
};

const hasArea = (rect: WdaRect | undefined): rect is WdaRect =>
  rect !== undefined && rect.width > 0 && rect.height > 0;

const hasLabel = (node: WdaNode): boolean =>
  textOf(node.label) !== undefined || textOf(node.name) !== undefined;

const keep = (node: WdaNode, detail: UiDetail): boolean => {
  if (detail === "all") return true;
  const type = shortType(node.type);
  if (INTERACTIVE_TYPES.has(type)) return true;
  if (detail === "interactive") return false;
  return (type === "StaticText" || type === "Image" || type === "Other") && hasLabel(node);
};

const toElement = (node: WdaNode, rect: WdaRect): UiElement => {
  const label = textOf(node.label) ?? textOf(node.name);
  const identifier = textOf(node.rawIdentifier);
  const value = textOf(node.value);
  return {
    type: shortType(node.type),
    ...(label ? { label } : {}),
    // Only when it adds something: SwiftUI mirrors the label into the
    // identifier unless one was set deliberately, and repeating it doubles the
    // cost of the single field that makes addressing survive a copy change.
    ...(identifier && identifier !== label ? { id: identifier } : {}),
    ...(value && value !== label ? { value } : {}),
    rect: [round(rect.x), round(rect.y), round(rect.width), round(rect.height)],
    tap: [round(rect.x + rect.width / 2), round(rect.y + rect.height / 2)],
    ...(isTrue(node.isEnabled) ? {} : { disabled: true as const }),
  };
};

const round = (n: number): number => Math.round(n);

export type FlattenOptions = {
  detail?: UiDetail;
  /** Case-insensitive substring match against label, id and value. */
  contains?: string;
  /** Keep only these short type names, e.g. `["Button", "Cell"]`. */
  types?: string[];
  maxBytes: number;
  /** Include elements XCUITest marks invisible. Off by default — they cannot be tapped. */
  includeInvisible?: boolean;
  /**
   * How to raise the cap, in the caller's own words — the env var differs per
   * server, and a truncation notice that names the wrong one is worse than one
   * that names none.
   */
  capHint?: string | undefined;
};

/**
 * Depth-first flatten. Flat rather than nested is the decision that makes this
 * affordable: nesting spends a `children` array and an indentation level on
 * every container, and a caller looking for something to tap reads the leaves.
 */
export const flattenTree = (root: WdaNode, opts: FlattenOptions): UiTreeResult => {
  const detail = opts.detail ?? "interactive";
  const needle = opts.contains?.toLowerCase();
  const wantedTypes = opts.types && opts.types.length > 0 ? new Set(opts.types) : undefined;

  const matches: UiElement[] = [];
  // Tallies of what the filters threw away, so a filtered screen does not read
  // as an empty one. Counted in the same pass rather than by re-walking: the
  // conditions are the same ones being evaluated anyway.
  let notVisible = 0;
  let onlyAtWiderDetail = 0;

  const visit = (node: WdaNode): void => {
    const rect = node.rect;
    if (hasArea(rect)) {
      const element = toElement(node, rect);
      const typeOk = !wantedTypes || wantedTypes.has(element.type);
      const textOk =
        needle === undefined ||
        [element.label, element.id, element.value].some((v) => v?.toLowerCase().includes(needle));
      if (typeOk && textOk) {
        const visible = opts.includeInvisible === true || isTrue(node.isVisible);
        if (keep(node, detail)) {
          if (visible) matches.push(element);
          else notVisible += 1;
        } else if (detail === "interactive" && keep(node, "labelled")) {
          // Only the one step out. Counting what `all` would add would count
          // every unlabelled container on the screen, which is a number nobody
          // can act on.
          onlyAtWiderDetail += 1;
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);

  // Trim to the byte budget by dropping from the end, so what survives is the
  // top of the screen — which is where a caller reading a fresh screen looks
  // first, and keeps the answer stable rather than reshuffled.
  const elements: UiElement[] = [];
  let bytes = 0;
  for (const element of matches) {
    const size = JSON.stringify(element).length + 1;
    if (bytes + size > opts.maxBytes) break;
    elements.push(element);
    bytes += size;
  }

  const notes = [
    notVisible > 0
      ? `${notVisible} on-screen ${notVisible === 1 ? "element is" : "elements are"} reported ` +
        "not visible and left out — usually a row scrolled off a list, but a photo picker or a " +
        "share sheet reports its own contents that way. `include_invisible: true` includes them."
      : undefined,
    onlyAtWiderDetail > 0
      ? `${onlyAtWiderDetail} more ${onlyAtWiderDetail === 1 ? "carries" : "carry"} a label but ` +
        `${onlyAtWiderDetail === 1 ? "is" : "are"} not a control; \`detail: "labelled"\` shows ` +
        `${onlyAtWiderDetail === 1 ? "it" : "them"}.`
      : undefined,
  ].filter((n): n is string => n !== undefined);

  return {
    coordinateSpace: "points",
    elements,
    matched: matches.length,
    ...(elements.length < matches.length
      ? {
          truncated:
            `Showing ${elements.length} of ${matches.length} elements (${opts.maxBytes} byte cap). ` +
            `Narrow it with \`contains\`, \`types\`${opts.capHint ? `, or ${opts.capHint}` : ""}.`,
        }
      : {}),
    ...(notes.length > 0
      ? {
          filtered: {
            ...(notVisible > 0 ? { notVisible } : {}),
            ...(onlyAtWiderDetail > 0 ? { onlyAtWiderDetail } : {}),
            note: notes.join(" "),
          },
        }
      : {}),
  };
};
