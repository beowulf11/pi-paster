/**
 * Image optimizer for pi-paster.
 *
 * Anthropic Messages API hard limits:
 *   - 5 MB per image (base64-decoded)
 *   - 8000 px on any dimension
 *   - 32 MB per request total
 *
 * Claude internally downsamples every input image so the long edge is
 *   - 1568 px for most models
 *   - 2576 px for Opus 4.7
 * which means: any client-side downscale at or above ~2600 px is lossless
 * from the model's point of view. We resize (aspect-preserving) instead of
 * cropping so no visual information is thrown away.
 *
 * Strategy applied in order:
 *   1. If width or height > 8000 px → resize so the long edge is 8000 px.
 *   2. If decoded bytes > 5 MB → re-encode as JPEG q=95, then 90/85/80/70/60.
 *   3. If still > 5 MB → progressively shrink the long edge to 6000 → 4000
 *      → 3000 → 2000 px, re-running JPEG quality ladder each step.
 *
 * `sharp` is loaded lazily so the extension can still ship if the native
 * binding is unavailable (we just skip optimization with a log line).
 */
import type { SupportedImageMimeType } from "./types.ts";
import { ANTHROPIC_MAX_DIMENSION, ANTHROPIC_MAX_IMAGE_BYTES } from "./types.ts";

type Sharp = (input?: Buffer) => SharpInstance;
interface SharpInstance {
  metadata(): Promise<{ width?: number; height?: number; format?: string }>;
  resize(opts: {
    width?: number;
    height?: number;
    fit?: string;
    withoutEnlargement?: boolean;
  }): SharpInstance;
  jpeg(opts: { quality: number; mozjpeg?: boolean }): SharpInstance;
  png(opts?: { quality?: number; compressionLevel?: number }): SharpInstance;
  toBuffer(): Promise<Buffer>;
}

let _sharp: Sharp | null | undefined;
async function getSharp(): Promise<Sharp | null> {
  if (_sharp !== undefined) return _sharp;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("sharp");
    const fn = (typeof mod === "function" ? mod : mod?.default) as Sharp | undefined;
    _sharp = typeof fn === "function" ? fn : null;
  } catch {
    _sharp = null;
  }
  return _sharp;
}

export interface OptimizeResult {
  data: string; // base64
  mimeType: SupportedImageMimeType;
  originalBytes: number;
  finalBytes: number;
  originalDim?: { width: number; height: number };
  finalDim?: { width: number; height: number };
  actions: string[];
  changed: boolean;
}

const SHRINK_LADDER = [6000, 4000, 3000, 2000];
const JPEG_QUALITY_LADDER = [95, 90, 85, 80, 70, 60];

export async function optimizeImageBytes(
  input: Buffer,
  mime: SupportedImageMimeType,
): Promise<OptimizeResult> {
  const originalBytes = input.length;
  const noop = (): OptimizeResult => ({
    data: input.toString("base64"),
    mimeType: mime,
    originalBytes,
    finalBytes: originalBytes,
    actions: [],
    changed: false,
  });

  // Fast path: already under both limits.
  if (originalBytes <= ANTHROPIC_MAX_IMAGE_BYTES) {
    // Still need dimension check, but cheap to skip sharp if image is small.
    if (originalBytes <= 256 * 1024) return noop();
  }

  const sharp = await getSharp();
  if (!sharp) return noop(); // sharp missing — fall back silently.

  const meta = await sharp(input).metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (!origW || !origH) return noop();

  const actions: string[] = [];
  const originalDim = { width: origW, height: origH };

  // Step 1: respect 8000 px dimension cap (resize, do not crop).
  let workBuf = input;
  let workW = origW;
  let workH = origH;
  if (workW > ANTHROPIC_MAX_DIMENSION || workH > ANTHROPIC_MAX_DIMENSION) {
    workBuf = await sharp(workBuf)
      .resize({
        width: workW >= workH ? ANTHROPIC_MAX_DIMENSION : undefined,
        height: workH > workW ? ANTHROPIC_MAX_DIMENSION : undefined,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toBuffer();
    const m = await sharp(workBuf).metadata();
    workW = m.width ?? workW;
    workH = m.height ?? workH;
    actions.push(`resize to ${workW}x${workH} (8000px cap)`);
  }

  // Step 2: bytes within limit? done.
  if (workBuf.length <= ANTHROPIC_MAX_IMAGE_BYTES && actions.length === 0) return noop();
  if (workBuf.length <= ANTHROPIC_MAX_IMAGE_BYTES) {
    return {
      data: workBuf.toString("base64"),
      mimeType: mime,
      originalBytes,
      finalBytes: workBuf.length,
      originalDim,
      finalDim: { width: workW, height: workH },
      actions,
      changed: true,
    };
  }

  // Step 3: JPEG quality ladder.
  let outMime: SupportedImageMimeType = "image/jpeg";
  let attempt = workBuf;
  for (const q of JPEG_QUALITY_LADDER) {
    attempt = await sharp(workBuf).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (attempt.length <= ANTHROPIC_MAX_IMAGE_BYTES) {
      actions.push(`jpeg q=${q} → ${formatBytes(attempt.length)}`);
      return {
        data: attempt.toString("base64"),
        mimeType: outMime,
        originalBytes,
        finalBytes: attempt.length,
        originalDim,
        finalDim: { width: workW, height: workH },
        actions,
        changed: true,
      };
    }
  }
  actions.push(`jpeg q=60 still ${formatBytes(attempt.length)} — shrinking`);

  // Step 4: shrink the long edge and retry quality ladder each step.
  for (const longEdge of SHRINK_LADDER) {
    if (Math.max(workW, workH) <= longEdge) continue;
    const resized = await sharp(workBuf)
      .resize({
        width: workW >= workH ? longEdge : undefined,
        height: workH > workW ? longEdge : undefined,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toBuffer();
    const m = await sharp(resized).metadata();
    const newW = m.width ?? workW;
    const newH = m.height ?? workH;
    for (const q of JPEG_QUALITY_LADDER) {
      attempt = await sharp(resized).jpeg({ quality: q, mozjpeg: true }).toBuffer();
      if (attempt.length <= ANTHROPIC_MAX_IMAGE_BYTES) {
        actions.push(`resize ${newW}x${newH} + jpeg q=${q} → ${formatBytes(attempt.length)}`);
        return {
          data: attempt.toString("base64"),
          mimeType: outMime,
          originalBytes,
          finalBytes: attempt.length,
          originalDim,
          finalDim: { width: newW, height: newH },
          actions,
          changed: true,
        };
      }
    }
    workBuf = resized;
    workW = newW;
    workH = newH;
  }

  // Give up — return last attempt anyway; pi will at least try.
  actions.push(`final ${formatBytes(attempt.length)} — over limit`);
  return {
    data: attempt.toString("base64"),
    mimeType: outMime,
    originalBytes,
    finalBytes: attempt.length,
    originalDim,
    finalDim: { width: workW, height: workH },
    actions,
    changed: true,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}
