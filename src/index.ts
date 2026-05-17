import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readClipboardImage } from "./clipboard.ts";
import { type PasterConfig, resolvePasterConfig } from "./config.ts";
import { PasterEditor } from "./editor.ts";
import { imagesForTextOptimized } from "./image-utils.ts";
import { CursorImagePreviewWidget, ImagePreviewMessage } from "./preview.ts";
import { AttachmentStore } from "./store.ts";
import { createImagePasteTerminalInputHandler } from "./terminal-input.ts";
import type { ImageAttachment, PasterPreviewDetails } from "./types.ts";

export * from "./clipboard.ts";
export * from "./optimize-image.ts";
export * from "./config.ts";
export * from "./editor.ts";
export * from "./image-utils.ts";
export * from "./preview.ts";
export * from "./store.ts";
export * from "./terminal-input.ts";
export * from "./types.ts";

export function createPaster(config: PasterConfig = {}): (pi: ExtensionAPI) => void {
  return (pi) => paster(pi, config);
}

export default function paster(pi: ExtensionAPI, config: PasterConfig = {}): void {
  const resolvedConfig = resolvePasterConfig(config);
  const store = new AttachmentStore();
  let pendingPreview: ImageAttachment[] = [];
  let activeEditor: PasterEditor | undefined;
  let unsubscribeTerminalInput: (() => void) | undefined;

  pi.registerMessageRenderer<PasterPreviewDetails>("paster-preview", (message, _options, theme) => {
    const placeholders = message.details?.placeholders ?? [];
    const attachments = store
      .list()
      .filter((attachment) => placeholders.includes(attachment.placeholder));
    if (attachments.length === 0) return undefined;
    return new ImagePreviewMessage(attachments, {
      fallbackColor: (text) => theme.fg("muted", text),
    });
  });

  pi.on("session_start", (_event, ctx) => {
    store.clear();
    pendingPreview = [];
    if (!ctx.hasUI) return;

    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    activeEditor?.clearCursorPreview();
    activeEditor = undefined;
    ctx.ui.setWidget("paster-cursor-preview", undefined, { placement: "aboveEditor" });

    if (!resolvedConfig.customEditor.enabled) {
      unsubscribeTerminalInput = ctx.ui.onTerminalInput(
        createImagePasteTerminalInputHandler({
          cwd: ctx.cwd,
          store,
          notify: (message) => ctx.ui.notify(message, "warning"),
        }),
      );
      return;
    }

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      activeEditor = new PasterEditor(tui, theme, keybindings, {
        cwd: ctx.cwd,
        store,
        notify: (message) => ctx.ui.notify(message, "warning"),
        deletePlaceholderAsBlock: resolvedConfig.customEditor.deletePlaceholderAsBlock,
        pasteClipboardImage: () => {
          const result = readClipboardImage();
          if (!result.ok) {
            if (result.reason !== "empty" && result.reason !== "unsupported-platform") {
              ctx.ui.notify("paster: clipboard image could not be attached", "warning");
            }
            return undefined;
          }
          return store.add(result.image);
        },
        setCursorPreview: (attachment) => {
          if (!resolvedConfig.customEditor.showImagePreview) return;
          ctx.ui.setWidget(
            "paster-cursor-preview",
            attachment
              ? (_tui, widgetTheme) =>
                  new CursorImagePreviewWidget(attachment, {
                    title: (text) => widgetTheme.fg("accent", text),
                    muted: (text) => widgetTheme.fg("muted", text),
                    accent: (text) => widgetTheme.fg("accent", text),
                  })
              : undefined,
            { placement: "aboveEditor" },
          );
        },
      });
      return activeEditor;
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    pendingPreview = [];
    if (ctx.hasUI) {
      unsubscribeTerminalInput?.();
      unsubscribeTerminalInput = undefined;
      activeEditor?.clearCursorPreview();
      activeEditor = undefined;
      ctx.ui.setWidget("paster-cursor-preview", undefined, { placement: "aboveEditor" });
      ctx.ui.setEditorComponent(undefined);
    }
    store.clear();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (ctx.hasUI) {
      activeEditor?.clearCursorPreview();
    }

    const attachments = store.matchingPlaceholders(event.text);
    if (attachments.length === 0) return { action: "continue" as const };
    pendingPreview = attachments;

    // Optimize images on-submit so we never exceed Anthropic's 5 MB/image or
    // 32 MB/request caps. Per-attachment caching means each image is only
    // resized/recompressed once across the whole session.
    const images = await imagesForTextOptimized(store, event.text, event.images);

    return {
      action: "transform" as const,
      text: event.text,
      images,
    };
  });

  pi.on("before_agent_start", () => {
    if (pendingPreview.length === 0) return;
    const placeholders = pendingPreview.map((attachment) => attachment.placeholder);
    pendingPreview = [];
    return {
      message: {
        customType: "paster-preview",
        content: "",
        display: true,
        details: { placeholders },
      },
    };
  });
}
