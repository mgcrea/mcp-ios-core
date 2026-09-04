/**
 * Screen geometry, and the reason every coordinate in these servers is a point.
 *
 * A raw capture is in device *pixels*; WebDriverAgent's `/source` rects and its
 * `/actions` coordinates are in *points*. `pointScale` is the only bridge
 * between them, and getting it wrong puts every tap in the wrong place with
 * nothing looking wrong — which is why it is a named contract rather than a
 * number passed around.
 *
 * The two servers fill this in from sources that have nothing in common: a
 * physical device reports it from `devicectl device info displays`, while a
 * simulator's is read off its device type's `profile.plist` and the captured
 * PNG's own header. The shape is what they agree on.
 */
export type DisplayInfo = {
  /** Native panel size, in device pixels — the space a raw screenshot is in. */
  pixelWidth: number;
  pixelHeight: number;
  /** Logical size, in points — the space WebDriverAgent's rects and taps are in. */
  pointWidth: number;
  pointHeight: number;
  pointScale: number;
  orientation: string;
  /** Physical devices only; a simulator has no backlight to report. */
  backlightState?: string | undefined;
};
