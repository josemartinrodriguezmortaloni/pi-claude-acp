import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copy } from "./messages.ts";
import { usesClaudeAcp } from "./sessions.ts";

export const LOGIN_COMMAND = "claude-login";
export const LOGIN_HINT = copy.loginHint(LOGIN_COMMAND);

export type LoginState = "logged-in" | "logged-out" | "unknown";

const STATES = new Map<unknown, LoginState>([
  [true, "logged-in"],
  [false, "logged-out"],
]);

/** Runs a command and captures its output, like `pi.exec`. */
export type Capture = (command: string, args: string[]) => Promise<{ stdout: string }>;
/** Runs a command attached to the terminal and resolves with its exit code. */
export type Attach = (command: string, args: string[]) => Promise<number>;

export interface LoginDeps {
  /** The validated Claude Code binary. */
  executable(): Promise<string>;
  capture: Capture;
  attach: Attach;
  /** Drops the adapter process, so the next turn starts one that reads the new login. */
  restartAdapter(): void;
}

/** A component with nothing to draw: the terminal belongs to the login command while it runs. */
const BLANK = { render: () => [], invalidate: () => {} };

/**
 * Reads `loggedIn` from `claude auth status --json`. The output also names the account and the
 * organization, so nothing else is read or logged. A logged-out binary exits 1 but still prints JSON.
 */
export async function loginState(exe: string, capture: Capture): Promise<LoginState> {
  const { stdout } = await capture(exe, ["auth", "status", "--json"]).catch(() => ({ stdout: "" }));
  return parseLoggedIn(stdout);
}

function parseLoggedIn(stdout: string): LoginState {
  try {
    return STATES.get(JSON.parse(stdout).loggedIn) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Warns before the first prompt instead of failing it, while a claude-acp model is active. */
export async function warnIfLoggedOut(ctx: Pick<ExtensionContext, "model" | "ui">, deps: LoginDeps) {
  if (!usesClaudeAcp(ctx.model)) return;
  const state = await loginState(await deps.executable(), deps.capture);
  if (state === "logged-out") ctx.ui.notify(LOGIN_HINT, "warning");
}

/** `/claude-login`: the Claude Code binary runs its own login on Pi's terminal. */
export async function login(
  ctx: Pick<ExtensionCommandContext, "mode" | "ui" | "waitForIdle">,
  deps: LoginDeps,
) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(copy.loginOutsideTui(LOGIN_COMMAND), "warning");
    return;
  }
  await ctx.waitForIdle();
  const exe = await deps.executable();
  await onTerminal(ctx.ui, () => deps.attach(exe, ["auth", "login"]));
  report(ctx.ui, await loginState(exe, deps.capture), deps);
}

/** Stops Pi's TUI while `task` owns the terminal, the way Pi runs its external editor. */
function onTerminal(ui: ExtensionCommandContext["ui"], task: () => Promise<number>): Promise<number> {
  return ui.custom<number>((tui, _theme, _keys, done) => {
    tui.stop();
    void task().then((code) => {
      tui.start();
      tui.requestRender(true);
      done(code);
    });
    return BLANK;
  });
}

function report(ui: Pick<ExtensionCommandContext["ui"], "notify">, state: LoginState, deps: LoginDeps): void {
  if (state !== "logged-in") {
    ui.notify(copy.loginIncomplete(LOGIN_COMMAND), "error");
    return;
  }
  deps.restartAdapter();
  ui.notify(copy.loggedIn, "info");
}

/**
 * Runs `command` with Pi's stdin, stdout and stderr. -1 means it could not start.
 * Ctrl+C reaches every process of the terminal's foreground group, so Pi ignores SIGINT while the
 * command runs, as Pi does while it suspends (pi-coding-agent/dist/modes/interactive/interactive-mode.js:3525).
 */
export async function attachToTerminal(command: string, args: string[]): Promise<number> {
  const ignoreSigint = () => {};
  process.on("SIGINT", ignoreSigint);
  try {
    return await exitCode(spawn(command, args, { stdio: "inherit" }));
  } finally {
    process.off("SIGINT", ignoreSigint);
  }
}

function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", (code) => resolve(code ?? -1));
  });
}
