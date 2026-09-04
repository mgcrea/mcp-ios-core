import { describe, expect, it } from "vitest";

import { toolNames, type ScreenNaming } from "#/screen";
import { renderScreenshot } from "#/screenshot";
import { createArgs } from "#/tools/args";
import { registerInputTools } from "#/tools/input";
import { registerScreenTools } from "#/tools/screen";
import { flattenTree } from "#/ui-tree";
import { WdaClient } from "#/wda/client";
import { TINY_PNG, wdaMock } from "#/wda/mock";
import { connect, DISPLAY, fakeHost, sipsMock, SIM_NAMING } from "#test/helpers";

const cfg = (over: Partial<Parameters<typeof registerInputTools>[1]> = {}) => ({
  host: fakeHost(),
  naming: SIM_NAMING,
  maxTreeBytes: 24_000,
  capHint: "raise IOS_SIMULATOR_MAX_TREE_BYTES",
  buttons: ["home"] as [string, ...string[]],
  emptyScreenshotRemedy: "Boot the simulator first.",
  ...over,
});

describe("naming", () => {
  it("derives every tool name from the prefix, and lets one be overridden", () => {
    const names = toolNames(SIM_NAMING);
    expect(names.tap).toBe("ios_simulator_tap");
    expect(names.uiTree).toBe("ios_simulator_ui_tree");
    // `list_devices` has no spelling that reads well in both servers, which is
    // the whole reason `names` is an override rather than a pure derivation.
    expect(names.listTargets).toBe("ios_simulator_list");
  });
});

describe("argument copy", () => {
  it("points cross-references at this server's tools, not the other's", () => {
    const args = createArgs(SIM_NAMING);
    const x = args.xArg.description ?? "";
    expect(x).toContain("ios_simulator_ui_tree");
    expect(x).toContain("ios_simulator_screenshot");
    expect(x).not.toContain("ios_device");
  });

  it("uses the server's own target wording when it supplies one", () => {
    const naming: ScreenNaming = { ...SIM_NAMING, copy: { target: "Which simulator: a UDID." } };
    expect(createArgs(naming).targetArg.description).toBe("Which simulator: a UDID.");
    // …and falls back to a generic sentence that still names the right tool.
    expect(createArgs(SIM_NAMING).targetArg.description).toContain("ios_simulator_list");
  });
});

describe("the shared tool factories", () => {
  it("register under the caller's prefix with no trace of the other server", async () => {
    const harness = await connect((server) => {
      registerScreenTools(server, cfg());
      registerInputTools(server, cfg());
    });
    expect(await harness.names()).toEqual([
      "ios_simulator_get_display_info",
      "ios_simulator_press_button",
      "ios_simulator_screenshot",
      "ios_simulator_swipe",
      "ios_simulator_tap",
      "ios_simulator_tap_element",
      "ios_simulator_type",
      "ios_simulator_ui_tree",
    ]);
    // The failure this guards is a tool name left hardcoded in prose: it would
    // send a model to call something that does not exist in this server.
    for (const tool of await harness.tools()) {
      expect(JSON.stringify(tool)).not.toContain("ios_device");
    }
  });

  it("can leave get_display_info out for a server that reports geometry for free", async () => {
    const harness = await connect((server) =>
      registerScreenTools(server, { ...cfg(), includeDisplayInfo: false }),
    );
    expect(await harness.names()).not.toContain("ios_simulator_get_display_info");
    expect(await harness.names()).toContain("ios_simulator_screenshot");
  });

  it("only offers the hardware buttons the target actually has", async () => {
    const harness = await connect((server) => registerInputTools(server, cfg()));
    const button = (await harness.tools()).find((t) => t.name === "ios_simulator_press_button");
    const schema = JSON.stringify(button?.inputSchema);
    expect(schema).toContain("home");
    // A simulator has no volume rocker worth pressing; the device server passes
    // three buttons here and gets three.
    expect(schema).not.toContain("volumeUp");
  });

  it("prefers the host's own capture over WebDriverAgent when it has one", async () => {
    let wdaScreenshots = 0;
    const host = fakeHost({
      fetch: wdaMock({
        "/screenshot": () => {
          wdaScreenshots += 1;
          return new Response(JSON.stringify({ value: TINY_PNG, sessionId: "S1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
      screenshotPng: async () => TINY_PNG,
    });
    const harness = await connect((server) => registerScreenTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_screenshot", {});
    expect(result.hasImage).toBe(true);
    // This is the asymmetry the whole `screenshotPng` member exists for: a
    // simulator screenshots through simctl with no runner installed at all.
    expect(wdaScreenshots).toBe(0);
  });

  it("falls back to WebDriverAgent when the host has no capture lane", async () => {
    let wdaScreenshots = 0;
    const host = fakeHost({
      fetch: wdaMock({
        "/screenshot": () => {
          wdaScreenshots += 1;
          return new Response(JSON.stringify({ value: TINY_PNG, sessionId: "S1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    });
    const harness = await connect((server) => registerScreenTools(server, cfg({ host })));
    expect((await harness.call("ios_simulator_screenshot", {})).hasImage).toBe(true);
    expect(wdaScreenshots).toBe(1);
  });

  it("sends a tap as a W3C pointer sequence and reports the resulting screen", async () => {
    const log: { method: string; path: string; body: unknown }[] = [];
    const host = fakeHost({ fetch: wdaMock({}, log) });
    const harness = await connect((server) => registerInputTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_tap", { x: 100, y: 200, settle_ms: 0 });
    expect(result.hasImage).toBe(true);
    const actions = log.find((entry) => entry.path.endsWith("/actions"));
    expect(actions).toBeDefined();
    expect(JSON.stringify(actions?.body)).toContain('"pointerMove"');
  });
});

describe("the UI tree", () => {
  it('reads WebDriverAgent\'s "1"/"0" strings as booleans', () => {
    // Measured against WDA 16.12.3: `/source` reports booleans as those two
    // strings, not JSON booleans. Reading them the narrow way filtered out
    // every element on the screen.
    const tree = flattenTree(
      {
        type: "Application",
        rect: { x: 0, y: 0, width: 402, height: 874 },
        isVisible: "1",
        children: [
          {
            type: "Button",
            label: "Visible",
            rect: { x: 0, y: 0, width: 50, height: 50 },
            isVisible: "1",
          },
          {
            type: "Button",
            label: "Hidden",
            rect: { x: 0, y: 60, width: 50, height: 50 },
            isVisible: "0",
          },
        ],
      },
      { maxBytes: 24_000 },
    );
    expect(tree.elements.map((e) => e.label)).toEqual(["Visible"]);
  });

  it("names the caller's own variable when it truncates", () => {
    const tree = flattenTree(
      {
        type: "Application",
        rect: { x: 0, y: 0, width: 402, height: 874 },
        isVisible: "1",
        children: Array.from({ length: 40 }, (_, i) => ({
          type: "Button",
          label: `A button with a long enough label to cost bytes ${i}`,
          rect: { x: 0, y: i * 10, width: 300, height: 40 },
          isVisible: "1",
        })),
      },
      { maxBytes: 400, capHint: "raise IOS_SIMULATOR_MAX_TREE_BYTES" },
    );
    expect(tree.elements.length).toBeLessThan(40);
    expect(tree.truncated).toContain("IOS_SIMULATOR_MAX_TREE_BYTES");
  });

  it("says nothing about raising a cap when the caller gave no hint", () => {
    const tree = flattenTree(
      {
        type: "Application",
        rect: { x: 0, y: 0, width: 402, height: 874 },
        isVisible: "1",
        children: Array.from({ length: 40 }, (_, i) => ({
          type: "Button",
          label: `A button with a long enough label to cost bytes ${i}`,
          rect: { x: 0, y: i * 10, width: 300, height: 40 },
          isVisible: "1",
        })),
      },
      { maxBytes: 400 },
    );
    expect(tree.truncated).toContain("Narrow it with");
    expect(tree.truncated).not.toContain("undefined");
  });
});

describe("the screenshot renderer", () => {
  it("reports point space when the image and the point size coincide", async () => {
    const rendered = await renderScreenshot({
      pngBase64: TINY_PNG,
      display: DISPLAY,
      sipsPath: "/usr/bin/sips",
      exec: sipsMock(),
      timeoutMs: 5000,
      quality: 70,
    });
    expect(rendered.coordinateSpace).toBe("points");
    expect(rendered.pointsPerPixel).toBe(1);
  });

  it("uses the caller's words when the capture comes back empty", async () => {
    await expect(
      renderScreenshot({
        pngBase64: "",
        display: DISPLAY,
        sipsPath: "/usr/bin/sips",
        exec: sipsMock(),
        timeoutMs: 5000,
        quality: 70,
        emptyRemedy: "Boot the simulator first.",
      }),
    ).rejects.toMatchObject({ remedy: "Boot the simulator first." });
  });
});

const client = (fetchImpl: unknown, remedies = {}) =>
  new WdaClient({
    baseUrl: async () => "http://127.0.0.1:8100",
    timeoutMs: 1000,
    fetch: fetchImpl as typeof fetch,
    remedies,
  });

describe("the WebDriverAgent client", () => {
  it("treats an error inside `value` on a 200 as a failure", async () => {
    // WDA reports application-level failures this way as often as with a
    // non-2xx status. Checking only the status makes half the errors look like
    // successes.
    const c = client(
      async () =>
        new Response(JSON.stringify({ value: { error: "no such element" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(c.status()).rejects.toMatchObject({ wdaCode: "no such element" });
  });

  it("attaches the caller's remedy rather than one naming another server", async () => {
    const c = client(
      async () =>
        new Response(JSON.stringify({ value: { error: "no such element" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { noSuchElement: "Call ios_simulator_ui_tree." },
    );
    await expect(c.status()).rejects.toMatchObject({ remedy: "Call ios_simulator_ui_tree." });
  });

  it("says the runner is not up, with the caller's fix, when nothing answers", async () => {
    const c = client(
      async () => {
        throw new TypeError("fetch failed");
      },
      { unavailable: "Run scripts/wda.sh setup." },
    );
    await expect(c.status()).rejects.toMatchObject({
      name: "WdaUnavailableError",
      remedy: "Run scripts/wda.sh setup.",
    });
  });

  it("swallows the 404 that means there is simply no alert", async () => {
    expect(await client(wdaMock()).alertText()).toBeUndefined();
  });
});
