import type { CreateElicitationRequest, ElicitationSchema } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { answerElicitation, type ElicitContext } from "../src/elicitation.ts";

type Dialog = { kind: "select" | "input" | "confirm"; title: string; options?: string[] };

/** A Pi UI that answers each dialog from a script, in order, and records what it showed. */
function scriptedUi(answers: (string | boolean | undefined)[]) {
  const shown: Dialog[] = [];
  const next = () => answers.shift();
  const ui: NonNullable<ElicitContext["ui"]> = {
    select: async (title, options) => {
      shown.push({ kind: "select", title, options });
      return next() as string | undefined;
    },
    input: async (title) => {
      shown.push({ kind: "input", title });
      return next() as string | undefined;
    },
    confirm: async (title) => {
      shown.push({ kind: "confirm", title });
      return next() === true;
    },
  };
  return { ui, shown };
}

function form(message: string, requestedSchema: ElicitationSchema): CreateElicitationRequest {
  return { mode: "form", sessionId: "acp-1", message, requestedSchema };
}

const option = (label: string, description?: string) => ({ const: label, title: label, description });

/** The shape claude-agent-acp builds for one AskUserQuestion question (elicitation.js:117-160). */
const ASK_ONE = form("¿Qué base de datos usamos?", {
  type: "object",
  properties: {
    question_0: { type: "string", title: "DB", oneOf: [option("Postgres", "Relacional"), option("SQLite")] },
    question_0_custom: { type: "string", title: "Other" },
  },
});

describe("answerElicitation: AskUserQuestion forms", () => {
  it("asks a single-select question with its options and an own-answer entry", async () => {
    const { ui, shown } = scriptedUi(["Postgres — Relacional"]);
    await expect(answerElicitation(ASK_ONE, { ui })).resolves.toEqual({
      action: "accept",
      content: { question_0: "Postgres" },
    });
    expect(shown).toEqual([
      {
        kind: "select",
        title: "DB · ¿Qué base de datos usamos?",
        options: ["Postgres — Relacional", "SQLite", "Otra respuesta…"],
      },
    ]);
  });

  it("writes an own answer to the companion _custom field", async () => {
    const { ui, shown } = scriptedUi(["Otra respuesta…", "DuckDB"]);
    await expect(answerElicitation(ASK_ONE, { ui })).resolves.toEqual({
      action: "accept",
      content: { question_0_custom: "DuckDB" },
    });
    expect(shown.map((d) => d.kind)).toEqual(["select", "input"]);
  });

  it("toggles multi-select options until the user is done", async () => {
    const request = form("Please answer the following questions.", {
      type: "object",
      properties: {
        question_0: {
          type: "array",
          title: "Tests",
          description: "¿Qué corremos?",
          items: { anyOf: [option("unit"), option("e2e"), option("smoke")] },
        },
      },
    });
    const { ui, shown } = scriptedUi(["[ ] unit", "[ ] smoke", "[x] unit", "[ ] unit", "Listo"]);
    await expect(answerElicitation(request, { ui })).resolves.toEqual({
      action: "accept",
      content: { question_0: ["smoke", "unit"] },
    });
    expect(shown.at(-1)?.options).toEqual(["[x] unit", "[ ] e2e", "[x] smoke", "Listo"]);
  });

  it("asks every question of a multi-question form in order", async () => {
    const request = form("Please answer the following questions.", {
      type: "object",
      properties: {
        question_0: { type: "string", description: "¿Lenguaje?", oneOf: [option("TS"), option("Rust")] },
        question_0_custom: { type: "string" },
        question_1: { type: "string", description: "¿Runtime?", oneOf: [option("bun"), option("node")] },
        question_1_custom: { type: "string" },
      },
    });
    const { ui, shown } = scriptedUi(["Rust", "bun"]);
    await expect(answerElicitation(request, { ui })).resolves.toEqual({
      action: "accept",
      content: { question_0: "Rust", question_1: "bun" },
    });
    expect(shown.map((d) => d.title)).toEqual(["¿Lenguaje?", "¿Runtime?"]);
  });
});

describe("answerElicitation: generic forms", () => {
  it("uses a confirmation for booleans and an input for text and numbers", async () => {
    const request = form("Configurar servidor", {
      type: "object",
      properties: {
        remote: { type: "boolean", title: "¿Remoto?" },
        name: { type: "string", title: "Nombre" },
        port: { type: "integer", title: "Puerto" },
      },
    });
    const { ui, shown } = scriptedUi([true, "api", "8080"]);
    await expect(answerElicitation(request, { ui })).resolves.toEqual({
      action: "accept",
      content: { remote: true, name: "api", port: 8080 },
    });
    expect(shown.map((d) => d.kind)).toEqual(["confirm", "input", "input"]);
  });

  it("offers a plain enum as a select", async () => {
    const request = form("Nivel", {
      type: "object",
      properties: { level: { type: "string", enum: ["bajo", "alto"] } },
    });
    const { ui } = scriptedUi(["alto"]);
    await expect(answerElicitation(request, { ui })).resolves.toEqual({
      action: "accept",
      content: { level: "alto" },
    });
  });
});

describe("answerElicitation: skipping and cancelling", () => {
  it("declines when the user dismisses a dialog, so Claude is told the user skipped", async () => {
    const { ui } = scriptedUi([undefined]);
    await expect(answerElicitation(ASK_ONE, { ui })).resolves.toEqual({ action: "decline" });
  });

  it("declines when Pi has no dialog UI", async () => {
    await expect(answerElicitation(ASK_ONE, { ui: undefined })).resolves.toEqual({ action: "decline" });
  });

  it("declines URL elicitations, which the extension does not announce", async () => {
    const { ui, shown } = scriptedUi([]);
    const request = {
      mode: "url",
      sessionId: "acp-1",
      message: "Login",
      url: "https://x.test",
      elicitationId: "e",
    };
    await expect(answerElicitation(request as CreateElicitationRequest, { ui })).resolves.toEqual({
      action: "decline",
    });
    expect(shown).toEqual([]);
  });

  it("cancels when the turn is cancelled", async () => {
    const controller = new AbortController();
    const { ui } = scriptedUi([]);
    ui.select = async () => {
      controller.abort();
      return undefined;
    };
    await expect(answerElicitation(ASK_ONE, { ui, signal: controller.signal })).resolves.toEqual({
      action: "cancel",
    });
  });
});
