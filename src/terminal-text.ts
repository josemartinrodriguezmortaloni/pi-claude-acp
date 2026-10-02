import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** C0 controls except tab and newline, DEL, and C1 controls: some terminals read 0x9b as a CSI. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Text that a repo, a tool or the agent wrote, safe to print. A terminal runs escape sequences
 * instead of showing them: OSC 52 writes the clipboard, OSC 8 hides where a link goes, and cursor
 * moves can redraw a dialog. Pi's own tool renderers strip them too.
 */
export function printable(text: string): string {
  return stripTerminalSequences(text).replace(CONTROL, "");
}

/** `value` with `printable` applied to every string inside it. `value` is plain JSON. */
export function printableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
    typeof item === "string" ? printable(item) : item,
  );
}
