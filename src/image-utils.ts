import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { getImageDimensions } from "@earendil-works/pi-tui";
import type { AttachmentStore } from "./store.ts";
import {
  MAX_IMAGE_BYTES,
  type ImageAttachment,
  type LoadImageResult,
  type PasterImageContent,
  type SupportedImageMimeType,
} from "./types.ts";
import { optimizeImageBytes } from "./optimize-image.ts";

interface PathToken {
  raw: string;
  value: string;
  start: number;
  end: number;
}

export function detectImageMimeType(bytes: Uint8Array): SupportedImageMimeType | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

export function resolveImagePath(input: string, cwd: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  if (isAbsolute(input)) return input;
  return resolve(cwd, input);
}

export function shellUnescape(input: string): string {
  let result = "";
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === "\\" && i + 1 < input.length) {
      result += input[++i]!;
    } else {
      result += char;
    }
  }
  return result;
}

function isPathLike(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value === "~" ||
    value.startsWith("./") ||
    value.startsWith("../")
  );
}

export function tokenizePathLikeText(text: string): PathToken[] {
  const tokens: PathToken[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }

    const start = index;
    if (char === "'" || char === '"') {
      const quote = char;
      index++;
      let value = "";
      let closed = false;
      while (index < text.length) {
        const current = text[index]!;
        if (current === "\\" && quote === '"' && index + 1 < text.length) {
          value += text[index + 1]!;
          index += 2;
          continue;
        }
        if (current === quote) {
          index++;
          closed = true;
          break;
        }
        value += current;
        index++;
      }
      if (closed && isPathLike(value))
        tokens.push({ raw: text.slice(start, index), value, start, end: index });
      continue;
    }

    let rawValue = "";
    while (index < text.length) {
      const current = text[index]!;
      if (/\s/.test(current)) break;
      if (current === "\\" && index + 1 < text.length) {
        rawValue += current + text[index + 1]!;
        index += 2;
        continue;
      }
      rawValue += current;
      index++;
    }
    const value = shellUnescape(rawValue);
    if (isPathLike(value)) tokens.push({ raw: rawValue, value, start, end: index });
  }

  return tokens;
}

export function dimensionsForImage(data: string, mimeType: SupportedImageMimeType) {
  return getImageDimensions(data, mimeType) ?? undefined;
}

export function loadImageFromPath(
  inputPath: string,
  cwd: string,
  maxBytes = MAX_IMAGE_BYTES,
): LoadImageResult {
  const path = resolveImagePath(inputPath, cwd);
  try {
    if (!existsSync(path)) return { ok: false, reason: "missing", path };
    const stat = statSync(path);
    if (!stat.isFile()) return { ok: false, reason: "not-file", path };
    if (stat.size > maxBytes) return { ok: false, reason: "too-large", path };

    const data = readFileSync(path);
    const mimeType = detectImageMimeType(data);
    if (!mimeType) return { ok: false, reason: "unsupported", path };

    const base64Data = data.toString("base64");
    return {
      ok: true,
      image: {
        originalPath: path,
        mimeType,
        data: base64Data,
        dimensions: dimensionsForImage(base64Data, mimeType),
      },
    };
  } catch {
    return { ok: false, reason: "read-error", path };
  }
}

export function replaceImagePathsInText(
  text: string,
  options: {
    cwd: string;
    store: AttachmentStore;
    loadImage?: (path: string, cwd: string) => LoadImageResult;
    onReject?: (result: Exclude<LoadImageResult, { ok: true }>) => void;
  },
): { text: string; replaced: number; accepted: ImageAttachment[] } {
  const tokens = tokenizePathLikeText(text);
  if (tokens.length === 0) return { text, replaced: 0, accepted: [] };

  let output = "";
  let cursor = 0;
  let replaced = 0;
  const accepted: ImageAttachment[] = [];
  const loadImage = options.loadImage ?? loadImageFromPath;

  for (const token of tokens) {
    const result = loadImage(token.value, options.cwd);
    if (!result.ok) {
      options.onReject?.(result);
      continue;
    }

    const attachment = options.store.add(result.image);
    accepted.push(attachment);
    output += text.slice(cursor, token.start) + attachment.placeholder;
    cursor = token.end;
    replaced++;
  }

  if (replaced === 0) return { text, replaced: 0, accepted: [] };
  output += text.slice(cursor);
  return { text: output, replaced, accepted };
}

export function imagesForText(
  store: AttachmentStore,
  text: string,
  existing: PasterImageContent[] = [],
): PasterImageContent[] {
  return [
    ...existing,
    ...store.matchingPlaceholders(text).map((attachment) => ({
      type: "image" as const,
      mimeType: attachment.mimeType,
      data: attachment.data,
    })),
  ];
}

/**
 * Async variant of imagesForText that runs each attachment through the
 * Anthropic-aware image optimizer (resize to 8000px cap, JPEG ladder to stay
 * under the 5 MB / 32 MB request caps). Optimization is cached on the
 * attachment so the cost is paid once per image, not per submit.
 *
 * Used by paster's `input` handler; safe to await on the hot path because
 * sharp is only invoked when the image is actually over the limits.
 */
export async function imagesForTextOptimized(
  store: AttachmentStore,
  text: string,
  existing: PasterImageContent[] = [],
): Promise<PasterImageContent[]> {
  const attachments = store.matchingPlaceholders(text);
  const optimized: PasterImageContent[] = [];
  for (const attachment of attachments) {
    if (!attachment.optimized) {
      try {
        const input = Buffer.from(attachment.data, "base64");
        const result = await optimizeImageBytes(input, attachment.mimeType);
        if (result.changed) {
          attachment.data = result.data;
          attachment.mimeType = result.mimeType;
          if (result.finalDim) {
            attachment.dimensions = {
              widthPx: result.finalDim.width,
              heightPx: result.finalDim.height,
            };
          }
        }
        attachment.optimized = true;
        attachment.originalBytes = result.originalBytes;
        attachment.finalBytes = result.finalBytes;
        attachment.optimizeActions = result.actions;
      } catch {
        // optimization is best-effort; fall through with the original bytes
        attachment.optimized = true;
      }
    }
    optimized.push({
      type: "image",
      mimeType: attachment.mimeType,
      data: attachment.data,
    });
  }
  return [...existing, ...optimized];
}
