import { describe, expect, it } from "vitest";
import {
  attachToTerminal,
  type Capture,
  LOGIN_HINT,
  type LoginDeps,
  login,
  loginState,
  warnIfLoggedOut,
} from "../src/login.ts";
import { copy } from "../src/messages.ts";

const EXE = "/opt/claude";

/** `claude auth status --json` exits 1 when logged out but still prints JSON. */
function status(loggedIn: unknown): Capture {
  return async () => ({ stdout: JSON.stringify({ loggedIn, email: "someone@example.com" }) });
}

function deps(capture: Capture, calls: string[] = []): LoginDeps & { restarts: number } {
  return {
    restarts: 0,
    executable: async () => EXE,
    capture,
    attach: async (command, args) => {
      calls.push(`attach ${command} ${args.join(" ")}`);
      return 0;
    },
    restartAdapter() {
      this.restarts++;
    },
  };
}

function fakeUi(calls: string[] = []) {
  const notes: { message: string; type?: string }[] = [];
  const ui = {
    notify: (message: string, type?: string) => notes.push({ message, type }),
    custom: (
      factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => unknown,
    ) =>
      new Promise((resolve) => {
        const tui = {
          stop: () => calls.push("stop"),
          start: () => calls.push("start"),
          requestRender: () => calls.push("render"),
        };
        factory(tui, undefined, undefined, resolve);
      }),
  };
  return { ui, notes };
}

function commandCtx(mode: string, ui: unknown, calls: string[] = []) {
  return {
    mode,
    ui,
    waitForIdle: async () => {
      calls.push("idle");
    },
  } as never;
}

describe("loginState", () => {
  it("reads a logged-in account", async () => {
    expect(await loginState(EXE, status(true))).toBe("logged-in");
  });

  it("reads a logged-out account", async () => {
    expect(await loginState(EXE, status(false))).toBe("logged-out");
  });

  it("asks the validated binary for its JSON status", async () => {
    const asked: string[] = [];
    await loginState(EXE, async (command, args) => {
      asked.push(`${command} ${args.join(" ")}`);
      return { stdout: "{}" };
    });
    expect(asked).toEqual([`${EXE} auth status --json`]);
  });

  it.each([
    ["output that is not JSON", async () => ({ stdout: "Loading…" })],
    ["JSON without loggedIn", status(undefined)],
    ["JSON null", async () => ({ stdout: "null" })],
    ["a command that fails to run", async () => Promise.reject(new Error("ENOENT"))],
  ])("reports unknown for %s", async (_label, capture) => {
    expect(await loginState(EXE, capture as Capture)).toBe("unknown");
  });
});

describe("warnIfLoggedOut", () => {
  it("C34: warns at session start when the claude-acp model has no Claude Code login", async () => {
    const { ui, notes } = fakeUi();
    await warnIfLoggedOut({ model: { provider: "claude-acp" }, ui } as never, deps(status(false)));
    expect(notes).toEqual([{ message: LOGIN_HINT, type: "warning" }]);
    expect(LOGIN_HINT).toContain("/claude-login");
  });

  it("stays silent when Claude Code is logged in", async () => {
    const { ui, notes } = fakeUi();
    await warnIfLoggedOut({ model: { provider: "claude-acp" }, ui } as never, deps(status(true)));
    expect(notes).toEqual([]);
  });

  it("stays silent when the status is unknown", async () => {
    const { ui, notes } = fakeUi();
    await warnIfLoggedOut(
      { model: { provider: "claude-acp" }, ui } as never,
      deps(async () => ({ stdout: "" })),
    );
    expect(notes).toEqual([]);
  });

  it("does not ask Claude Code when another provider is active", async () => {
    const { ui, notes } = fakeUi();
    let asked = false;
    const capture: Capture = async () => {
      asked = true;
      return { stdout: '{"loggedIn": false}' };
    };
    await warnIfLoggedOut({ model: { provider: "anthropic" }, ui } as never, deps(capture));
    expect(asked).toBe(false);
    expect(notes).toEqual([]);
  });
});

describe("login", () => {
  it("C35: hands the terminal to `claude auth login` between stopping and restarting the TUI", async () => {
    const calls: string[] = [];
    const { ui } = fakeUi(calls);
    await login(commandCtx("tui", ui, calls), deps(status(true), calls));
    expect(calls).toEqual(["idle", "stop", `attach ${EXE} auth login`, "start", "render"]);
  });

  it("C36: restarts the adapter and confirms once the login succeeds", async () => {
    const { ui, notes } = fakeUi();
    const d = deps(status(true));
    await login(commandCtx("tui", ui), d);
    expect(d.restarts).toBe(1);
    expect(notes).toEqual([{ message: copy.loggedIn, type: "info" }]);
  });

  it("keeps the adapter and reports the failure when there is still no login", async () => {
    const { ui, notes } = fakeUi();
    const d = deps(status(false));
    await login(commandCtx("tui", ui), d);
    expect(d.restarts).toBe(0);
    expect(notes).toEqual([{ message: expect.stringContaining("no se completó"), type: "error" }]);
  });

  it("C37: outside the TUI, points to a terminal and runs nothing", async () => {
    const calls: string[] = [];
    const { ui, notes } = fakeUi(calls);
    const d = deps(status(true), calls);
    await login(commandCtx("rpc", ui, calls), d);
    expect(calls).toEqual([]);
    expect(d.restarts).toBe(0);
    expect(notes).toEqual([{ message: expect.stringContaining("claude auth login"), type: "warning" }]);
  });
});

describe("attachToTerminal", () => {
  it("resolves with the exit code of the command", async () => {
    expect(await attachToTerminal("sh", ["-c", "exit 3"])).toBe(3);
  });

  it("resolves with -1 when the command cannot start", async () => {
    expect(await attachToTerminal("/nonexistent/claude", ["auth", "login"])).toBe(-1);
  });

  it("keeps Pi alive through a Ctrl+C meant for the command, and stops guarding afterwards", async () => {
    const before = process.listenerCount("SIGINT");
    const running = attachToTerminal("sh", ["-c", "sleep 0.2"]);
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    await running;
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
