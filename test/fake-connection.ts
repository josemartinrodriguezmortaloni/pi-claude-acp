import type * as acp from "@agentclientprotocol/sdk";
import { type AcpConnection, type AgentRequests, SessionRouter } from "../src/connection.ts";

export interface Call {
  method: keyof AgentRequests;
  params: Record<string, unknown>;
}

const EFFORTS: Record<string, string[]> = {
  opus: ["low", "medium", "high", "xhigh", "max"],
  haiku: [],
};

export function configOptions(model = "opus", effort = "default"): acp.SessionConfigOption[] {
  const options: acp.SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: Object.keys(EFFORTS).map((value) => ({ value, name: value.toUpperCase() })),
    },
  ];
  const levels = EFFORTS[model] ?? [];
  if (levels.length === 0) return options;
  options.push({
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: ["default", ...levels].map((value) => ({ value, name: value })),
  });
  return options;
}

type PromptScript = (params: acp.PromptRequest, fake: FakeConnection) => Promise<acp.PromptResponse>;

/**
 * In-memory ACP agent. It answers like claude-agent-acp for the calls the extension makes and routes
 * updates and permission requests through the real SessionRouter.
 */
export class FakeConnection implements AcpConnection {
  readonly calls: Call[] = [];
  readonly logged: string[] = [];
  readonly claudeVersion = "2.1.285";
  supportsImages = true;
  closed = false;
  resumeFails = false;
  promptError: unknown;
  onPrompt: PromptScript = async () => ({ stopReason: "end_turn" });
  #nextSession = 0;
  readonly #models = new Map<string, { model: string; effort: string }>();
  readonly #router = new SessionRouter((line) => this.logged.push(line));
  #cancelWaiters: (() => void)[] = [];

  readonly agent: AgentRequests = {
    newSession: async (params) => {
      this.#record("newSession", params);
      const sessionId = `acp-${++this.#nextSession}`;
      return { sessionId, configOptions: this.#options(sessionId) };
    },
    resumeSession: async (params) => {
      this.#record("resumeSession", params);
      if (this.resumeFails) throw new Error("Resource not found");
      return { configOptions: this.#options(params.sessionId) };
    },
    closeSession: async (params) => this.#record("closeSession", params),
    setSessionMode: async (params) => this.#record("setSessionMode", params),
    setSessionConfigOption: async (params) => {
      this.#record("setSessionConfigOption", params);
      const state = this.#state(params.sessionId);
      if (params.configId === "model")
        Object.assign(state, { model: String(params.value), effort: "default" });
      if (params.configId === "effort") state.effort = String(params.value);
      return { configOptions: this.#options(params.sessionId) };
    },
    prompt: async (params) => {
      this.#record("prompt", params);
      if (this.promptError) throw this.promptError;
      return this.onPrompt(params, this);
    },
    cancel: async (params) => {
      this.#record("cancel", params);
      for (const resolve of this.#cancelWaiters.splice(0)) resolve();
    },
  };

  listen(sessionId: string, listener: Parameters<AcpConnection["listen"]>[1]): () => void {
    return this.#router.listen(sessionId, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(sessionId: string, update: acp.SessionUpdate): void {
    this.#router.update({ sessionId, update });
  }

  requestPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return this.#router.permission(request);
  }

  /** Resolves on the next session/cancel notification. */
  untilCancel(): Promise<void> {
    return new Promise((resolve) => this.#cancelWaiters.push(resolve));
  }

  callsOf(method: keyof AgentRequests): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  #record(method: keyof AgentRequests, params: object): void {
    this.calls.push({ method, params: params as Record<string, unknown> });
  }

  #state(sessionId: string): { model: string; effort: string } {
    const state = this.#models.get(sessionId) ?? { model: "opus", effort: "default" };
    this.#models.set(sessionId, state);
    return state;
  }

  #options(sessionId: string): acp.SessionConfigOption[] {
    const state = this.#state(sessionId);
    return configOptions(state.model, state.effort);
  }
}
