# @mgcrea/mcp-ios-core

The half of an iOS-driving MCP server that does not care what is on the other end
of WebDriverAgent: the HTTP client, the accessibility-tree flattener, the
point-space screenshot renderer, the error taxonomy, and the tap/swipe/type tools
themselves.

It is a **library, not a server** — no `bin`, no CLI, no transport. Two servers
consume it:

| Consumer                                    | Drives                    | How it reaches the screen                    |
| ------------------------------------------- | ------------------------- | -------------------------------------------- |
| [`mcp-ios-device`](../mcp-ios-device)       | a physical iPhone or iPad | the IPv6 tunnel CoreDevice already maintains |
| [`mcp-ios-simulator`](../mcp-ios-simulator) | an iOS Simulator          | the host's own loopback                      |

## Why a third package

The two servers need each other for nothing. A simulator has no CoreDevice
tunnel, no Developer Mode, no provisioning profile; a phone has no `simctl`, no
status-bar override, no `erase`. Below WebDriverAgent they share no code at all.

Above it they are the same server. The XCUITest hierarchy is the same hierarchy,
a tap is the same W3C pointer sequence, a screenshot is scaled into the same
point space by the same `sips` call, and a tool result has the same envelope. That
upper half is about half the lines in either server — so making one server depend
on the other would ship a complete second MCP server, CLI entry points included,
to reuse half of it, and would force a release of the device server for a change
only the simulator wanted.

## It holds no words

The one rule that keeps this shareable: **nothing here names a tool, an
environment variable, or a kind of target.** Every such string arrives from the
server that registers the tool.

That is not tidiness. The protocol is identical between a phone and a simulator
but the _fixes_ are not — a remedy telling a simulator user to enable Developer
Mode, or a phone user to boot the device first, is worse than no remedy at all.
So `WdaClient` takes a `WdaRemedies` record, `createExec` takes an `ExecCopy`,
`flattenTree` takes a `capHint`, and `renderScreenshot` takes an `emptyRemedy`.
CI fails the build if `src/` mentions either server's namespace.

Tool _names_ are interpolated rather than hardcoded, through `ScreenNaming` and
`toolNames()`. The discipline there: **interpolate names, never assemble a
sentence from clauses.** The descriptions are the only thing a model reads before
choosing a tool, so they stay written out as prose.

## What it exports

```ts
import {
  WdaClient, // WebDriverAgent over fetch: sessions, pointer actions, /source
  flattenTree, // the tens-of-KB hierarchy → flat elements with tap points
  renderScreenshot, // sips downscale into point space, so image pixels are tap coordinates
  registerInputTools, // tap, tap_element, swipe, type, press_button
  registerScreenTools, // screenshot, ui_tree, get_display_info, wait_for_element
  createArgs, // the zod arg atoms, named for the calling server
  elementQuery, // the id / label / predicate trio → one WDA query
  CONTROL_PREDICATE, // the clause that keeps a label match off its container
  createExec, // the execFile seam, argv-only, no shell
  ok,
  fail,
  wrap, // the MCP result envelope
  wdaMock, // a WDA stand-in, shipped so both servers test against one truth
} from "@mgcrea/mcp-ios-core";
```

### The `ScreenHost` contract

Six members, structural rather than a base class, and generic in the target type
so a host cannot satisfy it with a `wda()` narrower than its `resolveTarget()`:

```ts
type ScreenHost<T extends ScreenTargetRef> = {
  resolveTarget(hint?: string): Promise<T>;
  wda(target: T): WdaClient;
  display(target: T): Promise<DisplayInfo>;
  screenshotPng?(target: T): Promise<string>; // a capture that bypasses WDA
  readonly sipsPath: string;
  readonly exec: ExecImpl;
  readonly execTimeoutMs: number;
};
```

`screenshotPng` is the one real asymmetry between the two servers. A simulator
can be captured through `simctl` with **no runner installed at all**, so its
screenshot tool works with zero setup; a phone has no such path and every pixel
comes through WebDriverAgent. The tool is the same either way — the host decides
which lane it came from.

## Traps encoded here

Each of these was measured, and each would be re-derived wrongly in a second copy:

- WebDriverAgent's `/source` reports booleans as the **strings** `"1"` and `"0"` —
  not `"true"`/`"false"`, and not JSON booleans. Reading them the narrow way
  filters out every element on the screen.
- WDA reports application-level failures **inside `value` on a 200** as often as
  with a non-2xx status. Checking only the status makes half the errors look like
  successes.
- `/alert/text` answers **404** with `{value:{error:"no such alert"}}` when there
  is simply no alert.
- The element handle key is `element-6066-11e4-a52e-4f735466cecf`, with a legacy
  `ELEMENT` fallback.
- A session that fails, is recreated, and fails the same way was never stale: WDA
  answering `pid: 0` / `local.pid.0` on a _fresh_ session means the runner is not
  authorized, not that the app is missing.
- Scaling to exactly the point size is what makes a position read off a screenshot
  a tap coordinate with no arithmetic in between. `coordinateSpace` says out loud
  when that no longer holds.
- **A label is carried by the control _and_ by every container around it**, and
  `findElements` answers depth-first, so an unqualified label match lands on the
  navigation bar about as often as on the button. A tap on a container is a no-op
  that reports success, so `tap_element` narrows a label to the interactive types
  first and only falls back when nothing tappable carries it.
- **`isVisible` is not always truthful.** Measured on iOS 26.5 with WDA 16.12.3: a
  `PHPicker` presented over Safari reports all nine of its asset cells
  `isVisible: "0"` while they are on screen — a synthesised tap on one opens the
  preview. The default filter drops them, so `flattenTree` returns a `filtered`
  tally of what it left out rather than a short list that reads like a bare
  screen.

## Develop

```bash
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

The suite registers the shared tools under a **simulator** naming record on
purpose. `mcp-ios-device` can only ever exercise `ios_device_*`, so a name left
hardcoded to it would pass every test that repo has; registering the same
factories under a second prefix is the only thing that catches it. It has already
caught one.

## License

MIT — see [LICENSE](./LICENSE).
