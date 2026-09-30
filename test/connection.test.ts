import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AcpConnection,
  resolveExecutable,
  SessionRouter,
  sharedConnection,
  validateExecutable,
} from "../src/connection.ts";

async function script(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-acp-"));
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("validateExecutable", () => {
  it("accepts a binary whose --version prints the Claude Code line", async () => {
    const exe = await script("claude", 'echo "2.1.285 (Claude Code)"');
    await expect(validateExecutable(exe)).resolves.toBe("2.1.285");
  });

  it("C33: rejects a wrapper whose --version output does not match, naming path and output", async () => {
    const exe = await script("claude", 'echo "mise: activating"\necho "2.1.285 (Claude Code)"');
    const error = await validateExecutable(exe).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(exe);
    expect((error as Error).message).toContain("mise: activating");
  });

  it("rejects a path that does not exist", async () => {
    await expect(validateExecutable("/nonexistent/claude")).rejects.toThrow("/nonexistent/claude");
  });

  it("rejects a file that is not executable", async () => {
    const exe = await script("claude", 'echo "2.1.285 (Claude Code)"');
    await chmod(exe, 0o644);
    await expect(validateExecutable(exe)).rejects.toThrow(exe);
  });
});

describe("resolveExecutable", () => {
  it("prefers CLAUDE_CODE_EXECUTABLE", async () => {
    const exe = await script("claude", "true");
    await expect(resolveExecutable({ CLAUDE_CODE_EXECUTABLE: exe, PATH: "" })).resolves.toBe(exe);
  });

  it("falls back to claude on the PATH", async () => {
    const exe = await script("claude", "true");
    const dir = exe.slice(0, -"/claude".length);
    await expect(resolveExecutable({ PATH: `/nonexistent:${dir}` })).resolves.toBe(exe);
  });

  it("fails when claude is not on the PATH", async () => {
    await expect(resolveExecutable({ PATH: "/nonexistent" })).rejects.toThrow("claude");
  });
});

describe("SessionRouter", () => {
  const listener = (updates: string[]) => ({
    update: (u: { sessionUpdate: string }) => updates.push(u.sessionUpdate),
    permission: async () => ({ outcome: { outcome: "selected" as const, optionId: "allow" } }),
  });

  it("delivers updates only to the listener of their session", () => {
    const logged: string[] = [];
    const router = new SessionRouter((line) => logged.push(line));
    const a: string[] = [];
    router.listen("a", listener(a));
    router.update({ sessionId: "a", update: { sessionUpdate: "plan", entries: [] } });
    router.update({ sessionId: "b", update: { sessionUpdate: "plan", entries: [] } });
    expect(a).toEqual(["plan"]);
    expect(logged).toHaveLength(1);
  });

  it("answers cancelled to a permission request of a session nobody listens to", async () => {
    const router = new SessionRouter(() => {});
    const unlisten = router.listen("a", listener([]));
    unlisten();
    const response = await router.permission({ sessionId: "a", toolCall: { toolCallId: "t" }, options: [] });
    expect(response.outcome.outcome).toBe("cancelled");
  });
});

describe("sharedConnection", () => {
  it("reuses a live connection and opens a new one after it closes", async () => {
    const made: { closed: boolean }[] = [];
    const get = sharedConnection(async () => {
      made.push({ closed: false });
      return made.at(-1) as unknown as AcpConnection;
    });
    const first = await get.get();
    expect(await get.get()).toBe(first);
    made[0] = Object.assign(made[0] ?? {}, { closed: true });
    expect(await get.get()).not.toBe(first);
    expect(made).toHaveLength(2);
  });

  it("retries after a failed open", async () => {
    let attempts = 0;
    const get = sharedConnection(async () => {
      attempts++;
      if (attempts === 1) throw new Error("boom");
      return { closed: false } as AcpConnection;
    });
    await expect(get.get()).rejects.toThrow("boom");
    await expect(get.get()).resolves.toBeDefined();
  });

  it("closes a connection that was still opening when close was called", async () => {
    let closes = 0;
    let finish = (_: AcpConnection) => {};
    const get = sharedConnection(() => new Promise((resolve) => (finish = resolve)));
    const opening = get.get();
    get.close();
    finish({ closed: false, close: () => closes++ } as unknown as AcpConnection);
    await opening;
    await Promise.resolve();
    expect(closes).toBe(1);
  });

  it("closes the live connection and opens a new one on the next use", async () => {
    let closes = 0;
    const get = sharedConnection(
      async () => ({ closed: false, close: () => closes++ }) as unknown as AcpConnection,
    );
    const first = await get.get();
    get.close();
    await Promise.resolve();
    expect(closes).toBe(1);
    expect(await get.get()).not.toBe(first);
  });
});
