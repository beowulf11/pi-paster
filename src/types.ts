import type { ImageDimensions } from "@earendil-works/pi-tui";

export const EXTENSION_NAME = "paster";
// Cap on the source file we read from disk. Larger inputs are rejected up
// front with `too-large` so we never try to base64-encode a multi-gigabyte
// file. Raised from the legacy 10 MB so high-resolution screenshots and raw
// camera shots can be ingested and then shrunk by optimize-image.ts before
// being attached.
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

// Hard limits enforced by the Anthropic Messages API. Used by
// optimize-image.ts to decide when an attachment needs to be shrunk.
export const ANTHROPIC_MAX_DIMENSION = 8000;
export const ANTHROPIC_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageAttachment {
  id: number;
  placeholder: string;
  originalPath: string;
  mimeType: SupportedImageMimeType;
  data: string;
  dimensions?: ImageDimensions;
  createdAt: number;
  /** True once optimizeImageBytes has run on this attachment. */
  optimized?: boolean;
  /** Original (pre-optimization) base64 size in bytes — informational. */
  originalBytes?: number;
  /** Final (post-optimization) base64 size in bytes — informational. */
  finalBytes?: number;
  /** Human-readable trail of optimization actions applied, if any. */
  optimizeActions?: string[];
}

export interface LoadedImage {
  originalPath: string;
  mimeType: SupportedImageMimeType;
  data: string;
  dimensions?: ImageDimensions;
}

export interface PasterImageContent {
  type: "image";
  mimeType: string;
  data: string;
}

export type LoadImageResult =
  | { ok: true; image: LoadedImage }
  | {
      ok: false;
      reason: "missing" | "not-file" | "too-large" | "unsupported" | "read-error";
      path: string;
    };

export interface PasterPreviewDetails {
  placeholders: string[];
}
