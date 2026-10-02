import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { copy } from "../src/messages.ts";
import { approvePlan, isPlanApproval, type PlanContext } from "../src/plan-approval.ts";

const reject: PermissionOption = { optionId: "reject", name: "No, keep planning", kind: "reject_once" };
const manual: PermissionOption = {
  optionId: "exit-plan-default",
  name: "Yes, manually approve edits",
  kind: "allow_once",
};
const acceptEdits: PermissionOption = {
  optionId: "exit-plan-accept-edits",
  name: "Yes, auto-accept edits",
  kind: "allow_always",
};
const auto: PermissionOption = {
  optionId: "exit-plan-auto",
  name: "Yes, and use auto mode",
  kind: "allow_always",
};

const request = (options: PermissionOption[]): RequestPermissionRequest => ({
  sessionId: "acp-1",
  toolCall: {
    toolCallId: "p1",
    rawInput: { plan: "1. Hacer" },
    _meta: { claudeCode: { toolName: "ExitPlanMode" } },
  },
  options,
});

function context(answer: string | undefined, feedback?: string) {
  const asked: { title: string; options: string[] }[] = [];
  const sent: string[] = [];
  let editsAfter = 0;
  const ctx: PlanContext = {
    ui: {
      select: async (title, options) => {
        asked.push({ title, options });
        return answer;
      },
      input: async () => feedback,
    },
    acceptEditsAfterApproval: () => editsAfter++,
    sendFeedback: (text) => sent.push(text),
  };
  return { ctx, asked, sent, editsAfter: () => editsAfter };
}

const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

describe("approvePlan", () => {
  it("recognizes the request to leave plan mode", () => {
    expect(isPlanApproval(request([]))).toBe(true);
  });

  it("offers Claude Code's three answers and never the ones that reset the context", async () => {
    const { ctx, asked } = context(copy.planManual);
    await approvePlan(request([auto, manual, reject]), ctx);
    expect(asked).toEqual([
      { title: copy.planQuestion, options: [copy.planAcceptEdits, copy.planManual, copy.planKeep] },
    ]);
  });

  it("selects the adapter's auto-accept edits option when it is offered", async () => {
    const { ctx, editsAfter } = context(copy.planAcceptEdits);
    await expect(approvePlan(request([acceptEdits, manual, reject]), ctx)).resolves.toEqual(
      selected("exit-plan-accept-edits"),
    );
    expect(editsAfter()).toBe(0);
  });

  it("approves manually and switches to auto-accept edits afterwards when the adapter offers Auto instead", async () => {
    const { ctx, editsAfter } = context(copy.planAcceptEdits);
    await expect(approvePlan(request([auto, manual, reject]), ctx)).resolves.toEqual(
      selected("exit-plan-default"),
    );
    expect(editsAfter()).toBe(1);
  });

  it("keeps planning and sends what the user wants changed as the next message", async () => {
    const { ctx, sent } = context(copy.planKeep, "  sumá tests  ");
    await expect(approvePlan(request([manual, reject]), ctx)).resolves.toEqual(selected("reject"));
    expect(sent).toEqual(["sumá tests"]);
  });

  it("keeps planning without a message when the user dismisses the dialog or leaves the answer empty", async () => {
    const dismissed = context(undefined, "");
    await expect(approvePlan(request([manual, reject]), dismissed.ctx)).resolves.toEqual(selected("reject"));
    expect(dismissed.sent).toEqual([]);
  });

  it("C25: answers cancelled when the turn is cancelled while the dialog is open", async () => {
    const controller = new AbortController();
    const { ctx } = context(undefined);
    const select = ctx.ui?.select;
    const cancelling: PlanContext = {
      ...ctx,
      signal: controller.signal,
      ui: ctx.ui && {
        ...ctx.ui,
        select: async (...args) => {
          controller.abort();
          return select?.(...args);
        },
      },
    };
    await expect(approvePlan(request([manual, reject]), cancelling)).resolves.toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("keeps planning when Pi has no dialog UI", async () => {
    const ctx: PlanContext = { ui: undefined, acceptEditsAfterApproval: () => {}, sendFeedback: () => {} };
    await expect(approvePlan(request([manual, reject]), ctx)).resolves.toEqual(selected("reject"));
  });
});
