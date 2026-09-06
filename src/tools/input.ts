import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { IosError } from "#/errors";
import { toolNames, type ScreenHost, type ScreenNaming, type ScreenTargetRef } from "#/screen";
import { renderScreenshot } from "#/screenshot";
import { createArgs } from "#/tools/args";
import { elementQuery, preferControls } from "#/tools/locator";
import { ok, okImage, wrapResult, type ToolResult } from "#/tools/result";
import type { PointerAction } from "#/wda/client";

/**
 * The five tools that touch the screen, built once for both servers.
 *
 * Sharing these is the whole point of the core: a tap is a W3C pointer sequence
 * over WebDriverAgent whether the pixels belong to a phone or a simulator, and
 * the *descriptions* — which are the only thing a model reads before choosing a
 * tool — are the most carefully tuned prose in either repo. Two copies would
 * drift the first time one was corrected, and nothing in either CI compares
 * them, so the drift would be silent and permanent.
 *
 * The discipline that keeps this readable: **interpolate tool names, never
 * assemble a sentence from clauses.** Every string below still reads as written
 * prose.
 *
 * One thing is deliberately *not* parameterised: the `device` argument keeps
 * that name in both servers. `simctl`'s own interface calls a simulator a device
 * — `simctl list devices`, and `<device>` in the usage line of every subcommand
 * — so it is Apple's word here too, and a per-server field name would cost the
 * type inference that keeps these handlers honest.
 */
export type ScreenToolsConfig<T extends ScreenTargetRef> = {
  host: ScreenHost<T>;
  naming: ScreenNaming;
  /** Byte cap on a UI tree payload. */
  maxTreeBytes: number;
  /** How to raise that cap, in this server's own words. */
  capHint: string;
  /** The hardware buttons this target actually has. */
  buttons: readonly [string, ...string[]];
  /** What to say when a capture comes back empty. */
  emptyScreenshotRemedy: string;
  /**
   * What to add when an action finds an alert on screen, in this server's own
   * words. A simulator can answer a permission prompt before it is ever shown,
   * and the moment one appears is the moment that is worth knowing; a phone
   * cannot, so the device server leaves this undefined.
   */
  alertHint?: string | undefined;
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every action tool ends here, and by default it ends with a fresh screenshot.
 *
 * That default is a correctness decision rather than a convenience. A tap is
 * aimed at a position that was true when the last screenshot was taken; if the
 * screen moved in between — a sheet appeared, a list settled, an alert opened —
 * the tap landed somewhere else and nothing about the result would say so.
 * Returning the resulting screen makes the mistake visible on the same call that
 * made it, which is the difference between noticing immediately and building
 * three more actions on top of a wrong one.
 */
export const actionResult = async <T extends ScreenTargetRef>(
  host: ScreenHost<T>,
  target: T,
  summary: Record<string, unknown>,
  opts: { screenshot: boolean; settleMs: number; emptyRemedy?: string; alertHint?: string },
): Promise<ToolResult> => {
  if (!opts.screenshot) return ok({ ...summary, ok: true });
  // Let the animation finish. Screenshotting mid-transition returns a frame
  // that is neither the old screen nor the new one, which reads as a failure.
  await sleep(opts.settleMs);
  const wda = host.wda(target);
  // Prefer the host's own capture when it has one: a simulator can screenshot
  // through `simctl` with no runner at all, and going through WebDriverAgent
  // here would make every action depend on a lane the screenshot does not need.
  const pngBase64 = await (host.screenshotPng?.(target) ?? wda.screenshot());
  const display = await host.display(target, pngBase64);
  const rendered = await renderScreenshot({
    pngBase64,
    display,
    sipsPath: host.sipsPath,
    exec: host.exec,
    timeoutMs: host.execTimeoutMs,
    quality: 70,
    ...(opts.emptyRemedy ? { emptyRemedy: opts.emptyRemedy } : {}),
  });
  const alert = await wda.alertText();
  return okImage(
    { type: "image", data: rendered.data, mimeType: rendered.mimeType },
    {
      ...summary,
      ok: true,
      width: rendered.width,
      height: rendered.height,
      coordinateSpace: rendered.coordinateSpace,
      // An alert swallows every subsequent tap while telling you nothing, so it
      // is worth one field on every action rather than a puzzle later.
      ...(alert ? { alert, ...(opts.alertHint ? { alertHint: opts.alertHint } : {}) } : {}),
    },
  );
};

const tapActions = (x: number, y: number, holdMs: number): PointerAction[] => [
  { type: "pointerMove", duration: 0, x, y },
  { type: "pointerDown", button: 0 },
  { type: "pause", duration: holdMs },
  { type: "pointerUp", button: 0 },
];

/**
 * The drive half.
 *
 * Whether these are registered at all is the calling server's decision, and both
 * of them make it the same way: the tools are *absent* when writes are off
 * rather than refused, because a refusal still lets a model try, retry and
 * reason about a way around it, while a tool that does not exist ends the
 * conversation. What differs is the default — a phone belongs to someone, a
 * simulator is disposable — and that belongs in the server, not here.
 */
export const registerInputTools = <T extends ScreenTargetRef>(
  server: McpServer,
  cfg: ScreenToolsConfig<T>,
): void => {
  const { host, naming } = cfg;
  const names = toolNames(naming);
  const { screenshotArg, settleArg, targetArg, xArg, yArg } = createArgs(naming);
  const tail = {
    emptyRemedy: cfg.emptyScreenshotRemedy,
    ...(cfg.alertHint ? { alertHint: cfg.alertHint } : {}),
  };
  server.registerTool(
    names.tap,
    {
      title: `${naming.title}: Tap`,
      description:
        `Tap a position on screen, in points. Prefer ${names.tapElement} when the target has a ` +
        "label or an accessibility identifier — a position stops being right the moment the " +
        "layout shifts, and nothing about a wrong tap looks wrong. Coordinates come from a " +
        `default ${names.screenshot} image or from a \`tap\` field in ${names.uiTree}, which ` +
        "are the same space.",
      inputSchema: z.object({
        device: targetArg,
        x: xArg,
        y: yArg,
        hold_ms: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .default(50)
          .describe(
            "How long to hold the touch, in milliseconds. Around 700 makes it a long press, which " +
              "is what opens context menus and edit affordances.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      // Not destructiveHint: a tap does not itself destroy anything, but it can
      // land on a control that does — which is exactly why the whole family sits
      // behind the write gate rather than relying on this annotation.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, x, y, hold_ms, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const target = await host.resolveTarget(device);
        await host.wda(target).pointer(tapActions(x, y, hold_ms));
        return actionResult(
          host,
          target,
          { tapped: [x, y] },
          { screenshot, settleMs: settle_ms, ...tail },
        );
      }),
  );

  server.registerTool(
    names.tapElement,
    {
      title: `${naming.title}: Tap Element`,
      description:
        "Tap the element with this accessibility identifier or label, letting the device resolve " +
        "its position. This is the tool to reach for: it survives the screen scrolling, the " +
        "layout changing and the copy being reworded, none of which a coordinate does. Give " +
        `exactly one of \`id\`, \`label\` or \`predicate\`; identifiers from ${names.uiTree}.`,
      inputSchema: z.object({
        device: targetArg,
        id: z
          .string()
          .optional()
          .describe(
            `Accessibility identifier — the \`id\` field from ${names.uiTree}, e.g. "garden.tab". ` +
              "The most durable way to address an element, because it is set in code and does not " +
              "change when the visible text does.",
          ),
        label: z
          .string()
          .optional()
          .describe(
            'Exact accessibility label, i.e. the visible text — e.g. "Today". Matched exactly, ' +
              "and it changes with the app's language, so prefer `id` where one exists. A label " +
              "is shared by a control and every container around it, so this matches controls " +
              "first and falls back to the rest only when no control carries it.",
          ),
        predicate: z
          .string()
          .optional()
          .describe(
            'Escape hatch: a raw NSPredicate over element attributes, e.g. `type == "XCUIElementTypeButton" AND label BEGINSWITH "Add"`.',
          ),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Which match to tap when several match, zero-based, counted in the order " +
              `${names.uiTree} lists them. Giving it turns off the control preference \`label\` ` +
              "normally applies, because it means you have read the tree and are counting real " +
              "positions in it. Leave it off unless that is what you are doing.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, id, label, predicate, index, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const base = elementQuery({ id, label, predicate }, names.uiTree);
        const target = await host.resolveTarget(device);
        const wda = host.wda(target);

        // Narrow a label to controls, unless the caller is counting positions in
        // the tree themselves. Two round trips only in the case where the label
        // belongs to nothing tappable — which is the case that was previously
        // succeeding while doing nothing at all.
        const narrowing = index === undefined && label !== undefined;
        let query = narrowing ? preferControls(base) : base;
        let uuids = await wda.findElements(query.using, query.value);
        let preferredControl = false;
        if (narrowing && uuids.length > 0) {
          preferredControl = true;
        } else if (narrowing) {
          // A `StaticText` is still tappable, and refusing one here would break
          // every screen whose only affordance is a piece of text.
          query = base;
          uuids = await wda.findElements(query.using, query.value);
        }

        const at = index ?? 0;
        const chosen = uuids[at];
        if (!chosen) {
          throw new IosError(
            `No element matched ${base.using} ${base.value}${uuids.length > 0 ? ` at index ${at} (${uuids.length} matched)` : ""}.`,
            {
              remedy:
                `Call ${names.uiTree} to see what is on screen — the element may not have ` +
                "appeared yet, or may be scrolled out of view.",
            },
          );
        }
        const rect = await wda.elementRect(chosen);
        await wda.click(chosen);
        return actionResult(
          host,
          target,
          {
            tapped: {
              // The caller's own locator, not the narrowed one. The control
              // clause is twenty types long and echoing it would put an extra
              // ~700 characters on the result of every single tap.
              using: base.using,
              value: base.value,
              index: at,
              matched: uuids.length,
              rect,
              // Both of these exist so an ambiguous match is visible on the call
              // that made it rather than in a screenshot the caller has to think
              // to compare.
              ...(preferredControl ? { preferredControl: true } : {}),
              ...(uuids.length > 1
                ? {
                    note:
                      `${uuids.length} elements matched and index ${at} was tapped. Pass ` +
                      "`index`, or a `predicate` naming the type, to choose a different one.",
                  }
                : {}),
            },
          },
          { screenshot, settleMs: settle_ms, ...tail },
        );
      }),
  );

  server.registerTool(
    names.swipe,
    {
      title: `${naming.title}: Swipe`,
      description:
        "Drag from one point to another, in points — how you scroll a list, pull to refresh, or " +
        "swipe a row open. To scroll down a page, swipe from low on the screen to high on it. " +
        "`duration_ms` is what separates a scroll from a fling: a short one throws the list past " +
        "where you aimed.",
      inputSchema: z.object({
        device: targetArg,
        from_x: xArg,
        from_y: yArg,
        to_x: xArg,
        to_y: yArg,
        duration_ms: z
          .number()
          .int()
          .min(50)
          .max(10_000)
          .default(400)
          .describe(
            "How long the drag takes. 400 is a controlled scroll; under 150 becomes a fling with " +
              "momentum, which lands somewhere you did not choose.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, from_x, from_y, to_x, to_y, duration_ms, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const target = await host.resolveTarget(device);
        await host.wda(target).pointer([
          { type: "pointerMove", duration: 0, x: from_x, y: from_y },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: duration_ms, x: to_x, y: to_y },
          { type: "pointerUp", button: 0 },
        ]);
        return actionResult(
          host,
          target,
          { swiped: { from: [from_x, from_y], to: [to_x, to_y], durationMs: duration_ms } },
          { screenshot, settleMs: settle_ms, ...tail },
        );
      }),
  );

  server.registerTool(
    names.type,
    {
      title: `${naming.title}: Type`,
      description:
        "Type text into whatever currently has keyboard focus, or into a named field. Focus is " +
        "the trap: with nothing focused the keystrokes go nowhere and the call still succeeds, so " +
        "pass `id` or `label` to have the field tapped first unless you know a field is already " +
        "active.",
      inputSchema: z.object({
        device: targetArg,
        text: z
          .string()
          .min(1)
          .describe("The text to type. Sent character by character, as a real keyboard would."),
        id: z
          .string()
          .optional()
          .describe(`Accessibility identifier of the field to focus first — from ${names.uiTree}.`),
        label: z
          .string()
          .optional()
          .describe("Exact label of the field to focus first, if it has no identifier."),
        clear_first: z
          .boolean()
          .default(false)
          .describe(
            "Replace the field's contents instead of appending. Only possible when `id` or " +
              "`label` names the field — there is no way to clear a field addressed only by focus.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, text, id, label, clear_first, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const target = await host.resolveTarget(device);
        const wda = host.wda(target);

        if (id !== undefined || label !== undefined) {
          const { using, value } = elementQuery({ id, label }, names.uiTree);
          const uuid = (await wda.findElements(using, value))[0];
          if (!uuid) {
            throw new IosError(`No field matched ${using} ${value}.`, {
              remedy: `Call ${names.uiTree} with detail "all" to see the fields on screen.`,
            });
          }
          if (clear_first) {
            await wda.setValue(uuid, text);
          } else {
            await wda.click(uuid);
            await wda.keys(text);
          }
        } else {
          if (clear_first) {
            throw new IosError("`clear_first` needs `id` or `label` to name the field.", {
              remedy:
                "Pass the field's accessibility identifier, or drop clear_first and type into the focused field.",
            });
          }
          await wda.keys(text);
        }

        return actionResult(
          host,
          target,
          { typed: text.length },
          { screenshot, settleMs: settle_ms, ...tail },
        );
      }),
  );

  server.registerTool(
    names.pressButton,
    {
      title: `${naming.title}: Press Button`,
      description:
        "Press a hardware button. `home` is the way back to the home screen and the reliable way " +
        "to background the app under test without terminating it.",
      inputSchema: z.object({
        device: targetArg,
        name: z
          .enum(cfg.buttons)
          .describe(
            "Which button. `home` works on Face ID devices too — it is the gesture, not the " +
              "physical button.",
          ),
        screenshot: screenshotArg,
        settle_ms: settleArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, name, screenshot, settle_ms }) =>
      wrapResult(async () => {
        const target = await host.resolveTarget(device);
        await host.wda(target).pressButton(name);
        return actionResult(
          host,
          target,
          { pressed: name },
          { screenshot, settleMs: settle_ms, ...tail },
        );
      }),
  );
};
