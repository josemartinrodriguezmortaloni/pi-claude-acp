import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  type DecideContext,
  decide,
  TOOL_REQUEST_EVENT,
  type ToolRequest,
  type Vote,
} from "../src/permissions.ts";

const OPTIONS: PermissionOption[] = [
  { optionId: "allow-with-updates", name: "Permitir siempre", kind: "allow_always" },
  { optionId: "allow", name: "Permitir", kind: "allow_once" },
  { optionId: "reject", name: "Rechazar", kind: "reject_once" },
];

const REQUEST: RequestPermissionRequest = {
  sessionId: "acp-1",
  toolCall: { toolCallId: "t1", title: "Bash", kind: "execute", rawInput: { command: "rm -rf build" } },
  options: OPTIONS,
};

function setup(options: { votes?: Vote[]; ui?: string | undefined | "none"; signal?: AbortSignal } = {}) {
  const events = createEventBus();
  const shown: { title: string; options: string[] }[] = [];
  const requests: ToolRequest[] = [];
  for (const vote of options.votes ?? []) {
    events.on(TOOL_REQUEST_EVENT, (data) => {
      const request = data as ToolRequest;
      requests.push(request);
      request.vote(Promise.resolve(vote));
    });
  }
  const ctx: DecideContext = {
    events,
    signal: options.signal,
    ui:
      options.ui === "none"
        ? undefined
        : {
            select: async (title, labels) => {
              shown.push({ title, options: labels });
              return options.ui;
            },
          },
  };
  return { ctx, shown, requests };
}

const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });
const cancelled = { outcome: { outcome: "cancelled" } };

describe("C30: decide combines validator votes", () => {
  it("rejects when any validator denies, without asking the user", async () => {
    const { ctx, shown } = setup({ votes: ["allow", "deny", "ask"], ui: "Permitir" });
    await expect(decide(REQUEST, ctx)).resolves.toEqual(selected("reject"));
    expect(shown).toEqual([]);
  });

  it("asks the user when a validator asks", async () => {
    const { ctx, shown } = setup({ votes: ["allow", "ask"], ui: "Permitir" });
    await expect(decide(REQUEST, ctx)).resolves.toEqual(selected("allow"));
    expect(shown).toHaveLength(1);
  });

  it("approves when every validator allows", async () => {
    const { ctx, shown } = setup({ votes: ["allow", "allow"], ui: "Rechazar" });
    await expect(decide(REQUEST, ctx)).resolves.toEqual(selected("allow"));
    expect(shown).toEqual([]);
  });

  it("asks the user when no validator votes", async () => {
    const { ctx, shown } = setup({ ui: "Rechazar" });
    await expect(decide(REQUEST, ctx)).resolves.toEqual(selected("reject"));
    expect(shown[0]?.title).toContain("Bash");
    expect(shown[0]?.title).toContain("rm -rf build");
  });

  it("rejects when nobody decides and Pi has no UI", async () => {
    const { ctx } = setup({ ui: "none" });
    await expect(decide(REQUEST, ctx)).resolves.toEqual(selected("reject"));
  });

  it("rejects when the user dismisses the dialog", async () => {
    const { ctx } = setup({ ui: undefined });
    await expect(decide(REQUEST, ctx)).resolves.toEqual(selected("reject"));
  });

  it("treats a failed vote as a deny", async () => {
    const events = createEventBus();
    events.on(TOOL_REQUEST_EVENT, (data) => (data as ToolRequest).vote(Promise.reject(new Error("crash"))));
    await expect(decide(REQUEST, { events, ui: undefined })).resolves.toEqual(selected("reject"));
  });

  it("gives validators the tool call and the filtered options", async () => {
    const { ctx, requests } = setup({ votes: ["allow"] });
    await decide(REQUEST, ctx);
    expect(requests[0]?.toolCall).toBe(REQUEST.toolCall);
    expect(requests[0]?.options.map((o) => o.optionId)).toEqual(["allow", "reject"]);
  });
});

describe("C31: allow_always options", () => {
  it("never reach the Pi UI", async () => {
    const { ctx, shown } = setup({ ui: "Permitir" });
    await decide(REQUEST, ctx);
    expect(shown[0]?.options).toEqual(["Permitir", "Rechazar"]);
  });
});

describe("decide during cancellation", () => {
  it("answers cancelled when the turn is cancelled while a validator is still voting", async () => {
    const controller = new AbortController();
    const events = createEventBus();
    events.on(TOOL_REQUEST_EVENT, (data) => (data as ToolRequest).vote(new Promise(() => {})));
    const decision = decide(REQUEST, { events, ui: undefined, signal: controller.signal });
    controller.abort();
    await expect(decision).resolves.toEqual(cancelled);
  });

  it("answers cancelled when the turn is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, shown } = setup({ ui: "Permitir", signal: controller.signal });
    await expect(decide(REQUEST, ctx)).resolves.toEqual(cancelled);
    expect(shown).toEqual([]);
  });

  it("answers cancelled when the turn is cancelled while the dialog is open", async () => {
    const controller = new AbortController();
    const events = createEventBus();
    const ctx: DecideContext = {
      events,
      signal: controller.signal,
      ui: {
        select: (_title, _labels, opts) =>
          new Promise((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(undefined));
            controller.abort();
          }),
      },
    };
    await expect(decide(REQUEST, ctx)).resolves.toEqual(cancelled);
  });
});
