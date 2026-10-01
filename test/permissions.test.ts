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
    ...DEFAULTS,
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
            input: noInput,
          },
  };
  return { ctx, shown, requests };
}

/** The parts of the context these tests do not exercise. */
const DEFAULTS = {
  autoApproves: () => false,
  plan: { acceptEditsAfterApproval: () => {}, sendFeedback: () => {} },
};
const noInput = async () => undefined;

const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });
const cancelled = { outcome: { outcome: "cancelled" } };

describe("C23/C30: decide combines validator votes", () => {
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
    expect(shown[0]?.title).toBe("Bash · rm -rf build");
  });

  it("titles the dialog with the tool name the adapter reports, not its title", async () => {
    const { ctx, shown } = setup({ ui: "Rechazar" });
    const toolCall = {
      toolCallId: "t2",
      title: "Read src/x.ts",
      rawInput: { file_path: "src/x.ts" },
      _meta: { claudeCode: { toolName: "Read" } },
    };
    await decide({ ...REQUEST, toolCall }, ctx);
    expect(shown[0]?.title).toBe("Read · src/x.ts");
  });

  it("C24: rejects when nobody decides and Pi has no UI", async () => {
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
    await expect(decide(REQUEST, { ...DEFAULTS, events, ui: undefined })).resolves.toEqual(
      selected("reject"),
    );
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

/**
 * Mimics Pi's interactive selector (interactive-mode.js:2034): a new dialog replaces the open one and the
 * replaced dialog's promise never resolves.
 */
function piLikeUi() {
  let open: { title: string; answer: (label: string) => void } | undefined;
  const ui = {
    select: (title: string) =>
      new Promise<string | undefined>((resolve) => {
        open = { title, answer: resolve };
      }),
  };
  const answerOpen = async (label: string) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = open;
    open = undefined;
    current?.answer(label);
    return current?.title;
  };
  return { ui, answerOpen };
}

describe("parallel permission requests", () => {
  it("shows one Pi dialog at a time, so a second request cannot orphan the first", async () => {
    const { ui, answerOpen } = piLikeUi();
    const ctx: DecideContext = { ...DEFAULTS, events: createEventBus(), ui: { ...ui, input: noInput } };
    const read = { ...REQUEST, toolCall: { toolCallId: "t1", title: "Read a.ts" } };
    const bash = { ...REQUEST, toolCall: { toolCallId: "t2", title: "Bash ls" } };
    const decisions = Promise.all([decide(read, ctx), decide(bash, ctx)]);
    expect(await answerOpen("Permitir")).toContain("Read a.ts");
    expect(await answerOpen("Rechazar")).toContain("Bash ls");
    await expect(decisions).resolves.toEqual([selected("allow"), selected("reject")]);
  });
});

describe("decide during cancellation", () => {
  it("answers cancelled when the turn is cancelled while a validator is still voting", async () => {
    const controller = new AbortController();
    const events = createEventBus();
    events.on(TOOL_REQUEST_EVENT, (data) => (data as ToolRequest).vote(new Promise(() => {})));
    const decision = decide(REQUEST, { ...DEFAULTS, events, ui: undefined, signal: controller.signal });
    controller.abort();
    await expect(decision).resolves.toEqual(cancelled);
  });

  it("C25: answers cancelled when the turn is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, shown } = setup({ ui: "Permitir", signal: controller.signal });
    await expect(decide(REQUEST, ctx)).resolves.toEqual(cancelled);
    expect(shown).toEqual([]);
  });

  it("C25: answers cancelled when the turn is cancelled while the dialog is open", async () => {
    const controller = new AbortController();
    const events = createEventBus();
    const ctx: DecideContext = {
      ...DEFAULTS,
      events,
      signal: controller.signal,
      ui: {
        input: noInput,
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

describe("modes in decide", () => {
  it("approves without a dialog what the mode approves, once validators let it through", async () => {
    const { ctx, shown } = setup({ votes: ["ask"], ui: "Rechazar" });
    await expect(decide(REQUEST, { ...ctx, autoApproves: () => true })).resolves.toEqual(selected("allow"));
    expect(shown).toEqual([]);
  });

  it("lets a validator deny what the mode would approve", async () => {
    const { ctx } = setup({ votes: ["deny"] });
    await expect(decide(REQUEST, { ...ctx, autoApproves: () => true })).resolves.toEqual(selected("reject"));
  });

  it("sends a plan approval to the plan dialog, not to the validators", async () => {
    const { ctx, requests, shown } = setup({ votes: ["allow"], ui: "No, seguir planificando" });
    const plan = {
      ...REQUEST,
      toolCall: { toolCallId: "p1", _meta: { claudeCode: { toolName: "ExitPlanMode" } } },
    };
    await expect(decide(plan, ctx)).resolves.toEqual(selected("reject"));
    expect(requests).toEqual([]);
    expect(shown[0]?.title).toBe("¿Ejecutar este plan?");
  });
});
