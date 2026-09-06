import { describe, expect, it } from "vitest";

import { toolNames, type ScreenNaming } from "#/screen";
import { renderScreenshot } from "#/screenshot";
import { createArgs } from "#/tools/args";
import { registerInputTools } from "#/tools/input";
import { CONTROL_PREDICATE } from "#/tools/locator";
import { registerScreenTools } from "#/tools/screen";
import { flattenTree } from "#/ui-tree";
import { WdaClient } from "#/wda/client";
import { TINY_PNG, wdaMock, type WdaRequest } from "#/wda/mock";
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
      "ios_simulator_wait_for_element",
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

  it("counts what the filters removed, so a filtered screen is not read as a bare one", () => {
    // The shape of a PHPicker over Safari, measured on iOS 26.5 with WDA
    // 16.12.3: the asset grid is in the tree and its cells are tappable — a
    // synthesised tap on one opens the preview — but XCUITest reports every one
    // of them `isVisible: "0"`. Left silent, the default call answers a short,
    // plausible list of chrome and nothing says the photos exist. Measured on
    // the real capture: 11 elements matched, 5 not visible, 40 more labelled.
    const tree = flattenTree(
      {
        type: "Application",
        rect: { x: 0, y: 0, width: 402, height: 874 },
        isVisible: "1",
        children: [
          {
            type: "Button",
            label: "Cancel",
            rect: { x: 20, y: 92, width: 36, height: 36 },
            isVisible: "1",
          },
          ...Array.from({ length: 9 }, (_, i) => ({
            type: "Image",
            label: `Photo, 08 August 2012, 23:${i}`,
            rect: { x: 0, y: 312 + i * 134, width: 133, height: 133 },
            isVisible: "0",
          })),
        ],
      },
      { maxBytes: 24_000 },
    );

    expect(tree.matched).toBe(1);
    // At `interactive` an Image is not a control, so the cells are counted
    // under the detail knob rather than the visibility one — which is the knob
    // the reader has to turn first.
    expect(tree.filtered?.onlyAtWiderDetail).toBe(9);
    expect(tree.filtered?.note).toContain('detail: "labelled"');
  });

  it("names the visibility flag once a wider detail would keep the element", () => {
    const picker = {
      type: "Application",
      rect: { x: 0, y: 0, width: 402, height: 874 },
      isVisible: "1",
      children: Array.from({ length: 9 }, (_, i) => ({
        type: "Image",
        label: `Photo, 08 August 2012, 23:${i}`,
        rect: { x: 0, y: 312 + i * 134, width: 133, height: 133 },
        isVisible: "0",
      })),
    };
    const labelled = flattenTree(picker, { detail: "labelled", maxBytes: 24_000 });
    expect(labelled.matched).toBe(0);
    expect(labelled.filtered?.notVisible).toBe(9);
    expect(labelled.filtered?.note).toContain("include_invisible: true");

    // And the escape hatch it names actually produces them.
    const shown = flattenTree(picker, {
      detail: "labelled",
      includeInvisible: true,
      maxBytes: 24_000,
    });
    expect(shown.matched).toBe(9);
    expect(shown.filtered).toBeUndefined();
  });

  it("stays quiet on a screen where the filters took nothing", () => {
    const tree = flattenTree(
      {
        type: "Application",
        rect: { x: 0, y: 0, width: 402, height: 874 },
        isVisible: "1",
        children: [
          {
            type: "Button",
            label: "Only",
            rect: { x: 0, y: 0, width: 50, height: 50 },
            isVisible: "1",
          },
        ],
      },
      { maxBytes: 24_000 },
    );
    expect(tree.filtered).toBeUndefined();
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

/**
 * A `/elements` route that answers from the predicate rather than from the path.
 *
 * `matches` is consulted with the predicate string WDA was sent; whatever it
 * returns becomes the element list. That is the only way to model the screen
 * this whole feature is about — one where a label belongs to a navigation bar
 * *and* to a button, and the two are told apart by type alone.
 */
const elementsBy = (matches: (predicate: string) => string[], log: WdaRequest[] = []) =>
  wdaMock(
    {
      "/elements": (request) => {
        const value = String((request.body as { value?: string })?.value ?? "");
        return new Response(
          JSON.stringify({
            value: matches(value).map((id) => ({ "element-6066-11e4-a52e-4f735466cecf": id })),
            sessionId: "S1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
    log,
  );

/** The predicate WebDriverAgent was actually sent, for asserting on the narrowing. */
const predicateOf = (request: WdaRequest | undefined): string =>
  String((request?.body as { value?: string } | undefined)?.value ?? "");

/** The reported case: "Identify" is carried by the navigation bar and the button. */
const IDENTIFY = (predicate: string): string[] =>
  predicate.includes("XCUIElementTypeButton") ? ["BUTTON"] : ["NAVBAR", "BUTTON"];

describe("tapping an element by label", () => {
  it("prefers a control over the container that shares its label", async () => {
    const log: WdaRequest[] = [];
    const host = fakeHost({ fetch: elementsBy(IDENTIFY, log) });
    const harness = await connect((server) => registerInputTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_tap_element", {
      label: "Identify",
      settle_ms: 0,
    });

    // The bug this replaces: `findElements` answers depth-first, so the
    // navigation bar came first and a tap on it did nothing while reporting
    // success.
    expect(result.tapped.preferredControl).toBe(true);
    expect(result.tapped.matched).toBe(1);
    const queries = log.filter((entry) => entry.path.endsWith("/elements"));
    expect(queries).toHaveLength(1);
    expect(predicateOf(queries[0])).toContain('type == "XCUIElementTypeButton"');
  });

  it("falls back to the unnarrowed query when no control carries the label", async () => {
    const log: WdaRequest[] = [];
    const host = fakeHost({
      // A screen whose only affordance is a piece of text. Refusing this would
      // be a worse regression than the bug being fixed.
      fetch: elementsBy((p) => (p.includes("XCUIElementTypeButton") ? [] : ["TEXT"]), log),
    });
    const harness = await connect((server) => registerInputTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_tap_element", {
      label: "Monstera deliciosa",
      settle_ms: 0,
    });
    expect(result.isToolError).toBeFalsy();
    expect(result.tapped.preferredControl).toBeUndefined();
    expect(log.filter((entry) => entry.path.endsWith("/elements"))).toHaveLength(2);
  });

  it("leaves the ordering alone when the caller passes an index", async () => {
    // An explicit index means the caller has read the tree and is counting real
    // positions in it, so narrowing would silently renumber them.
    const log: WdaRequest[] = [];
    const host = fakeHost({ fetch: elementsBy(IDENTIFY, log) });
    const harness = await connect((server) => registerInputTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_tap_element", {
      label: "Identify",
      index: 0,
      settle_ms: 0,
    });
    expect(result.tapped.preferredControl).toBeUndefined();
    expect(result.tapped.matched).toBe(2);
    const query = log.find((entry) => entry.path.endsWith("/elements"));
    expect(predicateOf(query)).not.toContain("XCUIElementType");
  });

  it("says so on the call itself when the choice was still ambiguous", async () => {
    const host = fakeHost({ fetch: elementsBy(() => ["ONE", "TWO", "THREE"]) });
    const harness = await connect((server) => registerInputTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_tap_element", {
      label: "Add",
      settle_ms: 0,
    });
    expect(result.tapped.note).toContain("3 elements matched");
  });

  it("does not narrow an identifier or a predicate the caller wrote", async () => {
    const log: WdaRequest[] = [];
    const host = fakeHost({ fetch: elementsBy(() => ["E1"], log) });
    const harness = await connect((server) => registerInputTools(server, cfg({ host })));
    await harness.call("ios_simulator_tap_element", { id: "garden.tab", settle_ms: 0 });
    await harness.call("ios_simulator_tap_element", {
      predicate: 'type == "XCUIElementTypeCell"',
      settle_ms: 0,
    });
    for (const query of log.filter((entry) => entry.path.endsWith("/elements"))) {
      expect(predicateOf(query)).not.toContain(CONTROL_PREDICATE);
    }
  });

  it("reports the caller's own locator, not the twenty-clause narrowed one", async () => {
    // The narrowed predicate is ~700 characters. Echoing it would put that on
    // the result of every tap and every wait, which is a real cost on a long
    // session and tells the caller nothing they did not already write.
    const host = fakeHost({ fetch: elementsBy(IDENTIFY) });
    const harness = await connect((server) => registerInputTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_tap_element", {
      label: "Identify",
      settle_ms: 0,
    });
    expect(result.tapped.value).toBe('label == "Identify" OR name == "Identify"');
    expect(JSON.stringify(result)).not.toContain(CONTROL_PREDICATE);
    // …and the flag is what says the narrowing happened at all.
    expect(result.tapped.preferredControl).toBe(true);
  });

  it("refuses two locators rather than silently letting one win", async () => {
    const harness = await connect((server) => registerInputTools(server, cfg()));
    const result = await harness.call("ios_simulator_tap_element", {
      id: "garden.tab",
      label: "Garden",
    });
    expect(result.isToolError).toBe(true);
    expect(result.remedy).toContain("ios_simulator_ui_tree");
  });
});

describe("waiting for an element", () => {
  it("returns as soon as it appears, reporting what it cost", async () => {
    let polls = 0;
    const host = fakeHost({
      fetch: elementsBy(() => {
        polls += 1;
        return polls < 3 ? [] : ["E1"];
      }),
    });
    const harness = await connect((server) => registerScreenTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_wait_for_element", {
      label: "Care sheet",
      poll_ms: 250,
      timeout_ms: 5000,
    });
    expect(result.waited.polls).toBe(3);
    expect(result.waited.matched).toBe(1);
    expect(result.hasImage).toBe(true);
  });

  it("waits for something to go away, which is how a spinner is waited out", async () => {
    let polls = 0;
    const host = fakeHost({
      fetch: elementsBy(() => {
        polls += 1;
        return polls < 2 ? ["SPINNER"] : [];
      }),
    });
    const harness = await connect((server) => registerScreenTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_wait_for_element", {
      label: "Loading",
      absent: true,
      poll_ms: 250,
      timeout_ms: 5000,
    });
    expect(result.waited.absent).toBe(true);
    expect(result.waited.matched).toBe(0);
  });

  it("fails with the elapsed time and the caller's own tool to check next", async () => {
    const host = fakeHost({ fetch: elementsBy(() => []) });
    const harness = await connect((server) => registerScreenTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_wait_for_element", {
      label: "Never",
      poll_ms: 250,
      timeout_ms: 1000,
    });
    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("polls waiting for");
    expect(result.remedy).toContain("ios_simulator_ui_tree");
  });

  it("is a read tool, so it survives a server with writes turned off", async () => {
    const harness = await connect((server) => registerScreenTools(server, cfg()));
    expect(await harness.names()).toContain("ios_simulator_wait_for_element");
    const tool = (await harness.tools()).find((t) => t.name === "ios_simulator_wait_for_element");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });
});

/** WDA answering `/alert/text` with a real alert instead of its usual 404. */
const alerting = () =>
  wdaMock({
    "/alert/text": () =>
      new Response(JSON.stringify({ value: "Allow access to your photos?", sessionId: "S1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

describe("an alert on screen", () => {
  it("carries the server's hint, because core has no words of its own", async () => {
    const host = fakeHost({ fetch: alerting() });
    const harness = await connect((server) =>
      registerInputTools(
        server,
        cfg({ host, alertHint: "Pre-answer it with ios_simulator_set_environment." }),
      ),
    );
    const result = await harness.call("ios_simulator_tap", { x: 1, y: 1, settle_ms: 0 });
    expect(result.alert).toContain("photos");
    expect(result.alertHint).toContain("ios_simulator_set_environment");
  });

  it("says nothing extra when the server supplied no hint", async () => {
    const host = fakeHost({ fetch: alerting() });
    const harness = await connect((server) => registerInputTools(server, cfg({ host })));
    const result = await harness.call("ios_simulator_tap", { x: 1, y: 1, settle_ms: 0 });
    expect(result.alert).toContain("photos");
    expect(result.alertHint).toBeUndefined();
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
