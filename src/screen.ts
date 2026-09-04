import type { DisplayInfo } from "#/display";
import type { ExecImpl } from "#/exec";
import type { WdaClient } from "#/wda/client";

/**
 * Whatever the host server calls a screen: a physical phone, or a booted
 * simulator. Two fields, because two is all the shared tools ever read — an `id`
 * to name in a result and a `name` to show when there is one.
 */
export type ScreenTargetRef = {
  id: string;
  name?: string | undefined;
};

/**
 * The whole contract the shared screen and input tools talk to.
 *
 * Deliberately six members, and deliberately structural rather than a base
 * class. The two servers reach a screen by routes that share nothing below this
 * line — a CoreDevice tunnel over a `utun` interface on one side, a simulator's
 * own host loopback port on the other — and the concrete client class is where
 * every one of those differences lives. Nothing here can see them.
 *
 * Generic in `T` rather than taking `ScreenTargetRef` directly: TypeScript
 * method parameters are bivariant, so a non-generic version would be satisfied
 * by a host whose `wda()` accepts a *narrower* target than `resolveTarget()`
 * returns — which is the one mistake here that produces a runtime error instead
 * of a type error.
 *
 * Note what is absent: no `listDevices`, no `install`, no transport of any kind.
 * Those are exactly the members that must not cross.
 */
export type ScreenHost<T extends ScreenTargetRef = ScreenTargetRef> = {
  /** Resolve a user hint — a udid, a name, or nothing — to the thing everything else takes. */
  resolveTarget(hint?: string): Promise<T>;
  /** The WebDriverAgent client for that target, cached by the host so the session is reused. */
  wda(target: T): WdaClient;
  /** Geometry, for the screenshot's point-space scaling. */
  display(target: T): Promise<DisplayInfo>;
  /**
   * A capture that does not go through WebDriverAgent, when the host has one.
   *
   * A simulator does: `simctl io … screenshot` works with no runner installed at
   * all, which is why its screenshot tool is registered as a read tool that
   * needs zero setup. A physical device has no such path — every pixel comes
   * through the runner — so the device host leaves this undefined and the
   * shared tool falls back to WDA.
   *
   * Returns base64, matching what WebDriverAgent's `/screenshot` returns.
   */
  screenshotPng?(target: T): Promise<string>;
  readonly sipsPath: string;
  readonly exec: ExecImpl;
  readonly execTimeoutMs: number;
};

/**
 * Every tool name the shared copy is allowed to mention.
 *
 * Descriptions point readers at sibling tools constantly — "prefer this over
 * reading coordinates off a screenshot", "call X to see what is on screen" — and
 * those cross-references are most of what makes the descriptions useful. They
 * have to be right in both servers, and a name that does not exist in the server
 * a model is talking to is worse than no cross-reference at all.
 */
export type ToolNames = {
  tap: string;
  tapElement: string;
  swipe: string;
  type: string;
  pressButton: string;
  screenshot: string;
  uiTree: string;
  displayInfo: string;
  listApps: string;
  listTargets: string;
  diagnostics: string;
};

export type ScreenNaming = {
  /** Tool-name prefix; every shared tool registers as `${prefix}_${verb}`. */
  prefix: string;
  /** Title prefix; every shared tool titles as `${title}: ${Verb}`. */
  title: string;
  /** The word used in running prose — "device", "simulator". */
  noun: string;
  /** Env-var prefix quoted in descriptions and remedies — "IOS_DEVICE". */
  envPrefix: string;
  /**
   * Names that are not the mechanical `${prefix}_${verb}`. `list_targets` in
   * particular has no derivable spelling that reads well in both servers.
   */
  names?: Partial<ToolNames> | undefined;
  /**
   * The few descriptions that carry real information rather than a noun.
   *
   * Everything else in the shared copy differs only by a tool name, and is
   * interpolated. These do not: "its CoreDevice identifier, hardware UDID, or
   * name … when only one device is connected" and "a UDID, a name, or `booted`
   * … when exactly one is booted" are not the same sentence with a word
   * swapped, they are different facts. Templating them would quietly make one
   * of the two servers wrong.
   */
  copy?: { target?: string } | undefined;
};

/** Mechanical defaults, with `naming.names` winning per field. */
export const toolNames = (naming: ScreenNaming): ToolNames => {
  const p = naming.prefix;
  return {
    tap: `${p}_tap`,
    tapElement: `${p}_tap_element`,
    swipe: `${p}_swipe`,
    type: `${p}_type`,
    pressButton: `${p}_press_button`,
    screenshot: `${p}_screenshot`,
    uiTree: `${p}_ui_tree`,
    displayInfo: `${p}_get_display_info`,
    listApps: `${p}_list_apps`,
    listTargets: `${p}_list_devices`,
    diagnostics: `${p}_diagnostics`,
    ...naming.names,
  };
};
