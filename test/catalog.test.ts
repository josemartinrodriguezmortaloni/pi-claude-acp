import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Catalog, toEffort, toPiModels } from "../src/catalog.ts";

function modelOption(values: string[], current = values[0] ?? ""): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current,
    options: values.map((value) => ({ value, name: value.toUpperCase() })),
  };
}

function effortOption(levels: string[]): SessionConfigOption {
  return {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "default",
    options: ["default", ...levels].map((value) => ({ value, name: value })),
  };
}

/** Config options of a session whose current model is opus. */
function opusSession(models: string[]): SessionConfigOption[] {
  return [modelOption(models, "opus"), effortOption(["low", "medium", "high", "xhigh", "max"])];
}

describe("toEffort", () => {
  const offered = ["low", "medium", "high", "max"];

  it("keeps a level the model offers", () => {
    expect(toEffort("high", offered)).toBe("high");
  });

  it("picks the closest offered level below the requested one", () => {
    expect(toEffort("xhigh", offered)).toBe("high");
  });

  it("C13: maps max to max", () => {
    expect(toEffort("max", offered)).toBe("max");
  });

  it("sends off and minimal to the lowest offered level", () => {
    expect(toEffort(undefined, offered)).toBe("low");
    expect(toEffort("minimal", offered)).toBe("low");
  });

  it("returns undefined when the model offers no effort", () => {
    expect(toEffort("high", [])).toBeUndefined();
  });
});

describe("toPiModels", () => {
  it("C16: uses placeholders for window, output limit and cost", () => {
    const [model] = toPiModels([{ id: "haiku", name: "Haiku", efforts: [] }], new Map());
    expect(model).toMatchObject({
      id: "haiku",
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
    });
    expect(model).not.toHaveProperty("promptCache");
  });

  it("marks reasoning only when the model offers effort and hides levels it does not offer", () => {
    const [model] = toPiModels([{ id: "opus", name: "Opus", efforts: ["low", "high"] }], new Map());
    expect(model).toMatchObject({ reasoning: true });
    expect(model && "thinkingLevelMap" in model && model.thinkingLevelMap).toEqual({
      off: "low",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("uses the context window reported by the adapter", () => {
    const [model] = toPiModels([{ id: "opus", name: "Opus", efforts: [] }], new Map([["opus", 1_000_000]]));
    expect(model).toMatchObject({ contextWindow: 1_000_000 });
  });
});

describe("Catalog", () => {
  function catalog() {
    const published: ProviderModelConfig[][] = [];
    return { published, catalog: new Catalog((models) => published.push(models)) };
  }
  const ids = (models: ProviderModelConfig[] | undefined) => models?.map((m) => m.id);
  const reasoning = (models: ProviderModelConfig[] | undefined, id: string) =>
    models?.find((m) => m.id === id) as { reasoning?: boolean } | undefined;

  it("C32: registers the provider again when a new session offers a different model list", () => {
    const { published, catalog: c } = catalog();
    c.observe(opusSession(["opus"]));
    c.observe(opusSession(["opus", "haiku"]));
    expect(published.map(ids)).toEqual([["opus"], ["opus", "haiku"]]);
  });

  it("does not register again when nothing changed", () => {
    const { published, catalog: c } = catalog();
    c.observe(opusSession(["opus", "haiku"]));
    c.observe(opusSession(["opus", "haiku"]));
    expect(published).toHaveLength(1);
  });

  it("gives unseen models the effort levels of the first observed model until they are used", () => {
    const { published, catalog: c } = catalog();
    c.observe(opusSession(["opus", "haiku"]));
    expect(reasoning(published.at(-1), "haiku")?.reasoning).toBe(true);
    c.observe([modelOption(["opus", "haiku"], "haiku")]);
    expect(reasoning(published.at(-1), "haiku")?.reasoning).toBe(false);
    expect(reasoning(published.at(-1), "opus")?.reasoning).toBe(true);
  });

  it("registers again when the adapter reports a new context window, once per change", () => {
    const { published, catalog: c } = catalog();
    c.observe(opusSession(["opus"]));
    c.setContextWindow("opus", 1_000_000);
    c.setContextWindow("opus", 1_000_000);
    expect(published).toHaveLength(2);
    expect(published[1]?.[0]).toMatchObject({ contextWindow: 1_000_000 });
  });
});

describe("C11: Catalog.load", () => {
  function probe(closed: string[], opened: string[] = []) {
    return async () => {
      opened.push("opened");
      return {
        configOptions: opusSession(["opus", "haiku"]),
        close: async () => {
          closed.push("closed");
        },
      };
    };
  }

  it("publishes the models of the probe session and closes it", async () => {
    const published: ProviderModelConfig[][] = [];
    const closed: string[] = [];
    const c = new Catalog((models) => published.push(models));
    await expect(c.load(probe(closed), 1000)).resolves.toBeUndefined();
    expect(published.at(-1)?.map((m) => m.id)).toEqual(["opus", "haiku"]);
    expect(closed).toEqual(["closed"]);
  });

  it("ensureLoaded probes only while the catalog is empty", async () => {
    const opened: string[] = [];
    const c = new Catalog(() => {});
    await expect(
      c.ensureLoaded(async () => Promise.reject(new Error("sin binario")), 1000),
    ).resolves.toContain("sin binario");
    await c.ensureLoaded(probe([], opened), 1000);
    await c.ensureLoaded(probe([], opened), 1000);
    expect(opened).toHaveLength(1);
  });

  it("shares one probe between concurrent loads", async () => {
    const opened: string[] = [];
    const c = new Catalog(() => {});
    await Promise.all([c.load(probe([], opened), 1000), c.load(probe([], opened), 1000)]);
    expect(opened).toHaveLength(1);
  });

  it("returns the error and keeps the catalog empty when the probe times out", async () => {
    const c = new Catalog(() => {});
    const error = await c.load(() => new Promise(() => {}), 10);
    expect(error).toContain("10");
    expect(c.models).toEqual([]);
  });

  it("returns the error when the probe session cannot open", async () => {
    const c = new Catalog(() => {});
    await expect(c.load(async () => Promise.reject(new Error("sin binario")), 1000)).resolves.toContain(
      "sin binario",
    );
  });
});
