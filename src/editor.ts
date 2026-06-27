import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { describeReject, replaceImagePathsInText } from "./image-utils.ts";
import type { AttachmentStore } from "./store.ts";
import type { ImageAttachment } from "./types.ts";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
const PLACEHOLDER_REGEX = /\[#image \d+\]/g;
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

interface AtomicSpan {
  start: number;
  end: number;
}

interface EditorSegmentationAccess {
  segment?: (text: string, mode?: "word" | "grapheme") => Iterable<Intl.SegmentData>;
  pastes?: Map<number, string>;
}

function atomicSpansForText(text: string, validPasteIds: Set<number>): AtomicSpan[] {
  const spans: AtomicSpan[] = [];

  for (const match of text.matchAll(PASTE_MARKER_REGEX)) {
    const id = Number.parseInt(match[1]!, 10);
    if (!validPasteIds.has(id)) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }

  for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
    const placeholder = match[0];
    spans.push({ start: match.index, end: match.index + placeholder.length });
  }

  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function segmentTextWithAtomicImages(
  text: string,
  store: AttachmentStore,
  validPasteIds: Set<number> = new Set(),
  segmenter: Intl.Segmenter = graphemeSegmenter,
): Intl.SegmentData[] {
  const spans = atomicSpansForText(text, validPasteIds);
  if (spans.length === 0) return [...segmenter.segment(text)];

  const result: Intl.SegmentData[] = [];
  let spanIndex = 0;
  for (const segment of segmenter.segment(text)) {
    while (spanIndex < spans.length && spans[spanIndex]!.end <= segment.index) spanIndex++;
    const span = spans[spanIndex];
    if (span && segment.index >= span.start && segment.index < span.end) {
      if (segment.index === span.start) {
        result.push({ segment: text.slice(span.start, span.end), index: span.start, input: text });
      }
      continue;
    }
    result.push(segment);
  }
  return result;
}

interface EditorCursor {
  line: number;
  col: number;
}

interface PlaceholderAtCursor {
  attachment?: ImageAttachment;
  placeholder: string;
  line: number;
  start: number;
  end: number;
}

function findPlaceholderAtCursor(
  store: AttachmentStore,
  lines: string[],
  cursor: EditorCursor,
  mode: "hover" | "backspace" | "delete",
): PlaceholderAtCursor | undefined {
  const line = lines[cursor.line] ?? "";
  for (const match of line.matchAll(PLACEHOLDER_REGEX)) {
    const placeholder = match[0];
    const start = match.index;
    const end = start + placeholder.length;
    const attachment = store.get(placeholder);
    if (!attachment && mode !== "hover") continue;

    if (mode === "hover" && cursor.col >= start && cursor.col < end) {
      return { attachment, placeholder, line: cursor.line, start, end };
    }
    if (mode === "backspace" && cursor.col > start && cursor.col <= end) {
      return { attachment, placeholder, line: cursor.line, start, end };
    }
    if (mode === "delete" && cursor.col >= start && cursor.col < end) {
      return { attachment, placeholder, line: cursor.line, start, end };
    }
  }
  return undefined;
}

interface EditorStateAccess {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  pushUndoSnapshot?: () => void;
  setCursorCol?: (col: number) => void;
  lastAction?: unknown;
  historyIndex?: number;
}

export class PasterEditor extends CustomEditor {
  private pasterPasteBuffer: string | undefined;
  private activePreviewPlaceholder: string | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly pasterKeybindings: KeybindingsManager,
    private readonly pasterOptions: {
      cwd: string;
      store: AttachmentStore;
      notify: (message: string) => void;
      deletePlaceholderAsBlock: boolean;
      setCursorPreview: (attachment: ImageAttachment | undefined) => void;
      pasteClipboardImage?: () =>
        | Promise<ImageAttachment | undefined>
        | ImageAttachment
        | undefined;
    },
  ) {
    super(tui, theme, pasterKeybindings);
    this.installAtomicImageSegmentation();
    this.onPasteImage = () => {
      void this.handlePasteClipboardImage();
    };
  }

  override insertTextAtCursor(text: string): void {
    const transformed = this.transform(text);
    super.insertTextAtCursor(transformed.replaced > 0 ? transformed.text : text);
    this.updateCursorPreview();
  }

  override handleInput(data: string): void {
    if (this.handleBracketedPaste(data)) return;
    if (this.handleAtomicPlaceholderNavigation(data)) return;
    if (this.pasterOptions.deletePlaceholderAsBlock && this.handleAtomicPlaceholderDelete(data))
      return;

    super.handleInput(data);
    this.updateCursorPreview();
  }

  clearCursorPreview(): void {
    this.activePreviewPlaceholder = undefined;
    this.pasterOptions.setCursorPreview(undefined);
  }

  private installAtomicImageSegmentation(): void {
    const editor = this as unknown as EditorSegmentationAccess;
    editor.segment = (text: string, mode: "word" | "grapheme" = "grapheme") =>
      segmentTextWithAtomicImages(
        text,
        this.pasterOptions.store,
        new Set(editor.pastes?.keys() ?? []),
        mode === "word" ? wordSegmenter : graphemeSegmenter,
      );
  }

  private async handlePasteClipboardImage(): Promise<void> {
    const attachment = await this.pasterOptions.pasteClipboardImage?.();
    if (!attachment) return;
    super.insertTextAtCursor(attachment.placeholder);
    this.updateCursorPreview();
    this.tui.requestRender();
  }

  private handleBracketedPaste(data: string): boolean {
    let prefix = "";
    const original = data;
    const wasBuffered = this.pasterPasteBuffer !== undefined;

    if (this.pasterPasteBuffer === undefined) {
      const start = data.indexOf(PASTE_START);
      if (start === -1) return false;
      prefix = data.slice(0, start);
      this.pasterPasteBuffer = data.slice(start + PASTE_START.length);
      if (!this.pasterPasteBuffer.includes(PASTE_END)) {
        if (prefix) super.handleInput(prefix);
        return true;
      }
    } else {
      this.pasterPasteBuffer += data;
      if (!this.pasterPasteBuffer.includes(PASTE_END)) return true;
    }

    const end = this.pasterPasteBuffer.indexOf(PASTE_END);
    const content = this.pasterPasteBuffer.slice(0, end);
    const remaining = this.pasterPasteBuffer.slice(end + PASTE_END.length);
    this.pasterPasteBuffer = undefined;

    const transformed = this.transform(content);
    if (transformed.replaced === 0) {
      super.handleInput(
        wasBuffered ? `${PASTE_START}${content}${PASTE_END}${remaining}` : original,
      );
      this.updateCursorPreview();
      return true;
    }

    if (prefix) super.handleInput(prefix);
    super.insertTextAtCursor(transformed.text);
    if (remaining) super.handleInput(remaining);
    this.updateCursorPreview();
    return true;
  }

  private handleAtomicPlaceholderNavigation(data: string): boolean {
    const isLeft = this.pasterKeybindings.matches(data, "tui.editor.cursorLeft");
    const isRight = this.pasterKeybindings.matches(data, "tui.editor.cursorRight");
    if (!isLeft && !isRight) return false;

    const line = this.getLines()[this.getCursor().line] ?? "";
    const cursor = this.getCursor();
    const matches = [...line.matchAll(PLACEHOLDER_REGEX)];
    const target = isRight
      ? matches.find(
          (match) => cursor.col >= match.index && cursor.col < match.index + match[0].length,
        )
      : matches.find(
          (match) => cursor.col > match.index && cursor.col <= match.index + match[0].length,
        );
    if (!target) return false;

    this.setCursor(target.index + (isRight ? target[0].length : 0));
    this.updateCursorPreview();
    this.tui.requestRender();
    return true;
  }

  private handleAtomicPlaceholderDelete(data: string): boolean {
    const isBackspace = this.pasterKeybindings.matches(data, "tui.editor.deleteCharBackward");
    const isDelete = this.pasterKeybindings.matches(data, "tui.editor.deleteCharForward");
    if (!isBackspace && !isDelete) return false;
    if (isDelete && this.getText().length === 0) return false;

    const target = findPlaceholderAtCursor(
      this.pasterOptions.store,
      this.getLines(),
      this.getCursor(),
      isBackspace ? "backspace" : "delete",
    );
    if (!target) return false;

    this.deleteLineRange(target.line, target.start, target.end);
    this.updateCursorPreview();
    return true;
  }

  private setCursor(col: number): void {
    const editor = this as unknown as EditorStateAccess;
    if (editor.setCursorCol) {
      editor.setCursorCol(col);
    } else {
      editor.state.cursorCol = col;
    }
  }

  private deleteLineRange(lineIndex: number, start: number, end: number): void {
    const editor = this as unknown as EditorStateAccess;
    editor.pushUndoSnapshot?.();
    const line = editor.state.lines[lineIndex] ?? "";
    editor.state.lines[lineIndex] = line.slice(0, start) + line.slice(end);
    editor.state.cursorLine = lineIndex;
    this.setCursor(start);
    editor.lastAction = null;
    editor.historyIndex = -1;
    this.onChange?.(this.getText());
    this.tui.requestRender();
  }

  private transform(text: string): { text: string; replaced: number; accepted: ImageAttachment[] } {
    return replaceImagePathsInText(text, {
      cwd: this.pasterOptions.cwd,
      store: this.pasterOptions.store,
      onReject: (result) => describeReject(result, this.pasterOptions.notify),
    });
  }

  private updateCursorPreview(): void {
    const target = findPlaceholderAtCursor(
      this.pasterOptions.store,
      this.getLines(),
      this.getCursor(),
      "hover",
    );
    const nextPlaceholder = target?.attachment?.placeholder;
    if (nextPlaceholder === this.activePreviewPlaceholder) return;
    this.activePreviewPlaceholder = nextPlaceholder;
    this.pasterOptions.setCursorPreview(target?.attachment);
  }
}
