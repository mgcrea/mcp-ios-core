/**
 * `@mgcrea/mcp-ios-core` — everything two MCP servers driving an iOS screen have
 * in common.
 *
 * The split is by *transport*, not by layer. Reaching a physical phone and
 * reaching a simulator share nothing below WebDriverAgent: one goes over the
 * IPv6 tunnel CoreDevice maintains, the other over the host's own loopback, and
 * app lifecycle on each is a different Apple CLI with a different output format.
 * Above that line they are the same server — the same XCUITest hierarchy, the
 * same pointer actions, the same point-space screenshot, the same result
 * envelope.
 *
 * This package is that upper half, and it is a peer of both servers rather than
 * a subpath of either. That direction matters: `mcp-ios-device` and
 * `mcp-ios-simulator` need each other for nothing, so making one depend on the
 * other would ship a whole second server — CLI entry points included — to reuse
 * half of it, and would force a release of the device server for a change only
 * the simulator wanted.
 *
 * It deliberately holds no *words*. Every string a user reads that names a tool,
 * an environment variable or a kind of target arrives from the server that
 * registers it: a remedy telling a simulator user to enable Developer Mode would
 * be worse than no remedy at all.
 */

export {
  CommandError,
  CommandTimeoutError,
  IosError,
  ToolchainError,
  WdaError,
  WdaUnavailableError,
} from "#/errors";

export { assertNoShellMetachars, createExec } from "#/exec";
export type { ExecCopy, ExecImpl, ExecResult, Logger } from "#/exec";

export type { DisplayInfo } from "#/display";

export { isNotAuthorized, WdaClient } from "#/wda/client";
export type {
  Locator,
  PointerAction,
  WdaNode,
  WdaOptions,
  WdaRect,
  WdaRemedies,
} from "#/wda/client";
export { sampleSource, TINY_PNG, wdaMock } from "#/wda/mock";
export type { FetchLike } from "#/wda/mock";

export { flattenTree, INTERACTIVE_TYPES, isTrue, shortType } from "#/ui-tree";
export type { FlattenOptions, UiDetail, UiElement, UiTreeResult } from "#/ui-tree";

export { renderScreenshot } from "#/screenshot";
export type { RenderedScreenshot, RenderOptions } from "#/screenshot";

export { toolNames } from "#/screen";
export type { ScreenHost, ScreenNaming, ScreenTargetRef, ToolNames } from "#/screen";

export { compact, fail, ok, okImage, okText, toFailure, wrap, wrapResult } from "#/tools/result";
export type { ImageContent, TextContent, ToolResult } from "#/tools/result";

export { createArgs } from "#/tools/args";
export type { ScreenArgs } from "#/tools/args";

export { actionResult, registerInputTools } from "#/tools/input";
export type { ScreenToolsConfig } from "#/tools/input";
export { registerScreenTools } from "#/tools/screen";
export type { ScreenReadConfig } from "#/tools/screen";
