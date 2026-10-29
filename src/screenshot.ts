import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DisplayInfo } from "#/display";
import { IosError } from "#/errors";
import { assertNoShellMetachars, type ExecImpl } from "#/exec";

/**
 * Downscaling, and the coordinate space it decides.
 *
 * A raw device screenshot is 1320x2868 pixels on this class of phone — several
 * megabytes, and far past anything worth putting in a context window. It has to
 * be scaled down, and the scale factor chosen is not a cosmetic decision: it
 * defines the space whoever reads the image will name coordinates in.
 *
 * So the default is not "some smaller number". It is **exactly the point size**
 * — native pixels divided by `pointScale`, 440x956 here. That is the logical
 * resolution the interface was laid out at, it is what WebDriverAgent's `/source`
 * rects and `/actions` coordinates are already in, and it makes the whole server
 * speak one coordinate space: a point read off the image is a point that can be
 * tapped, with no arithmetic in between and therefore no arithmetic to get wrong.
 *
 * Scaling is done by `sips`, which ships with macOS. That keeps the promise that
 * these servers have no runtime npm dependencies — an image library would be the
 * single largest one, on a process that already holds device access.
 */
export type RenderOptions = {
  pngBase64: string;
  /**
   * Only `pointScale` is read. Narrowed on purpose: a simulator can produce a
   * scale without ever producing the rest of a `DisplayInfo`, and demanding the
   * whole record would force it to invent fields.
   */
  display: Pick<DisplayInfo, "pointScale">;
  sipsPath: string;
  exec: ExecImpl;
  timeoutMs: number;
  /**
   * Longest side of the output, in pixels. Omitted means the point size, which
   * is the case that keeps image coordinates and tap coordinates identical.
   */
  maxDimension?: number | undefined;
  /** JPEG quality 1-100. Screenshots of flat UI stay legible well below 80. */
  quality: number;
  /** Also keep the full-resolution PNG here. */
  savePath?: string | undefined;
  /**
   * What to suggest when the capture comes back empty. A phone does this when
   * its screen is locked; a simulator when it is shut down. Same symptom, two
   * unrelated fixes, so the words come from the server.
   */
  emptyRemedy?: string | undefined;
};

export type RenderedScreenshot = {
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  /**
   * "points" when image pixels and device points coincide, so coordinates read
   * off the image can be passed straight to the tap tool. Anything else and
   * the caller has been handed a conversion to do, which the tool result says
   * out loud rather than leaving to be discovered.
   */
  coordinateSpace: "points" | "image_pixels";
  pointsPerPixel: number;
  bytes: number;
  savedTo?: string;
};

const readDimensions = async (
  path: string,
  opts: { sipsPath: string; exec: ExecImpl; timeoutMs: number },
): Promise<{ width: number; height: number }> => {
  const { stdout } = await opts.exec(
    opts.sipsPath,
    ["-g", "pixelWidth", "-g", "pixelHeight", path],
    opts.timeoutMs,
  );
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new IosError(`Could not read image dimensions from sips output: ${stdout.slice(0, 200)}`);
  }
  return { width, height };
};

/**
 * Width and height from a JPEG's frame header, or undefined if there is none.
 *
 * The output is a JPEG sips has just written and this process has just read
 * back, so its size is already in hand: the SOFn segment carries it, after SOI
 * and whatever APPn/DQT/DHT segments precede it. Saves the `sips -g` spawn a
 * second measurement cost on every screenshot.
 */
export const jpegDimensions = (jpeg: Buffer): { width: number; height: number } | undefined => {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 4 <= jpeg.length) {
    if (jpeg[at] !== 0xff) return undefined;
    const marker = jpeg[at + 1] as number;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    // Markers without a length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > jpeg.length) return undefined;
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  return undefined;
};

export const renderScreenshot = async (opts: RenderOptions): Promise<RenderedScreenshot> => {
  const png = Buffer.from(opts.pngBase64, "base64");
  if (png.byteLength === 0) {
    throw new IosError(
      "The screenshot came back empty.",
      opts.emptyRemedy ? { remedy: opts.emptyRemedy } : {},
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "ios-shot-"));
  const source = join(dir, "shot.png");
  const output = join(dir, "shot.jpg");
  try {
    await writeFile(source, png);
    const native = await readDimensions(source, opts);

    // Derive the target from the *captured* image rather than from the display
    // record, so a landscape capture scales by its own longest side instead of
    // a portrait assumption that would put every coordinate at 90 degrees.
    const longest = Math.max(native.width, native.height);
    const target = opts.maxDimension ?? Math.round(longest / opts.display.pointScale);

    await opts.exec(
      opts.sipsPath,
      [
        "-Z",
        String(target),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(opts.quality),
        source,
        "--out",
        output,
      ],
      opts.timeoutMs,
    );

    const jpeg = await readFile(output);
    const rendered = jpegDimensions(jpeg) ?? (await readDimensions(output, opts));

    // How many device points one image pixel covers. 1 on the default path.
    const pointsPerPixel = native.width / opts.display.pointScale / rendered.width;
    const isPointSpace = Math.abs(pointsPerPixel - 1) < 0.01;

    let savedTo: string | undefined;
    if (opts.savePath) {
      assertNoShellMetachars("savePath", opts.savePath);
      await mkdir(dirname(opts.savePath), { recursive: true });
      await writeFile(opts.savePath, png);
      savedTo = opts.savePath;
    }

    return {
      data: jpeg.toString("base64"),
      mimeType: "image/jpeg",
      width: rendered.width,
      height: rendered.height,
      coordinateSpace: isPointSpace ? "points" : "image_pixels",
      pointsPerPixel: Math.round(pointsPerPixel * 1000) / 1000,
      bytes: jpeg.byteLength,
      ...(savedTo ? { savedTo } : {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
