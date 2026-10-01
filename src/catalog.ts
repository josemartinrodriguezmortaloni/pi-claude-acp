import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { errorText } from "./connection.ts";
import { copy } from "./messages.ts";

export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "effort";
/** The adapter's "use the model default" effort value. The extension always sends a concrete level. */
const DEFAULT_EFFORT = "default";
/** Pi's documented default; replaced by `usage_update.size` after the first turn. */
const PLACEHOLDER_CONTEXT_WINDOW = 128000;
const PLACEHOLDER_MAX_TOKENS = 16384;
const PI_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelEntry {
  id: string;
  name: string;
  efforts: string[];
}

/** A disposable session used only to read the catalog. */
export interface ProbeSession {
  configOptions: SessionConfigOption[];
  close(): Promise<void>;
}

export function modelOptions(configOptions: SessionConfigOption[]): SessionConfigSelectOption[] {
  return selectValues(configOptions.find((option) => option.id === MODEL_CONFIG_ID));
}

export function offeredEfforts(configOptions: SessionConfigOption[]): string[] {
  return selectValues(configOptions.find((option) => option.id === EFFORT_CONFIG_ID))
    .map((option) => option.value)
    .filter((value) => value !== DEFAULT_EFFORT);
}

function selectValues(option: SessionConfigOption | undefined): SessionConfigSelectOption[] {
  if (option?.type !== "select") return [];
  return option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
}

export function configValue(configOptions: SessionConfigOption[], configId: string): unknown {
  return configOptions.find((option) => option.id === configId)?.currentValue;
}

function currentModel(configOptions: SessionConfigOption[]): string | undefined {
  const value = configValue(configOptions, MODEL_CONFIG_ID);
  return typeof value === "string" ? value : undefined;
}

/** The effort level to set for `level`, or undefined when the session already uses it or offers none. */
export function effortChange(configOptions: SessionConfigOption[], level: ThinkingLevel | undefined) {
  const effort = toEffort(level, offeredEfforts(configOptions));
  return effort !== configValue(configOptions, EFFORT_CONFIG_ID) ? effort : undefined;
}

const rank = (level: string) => PI_LEVELS.indexOf(level as ThinkingLevel);

/** Closest offered level at or below `level`; off (undefined) and minimal go to the lowest offered level. */
export function toEffort(level: ThinkingLevel | undefined, offered: string[]): string | undefined {
  const known = offered.filter((value) => rank(value) >= 0).sort((a, b) => rank(a) - rank(b));
  const target = rank(level ?? "minimal");
  return known.filter((value) => rank(value) <= target).at(-1) ?? known[0];
}

function thinkingLevelMap(efforts: string[]): ThinkingLevelMap {
  const levels = PI_LEVELS.map((level) => [level, efforts.includes(level) ? level : null]);
  return { off: toEffort(undefined, efforts) ?? null, ...Object.fromEntries(levels) };
}

export function toPiModels(
  entries: ModelEntry[],
  contextWindows: Map<string, number>,
): ProviderModelConfig[] {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: entry.efforts.length > 0,
    ...(entry.efforts.length > 0 && { thinkingLevelMap: thinkingLevelMap(entry.efforts) }),
    contextWindow: contextWindows.get(entry.id) ?? PLACEHOLDER_CONTEXT_WINDOW,
    maxTokens: PLACEHOLDER_MAX_TOKENS,
  }));
}

/**
 * The models the adapter offers, published to Pi whenever they change.
 * Effort levels depend on the model and the adapter reports them only for the current model of a session,
 * so the catalog learns them from every config response. Switching a session through every model to read
 * them costs 0.3-5 s per model. A model not used yet shows the levels of the first model observed.
 */
export class Catalog {
  #models: SessionConfigSelectOption[] = [];
  readonly #efforts = new Map<string, string[]>();
  #fallback: string[] | undefined;
  readonly #contextWindows = new Map<string, number>();
  #published = "";
  #loading: Promise<string | undefined> | undefined;

  constructor(private readonly publish: (models: ProviderModelConfig[]) => void) {}

  get models(): ProviderModelConfig[] {
    return toPiModels(this.#entries(), this.#contextWindows);
  }

  /** Learns the model list and the effort levels of the current model from a config response. */
  observe(configOptions: SessionConfigOption[]): void {
    const models = modelOptions(configOptions);
    if (models.length > 0) this.#models = models;
    this.#learn(currentModel(configOptions), offeredEfforts(configOptions));
    this.#publishIfChanged();
  }

  setContextWindow(modelId: string, size: number): void {
    if (size <= 0) return;
    this.#contextWindows.set(modelId, size);
    this.#publishIfChanged();
  }

  /** Reads the catalog from a probe session. Returns the error text when it fails or exceeds `timeoutMs`. */
  load(open: () => Promise<ProbeSession>, timeoutMs: number): Promise<string | undefined> {
    this.#loading ??= this.#load(open, timeoutMs).finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  /** Retries the load while the catalog is empty, so a failed startup recovers on the next use. */
  async ensureLoaded(open: () => Promise<ProbeSession>, timeoutMs: number): Promise<string | undefined> {
    return this.#models.length > 0 ? undefined : this.load(open, timeoutMs);
  }

  async #load(open: () => Promise<ProbeSession>, timeoutMs: number): Promise<string | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(copy.noResponseWithin(timeoutMs))), timeoutMs);
    });
    try {
      await Promise.race([this.#probe(open), timeout]);
      return undefined;
    } catch (error) {
      return copy.catalogFailed(errorText(error));
    } finally {
      clearTimeout(timer);
    }
  }

  async #probe(open: () => Promise<ProbeSession>): Promise<void> {
    const probe = await open();
    try {
      this.observe(probe.configOptions);
    } finally {
      await probe.close();
    }
  }

  #learn(modelId: string | undefined, efforts: string[]): void {
    if (!modelId) return;
    this.#efforts.set(modelId, efforts);
    this.#fallback ??= efforts;
  }

  #entries(): ModelEntry[] {
    return this.#models.map((option) => ({
      id: option.value,
      name: option.name,
      efforts: this.#efforts.get(option.value) ?? this.#fallback ?? [],
    }));
  }

  #publishIfChanged(): void {
    const models = this.models;
    const key = JSON.stringify(models);
    if (key === this.#published) return;
    this.#published = key;
    this.publish(models);
  }
}
