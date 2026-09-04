import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { toolNames, type ScreenTargetRef } from "#/screen";
import { renderScreenshot } from "#/screenshot";
import { createArgs } from "#/tools/args";
import type { ScreenToolsConfig } from "#/tools/input";
import { okImage, wrap, wrapResult } from "#/tools/result";
import { flattenTree } from "#/ui-tree";

/**
 * The three tools that read the screen without changing it, built once for both
 * servers.
 *
 * Registered unconditionally, whatever the write gate says: an agent that can
 * look but not touch is still useful, and a server that answers "here is the
 * screen, and here is why you cannot tap it" is worth far more than one that
 * offers nothing.
 *
 * The one asymmetry between the two servers lives in `host.screenshotPng`. A
 * simulator can be captured through `simctl` with no runner installed at all,
 * so its screenshot tool works with zero setup; a phone has no such path and
 * every pixel comes through WebDriverAgent. The tool is the same either way —
 * the host decides which lane it came from.
 */
export type ScreenReadConfig<T extends ScreenTargetRef> = ScreenToolsConfig<T> & {
  /**
   * Register `<prefix>_get_display_info`. The device server wants it: reading
   * geometry there is a slow `devicectl` round trip worth doing once and
   * caching. A simulator reads it from a local plist for free and reports it on
   * every screenshot, so a separate tool would be listing cost for nothing.
   */
  includeDisplayInfo?: boolean;
};

export const registerScreenTools = <T extends ScreenTargetRef>(
  server: McpServer,
  cfg: ScreenReadConfig<T>,
): void => {
  const { host, naming } = cfg;
  const names = toolNames(naming);
  const { detailArg, targetArg } = createArgs(naming);

  if (cfg.includeDisplayInfo !== false) {
    server.registerTool(
      names.displayInfo,
      {
        title: `${naming.title}: Get Display Info`,
        description:
          "Report the screen's geometry and orientation. Worth reading once per session: " +
          "`pointWidth`/`pointHeight` bound every coordinate the tap and swipe tools accept, and " +
          "`orientation` tells you whether the screen you are about to read is rotated.",
        inputSchema: z.object({ device: targetArg }),
        annotations: { readOnlyHint: true },
      },
      async ({ device }) => wrap(async () => host.display(await host.resolveTarget(device))),
    );
  }

  server.registerTool(
    names.screenshot,
    {
      title: `${naming.title}: Screenshot`,
      description:
        "Capture the screen and return it as an image. By default it is scaled to exactly the " +
        "device's point size, which means a position read off this image can be passed straight " +
        `to ${names.tap} with no conversion — the returned metadata says \`coordinateSpace: ` +
        `"points"\` when that holds. Pair it with ${names.uiTree} rather than choosing between ` +
        "them: the image shows you what the screen looks like, the tree gives you exact labels " +
        "and identifiers. Re-screenshot after every action rather than chaining blind taps.",
      inputSchema: z.object({
        device: targetArg,
        max_dimension: z
          .number()
          .int()
          .min(120)
          .max(4000)
          .optional()
          .describe(
            "Longest side of the returned image, in pixels. Leave it unset unless you have a " +
              "reason: the default matches the device's point size, and any other value makes " +
              "image positions stop being tap coordinates (the result then reports " +
              '`coordinateSpace: "image_pixels"` and the `pointsPerPixel` factor to multiply by).',
          ),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(70)
          .describe("JPEG quality 1-100. Flat interface screenshots stay perfectly legible at 70."),
        save_path: z
          .string()
          .optional()
          .describe(
            "Also write the full-resolution PNG to this absolute path, for attaching to a bug " +
              "report. The returned image is still the downscaled one.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, max_dimension, quality, save_path }) =>
      wrapResult(async () => {
        const target = await host.resolveTarget(device);
        // Capture first, then ask for the geometry *of that capture*: a host
        // with no orientation source of its own can only work it out from the
        // image, and the other order leaves it guessing.
        const png = await (host.screenshotPng?.(target) ?? host.wda(target).screenshot());
        const display = await host.display(target, png);
        const rendered = await renderScreenshot({
          pngBase64: png,
          display,
          sipsPath: host.sipsPath,
          exec: host.exec,
          timeoutMs: host.execTimeoutMs,
          maxDimension: max_dimension,
          quality,
          savePath: save_path,
          emptyRemedy: cfg.emptyScreenshotRemedy,
        });
        return okImage(
          { type: "image", data: rendered.data, mimeType: rendered.mimeType },
          {
            device: target.name ?? target.id,
            width: rendered.width,
            height: rendered.height,
            coordinateSpace: rendered.coordinateSpace,
            pointsPerPixel: rendered.pointsPerPixel,
            orientation: display.orientation,
            bytes: rendered.bytes,
            ...(rendered.savedTo ? { savedTo: rendered.savedTo } : {}),
            ...(rendered.coordinateSpace === "points"
              ? {}
              : {
                  warning:
                    "This image is not in point space. Multiply positions read off it by " +
                    `\`pointsPerPixel\` before passing them to ${names.tap}.`,
                }),
          },
        );
      }),
  );

  server.registerTool(
    names.uiTree,
    {
      title: `${naming.title}: UI Tree`,
      description:
        "List the addressable elements on screen — type, label, accessibility identifier, and the " +
        "exact point to tap — flattened rather than nested. Prefer this over reading coordinates " +
        "off a screenshot whenever you can: a label or identifier survives the screen moving, and " +
        "a pixel position does not. The raw hierarchy is tens of KB, so this returns controls " +
        "only by default; use `contains` or `types` to narrow further and `detail` to widen. " +
        `Coordinates are in points, the same space ${names.tap} takes.`,
      inputSchema: z.object({
        device: targetArg,
        detail: detailArg,
        contains: z
          .string()
          .optional()
          .describe(
            'Keep only elements whose label, identifier or value contains this, case-insensitively — e.g. "Today".',
          ),
        types: z
          .array(z.string())
          .optional()
          .describe(
            'Keep only these element types, without the `XCUIElementType` prefix, e.g. ["Button", "Cell"].',
          ),
        include_invisible: z
          .boolean()
          .default(false)
          .describe(
            "Include elements XCUITest marks as not visible. Off by default: they cannot be " +
              "tapped, and on a scrolling list they outnumber the visible ones many times over.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, detail, contains, types, include_invisible }) =>
      wrap(async () => {
        const target = await host.resolveTarget(device);
        const source = await host.wda(target).source();
        return flattenTree(source, {
          detail,
          capHint: cfg.capHint,
          ...(contains ? { contains } : {}),
          ...(types ? { types } : {}),
          includeInvisible: include_invisible,
          maxBytes: cfg.maxTreeBytes,
        });
      }),
  );
};
