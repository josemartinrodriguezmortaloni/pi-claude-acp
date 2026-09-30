/**
 * Pi keeps one dialog: a new `select`, `input` or `confirm` replaces the open one and never resolves it
 * (pi-coding-agent/dist/modes/interactive/interactive-mode.js:2034). Every dialog the extension shows
 * goes through this queue, so parallel requests wait instead of orphaning each other.
 */
let open: Promise<unknown> = Promise.resolve();

/** Runs `show` after the previous dialog sequence ends. `show` may open several dialogs in a row. */
export function oneAtATime<T>(show: () => Promise<T>): Promise<T> {
  const shown = open.then(show);
  open = shown.catch(() => undefined);
  return shown;
}
