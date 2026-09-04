/**
 * A WebDriverAgent stand-in, shipped rather than kept in a test folder.
 *
 * It is here because it encodes four things about WDA 16.12.3 that are
 * expensive to rediscover and must never differ between the two servers:
 *
 *  - `/source` reports booleans as the **strings** `"1"` and `"0"` — not
 *    `"true"`/`"false"`, and not JSON booleans;
 *  - the element handle key is `element-6066-11e4-a52e-4f735466cecf`, with a
 *    legacy `ELEMENT` fallback;
 *  - `/alert/text` answers **404** with `{value:{error:"no such alert"}}` when
 *    there is no alert, which is what `alertText()`'s swallow branch depends on;
 *  - `sessionId` comes back on every envelope, which is what exercises the
 *    session cache.
 *
 * A second, hand-written copy in the simulator repo would agree with reality
 * right up until the first time one of them was corrected.
 */

/** 1x1 transparent PNG; `sips` is mocked, so only "non-empty" matters. */
export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Shaped like a real `GET /source?format=json`, measured against WDA 16.12.3 on
 * iOS 26.6.1: booleans are the strings "1"/"0", and `type` comes back already
 * stripped of its `XCUIElementType` prefix.
 */
export const sampleSource = {
  type: "Application",
  name: "Canopy",
  rect: { x: 0, y: 0, width: 440, height: 956 },
  isVisible: "1",
  isEnabled: "1",
  children: [
    {
      type: "Button",
      name: "garden.tab",
      label: "Garden",
      rawIdentifier: "garden.tab",
      rect: { x: 20, y: 900, width: 100, height: 40 },
      isVisible: "1",
      isEnabled: "1",
    },
    {
      type: "Button",
      label: "Today",
      rect: { x: 140, y: 900, width: 100, height: 40 },
      isVisible: "1",
      isEnabled: "0",
    },
    {
      type: "StaticText",
      label: "Monstera deliciosa",
      rect: { x: 20, y: 200, width: 300, height: 24 },
      isVisible: "1",
      isEnabled: "1",
    },
    {
      type: "Button",
      label: "Hidden",
      rect: { x: 0, y: 2000, width: 40, height: 40 },
      isVisible: "0",
      isEnabled: "1",
    },
  ],
};

export type FetchLike = (url: unknown, init?: unknown) => Promise<Response>;

const json = (value: unknown, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ value, sessionId: "S1", ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * A WebDriverAgent stand-in. Routes are matched on the path so a test can assert
 * that a tap really went through `/actions` rather than some other endpoint.
 */
export const wdaMock =
  (
    overrides: Record<string, () => Response> = {},
    log: { method: string; path: string; body: unknown }[] = [],
  ): FetchLike =>
  async (url: unknown, init?: unknown): Promise<Response> => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const request = (init ?? {}) as RequestInit;
    log.push({
      method: request.method ?? "GET",
      path,
      body: typeof request.body === "string" ? JSON.parse(request.body) : undefined,
    });

    for (const [pattern, respond] of Object.entries(overrides)) {
      if (path.includes(pattern)) return respond();
    }
    if (path === "/status")
      return json({ ready: true, state: "success", build: { version: "9.0.0" } });
    if (path === "/session") return json({ sessionId: "S1", capabilities: {} });
    if (path === "/screenshot") return json(TINY_PNG);
    if (path.startsWith("/source")) return json(sampleSource);
    if (path.endsWith("/window/size")) return json({ width: 440, height: 956 });
    if (path.endsWith("/elements")) return json([{ "element-6066-11e4-a52e-4f735466cecf": "E1" }]);
    if (path.endsWith("/rect")) return json({ x: 20, y: 900, width: 100, height: 40 });
    if (path.endsWith("/alert/text")) {
      return new Response(JSON.stringify({ value: { error: "no such alert" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return json(null);
  };
