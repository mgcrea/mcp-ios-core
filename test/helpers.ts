import { copyFile } from "node:fs/promises";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import type { DisplayInfo } from "#/display";
import type { ExecImpl } from "#/exec";
import type { ScreenHost, ScreenNaming, ScreenTargetRef } from "#/screen";
import { WdaClient } from "#/wda/client";
import { wdaMock, type FetchLike } from "#/wda/mock";

/**
 * A naming record that is deliberately **not** the device server's.
 *
 * This is the point of testing the factories here rather than only in
 * `mcp-ios-device`: that repo can only ever exercise `ios_device_*`, so a name
 * or a cross-reference accidentally hardcoded to it would pass every test it
 * has. Registering the same factories under a second prefix is the only thing
 * that catches it.
 */
export const SIM_NAMING: ScreenNaming = {
  prefix: "ios_simulator",
  title: "iOS Simulator",
  noun: "simulator",
  envPrefix: "IOS_SIMULATOR",
  names: { listTargets: "ios_simulator_list" },
};

export const DISPLAY: DisplayInfo = {
  pixelWidth: 1206,
  pixelHeight: 2622,
  pointWidth: 402,
  pointHeight: 874,
  pointScale: 3,
  orientation: "portrait",
};

export type TestTarget = ScreenTargetRef & { id: string; name: string };

/**
 * `sips` is the only process the shared code spawns; this answers for it.
 *
 * The conversion branch has to actually leave a file behind: `renderScreenshot`
 * reads the output back to measure it and to base64 it, so a mock that only
 * returns stdout fails with ENOENT several lines later.
 */
export const sipsMock =
  (scaled = { width: 402, height: 874 }): ExecImpl =>
  async (_path, args) => {
    if (args.includes("-g")) {
      const file = args[args.length - 1] as string;
      const dims = file.endsWith(".png")
        ? [DISPLAY.pixelWidth, DISPLAY.pixelHeight]
        : [scaled.width, scaled.height];
      return { stdout: `/x\n  pixelWidth: ${dims[0]}\n  pixelHeight: ${dims[1]}\n`, stderr: "" };
    }
    const out = args[args.indexOf("--out") + 1] as string;
    const source = args[args.indexOf("--out") - 1] as string;
    await copyFile(source, out);
    return { stdout: "", stderr: "" };
  };

export type FakeHostOptions = {
  fetch?: FetchLike;
  exec?: ExecImpl;
  /** Give the host a capture lane that bypasses WebDriverAgent, as a simulator has. */
  screenshotPng?: (target: TestTarget) => Promise<string>;
};

export const fakeHost = (opts: FakeHostOptions = {}): ScreenHost<TestTarget> => {
  const target: TestTarget = { id: "SIM-1", name: "iPhone 17 Pro" };
  const wda = new WdaClient({
    baseUrl: async () => "http://127.0.0.1:8100",
    timeoutMs: 5000,
    fetch: (opts.fetch ?? wdaMock()) as unknown as typeof fetch,
  });
  return {
    resolveTarget: async () => target,
    wda: () => wda,
    display: async () => DISPLAY,
    ...(opts.screenshotPng ? { screenshotPng: opts.screenshotPng } : {}),
    sipsPath: "/usr/bin/sips",
    exec: opts.exec ?? sipsMock(),
    execTimeoutMs: 5000,
  };
};

/** An in-memory MCP client wired to a server the caller has registered tools on. */
export const connect = async (register: (server: McpServer) => void) => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  register(server);

  // Both halves of a linked pair must come from the *same* package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang rather
  // than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    names: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tools: async () => (await client.listTools()).tools,
    describe: async (name: string): Promise<string> =>
      (await client.listTools()).tools.find((t) => t.name === name)?.description ?? "",
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as { type: string; text?: string }[];
      const text = content.find((p) => p.type === "text")?.text ?? "{}";
      const image = content.find((p) => p.type === "image");
      try {
        return {
          ...JSON.parse(text),
          isToolError: res.isError === true,
          hasImage: image !== undefined,
        };
      } catch {
        return { isToolError: res.isError === true, error: text, hasImage: image !== undefined };
      }
    },
  };
};
