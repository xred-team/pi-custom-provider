import { AsyncLocalStorage } from "node:async_hooks";
import { OperationError, checkAbort } from "../../operations/errors";
// Model discovery — native API calls + models.dev catalog fallback
import type { DiscoveredModel, ProviderConfig } from "../../domain/types";
import { usesAuthHeader } from "../../domain/types";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, ModelCost, ThinkingLevelMap } from "@earendil-works/pi-ai";

const CATALOG_URL = "https://models.dev/api.json";
const TIMEOUT_MS = 15_000;
const CODEX_CLIENT_VERSION = "0.144.1";
const CODEX_ORIGINATOR = "codex_cli_rs";

// ─── External API response types ─────────────────────────────────

interface OpenAIModel {
  id: string;
  name?: string;
  display_name?: string;
  context_window?: number;
  context_length?: number;
  max_context_window?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input_modalities?: string[];
  modalities?: { input?: string[] };
}
interface OpenAIModelsResp {
  data?: OpenAIModel[];
}
interface CodexModelsResp {
  models?: Array<{
    slug?: string;
    id?: string;
    display_name?: string;
    name?: string;
    context_window?: number;
    context_length?: number;
    max_context_window?: number;
    max_completion_tokens?: number;
    max_tokens?: number;
    input_modalities?: string[];
  }>;
}
interface OllamaTagsResp {
  models?: Array<{ name: string; model: string }>;
}

interface AnthropicModelResp {
  id: string;
  display_name: string;
  max_input_tokens: number;
  max_tokens: number;
  capabilities?: {
    image_input?: { supported: boolean };
    thinking?: { supported: boolean };
    effort?: {
      supported: boolean;
      low?: { supported: boolean };
      medium?: { supported: boolean };
      high?: { supported: boolean };
      max?: { supported: boolean };
      xhigh?: { supported: boolean };
    };
  };
}
interface AnthropicModelsResp {
  data?: AnthropicModelResp[];
}

interface GeminiModelResp {
  name: string;
  baseModelId: string;
  displayName: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedGenerationMethods: string[];
  supportedActions?: string[];
  thinking?: boolean;
}
interface GeminiModelsResp {
  models?: GeminiModelResp[];
}

interface VertexModelResp {
  name: string;
  displayName: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}
interface VertexModelsResp {
  models?: VertexModelResp[];
}

// Raw response shape from https://models.dev/api.json. pi-ai's exported Model type is the normalized output shape.
interface ModelsDevProvider {
  id?: string;
  name?: string;
  models: Record<string, ModelsDevModel>;
}
interface ModelsDevModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: Array<{
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
      tier?: { type: string; size: number };
    }>;
  };
}

interface RecommendationModel extends DiscoveredModel {
  reasoning: boolean;
  input: Model<Api>["input"];
  contextWindow: number;
  maxTokens: number;
  catalogApi?: string;
}

interface RecommendationProvider {
  id: string;
  name: string;
  baseUrl?: string;
  priority: number;
  models: RecommendationModel[];
}

interface IndexedRecommendation {
  provider: RecommendationProvider;
  model: RecommendationModel;
}

interface RecommendationIndex {
  providers: RecommendationProvider[];
  exact: Map<string, IndexedRecommendation[]>;
  leaf: Map<string, IndexedRecommendation[]>;
}

export interface ModelPresetModel extends DiscoveredModel {
  reasoning: boolean;
  input: Model<Api>["input"];
  contextWindow: number;
  maxTokens: number;
}

export interface ModelPreset {
  key: string;
  label: string;
  providerId: string;
  modelId: string;
  model: ModelPresetModel;
  recommended: boolean;
}

// ─── Public API ──────────────────────────────────────────────────

export async function discoverModels(
  providerId: string,
  provider: ProviderConfig,
  apiKey?: string,
): Promise<DiscoveredModel[]> {
  const [nativeResult, catalog] = await Promise.all([
    discoverNative(providerId, provider, apiKey).then(
      (models) => ({ models }),
      (error: unknown) => ({ models: [] as DiscoveredModel[], error }),
    ),
    loadCatalog(),
  ]);
  const models = recommendModels(nativeResult.models, providerId, provider, catalog);
  checkAbort(discoveryContext.getStore()?.signal);
  if ("error" in nativeResult)
    discoveryContext.getStore()?.warnings.push({
      code: nativeResult.error instanceof OperationError ? nativeResult.error.code : "NETWORK_ERROR",
      message: "Could not fetch the server model list. Candidates may come only from the model catalog.",
    });
  if (models.length > 0) return models;
  if ("error" in nativeResult) throw nativeResult.error;
  return [];
}

export async function discoverCodexOAuthModels(
  providerId: string,
  provider: ProviderConfig,
  accessToken: string,
  accountId?: string,
): Promise<DiscoveredModel[]> {
  const [native, catalog] = await Promise.all([
    discoverCodexModels(provider.baseUrl, accessToken, accountId),
    loadCatalog(),
  ]);
  const models = recommendModels(native, providerId, provider, catalog).filter(
    (model) => model.suggestedBy !== "base-url",
  );
  if (models.length > 0) return models;
  throw new Error(`No models returned by "${providerId}" Codex API.`);
}

/** Look up metadata for a manually entered model id without contacting the provider's model endpoint. */
export async function recommendModel(
  modelId: string,
  providerId: string,
  provider: ProviderConfig,
): Promise<DiscoveredModel | undefined> {
  const localMatch = findRecommendation(buildRecommendationIndex({}), modelId, providerId, provider);
  if (localMatch) return recommendationCandidate(localMatch, provider.api, "model-id", modelId);
  const catalog = await loadCatalog();
  const match = findRecommendation(buildRecommendationIndex(catalog), modelId, providerId, provider);
  return match ? recommendationCandidate(match, provider.api, "model-id", modelId) : undefined;
}

// ─── Native discovery dispatch ───────────────────────────────────

async function discoverNative(
  providerId: string,
  { baseUrl, api }: ProviderConfig,
  apiKey?: string,
): Promise<DiscoveredModel[]> {
  const bp = baseUrl.replace(/\/$/, ""),
    key = apiKey || "";
  if (isOllama(providerId, baseUrl)) return discoverOllama(bp);
  if (usesAuthHeader(api)) return discoverOpenAI(bp, key);
  if (api === "anthropic-messages") return discoverAnthropic(bp, key);
  if (api === "google-generative-ai") return discoverGemini(bp, key);
  if (api === "google-vertex") return discoverVertex(bp, key);
  discoveryContext.getStore()?.warnings.push({
    code: "DISCOVERY_UNSUPPORTED",
    message: "Model discovery is not implemented for this API. Add models manually.",
  });
  return [];
}

// ─── OpenAI-compatible ───────────────────────────────────────────

async function discoverOpenAI(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const r = await get<OpenAIModelsResp>(`${baseUrl}/models`, bearer(apiKey));
  return (r?.data || [])
    .filter((model) => model.id?.trim())
    .map((model) => {
      const contextWindow = [
        model.context_window,
        model.context_length,
        model.max_context_window,
        model.max_input_tokens,
      ].find(isPositiveTokenLimit);
      const maxTokens = [model.max_output_tokens, model.max_completion_tokens, model.max_tokens].find(
        isPositiveTokenLimit,
      );
      return {
        id: model.id.trim(),
        name: model.display_name?.trim() || model.name?.trim() || model.id.trim(),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
        input: inputFilter(model.input_modalities || model.modalities?.input),
      };
    });
}

function isPositiveTokenLimit(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function discoverCodexModels(
  baseUrl: string,
  accessToken: string,
  accountId?: string,
): Promise<DiscoveredModel[]> {
  const endpoint = codexModelsEndpoint(baseUrl);
  const headers: Record<string, string> = {
    ...bearer(accessToken),
    Accept: "application/json",
    Originator: CODEX_ORIGINATOR,
    "User-Agent": `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`,
  };
  if (accountId?.trim()) headers["Chatgpt-Account-Id"] = accountId.trim();
  const r = await get<CodexModelsResp>(endpoint, headers);
  const models: DiscoveredModel[] = [];
  for (const model of r?.models || []) {
    const id = (model.slug || model.id || "").trim();
    if (!id) continue;
    models.push({
      id,
      name: model.display_name || model.name || id,
      contextWindow: model.context_window || model.context_length || model.max_context_window,
      maxTokens: model.max_completion_tokens || model.max_tokens,
      input: inputFilter(model.input_modalities),
      suggestedBy: "api",
    });
  }
  return models;
}

function codexModelsEndpoint(baseUrl: string): string {
  const root = baseUrl.replace(/\/$/, "");
  const prefix = root.endsWith("/codex") ? root : `${root}/codex`;
  return `${prefix}/models?client_version=${CODEX_CLIENT_VERSION}`;
}

// ─── Anthropic ───────────────────────────────────────────────────

async function discoverAnthropic(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const ep = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const r = await get<AnthropicModelsResp>(`${ep}/models?limit=1000`, {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  });
  return (r?.data || [])
    .filter((m) => m.id?.trim())
    .map((m) => {
      const input: Model<Api>["input"] = ["text"];
      if (m.capabilities?.image_input?.supported) input.push("image");
      const tlm = buildAnthropicThinking(m.capabilities?.effort);
      return {
        id: m.id.trim(),
        name: m.display_name || m.id.trim(),
        reasoning: !!(m.capabilities?.thinking?.supported || m.capabilities?.effort?.supported),
        thinkingLevelMap: Object.keys(tlm).length ? tlm : undefined,
        input,
        contextWindow: m.max_input_tokens || 200000,
        maxTokens: m.max_tokens || 64000,
      };
    });
}

function buildAnthropicThinking(effort?: {
  supported: boolean;
  low?: { supported: boolean };
  medium?: { supported: boolean };
  high?: { supported: boolean };
  max?: { supported: boolean };
  xhigh?: { supported: boolean };
}): ThinkingLevelMap {
  const m: ThinkingLevelMap = {};
  if (!effort?.supported) return m;
  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    m[level] = effort[level]?.supported ? level : null;
  }
  return m;
}

// ─── Google AI Studio ────────────────────────────────────────────

async function discoverGemini(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const ep = baseUrl.endsWith("/v1beta") ? baseUrl : `${baseUrl}/v1beta`;
  const r = await get<GeminiModelsResp>(`${ep}/models?pageSize=1000`, { "x-goog-api-key": apiKey });
  return (r?.models || [])
    .filter((m) => (m.supportedGenerationMethods || m.supportedActions || []).includes("generateContent"))
    .map((m) => ({
      id: (m.baseModelId || m.name).replace(/^models\//, ""),
      name: m.displayName || m.baseModelId || m.name,
      reasoning: !!m.thinking,
      input: inputFilter(["text", "image"]),
      contextWindow: m.inputTokenLimit || 128000,
      maxTokens: m.outputTokenLimit || 8192,
    }))
    .filter((m) => m.id);
}

// ─── Ollama ──────────────────────────────────────────────────────

async function discoverOllama(baseUrl: string): Promise<DiscoveredModel[]> {
  const r = await get<OllamaTagsResp>(`${baseUrl.replace(/\/v1\/?$/, "")}/api/tags`);
  return (r?.models || [])
    .filter((m) => (m.model || m.name)?.trim())
    .map((m) => ({ id: (m.model || m.name).trim(), name: (m.model || m.name).trim() }));
}

// ─── Google Vertex ───────────────────────────────────────────────

async function discoverVertex(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  if (!apiKey) return [];
  const ep = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const r = await get<VertexModelsResp>(`${ep}/publishers/google/models?pageSize=1000`, {
    Authorization: `Bearer ${apiKey}`,
  });
  return (r?.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => ({
      id: m.name.replace(/^publishers\/google\/models\//, ""),
      name: m.displayName || m.name,
      reasoning: !!m.thinking,
      input: inputFilter(["text", "image"]),
      contextWindow: m.inputTokenLimit || 128000,
      maxTokens: m.outputTokenLimit || 8192,
    }))
    .filter((m) => m.id);
}

// ─── Recommendations: model id first, then base URL ─────────────

async function loadCatalog(): Promise<Record<string, ModelsDevProvider>> {
  try {
    const options = discoveryContext.getStore();
    if (options?.catalogUrl === null) return {};
    return (await get<Record<string, ModelsDevProvider>>(options?.catalogUrl || CATALOG_URL)) || {};
  } catch {
    checkAbort(discoveryContext.getStore()?.signal);
    discoveryContext.getStore()?.warnings.push({
      code: "CATALOG_UNAVAILABLE",
      message: "The remote model catalog is unavailable. Using server results and the local Pi catalog.",
    });
    return {};
  }
}

let piRecommendations: RecommendationProvider[] | undefined;

function getPiRecommendations(): RecommendationProvider[] {
  return (piRecommendations ||= builtinProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    priority: 2,
    models: provider.getModels().map(fromPiModel),
  })));
}

/** A provider Pi (or the shared model catalog) already knows, with the endpoint it speaks to. */
export interface KnownProvider {
  id: string;
  name: string;
  baseUrl?: string;
  apis: string[];
  /** The methods Pi offers for this provider, so a screen offers only the ones that work. */
  auth: ("api_key" | "oauth")[];
}

/**
 * The endpoints Pi already knows, so a base URL never has to be recalled from memory.
 * These are Pi's own providers: the shared catalog carries neither endpoints nor API tags.
 */
export function knownProviders(): KnownProvider[] {
  return getPiRecommendations()
    .map((provider) => {
      const builtin = builtinProviders().find((entry) => entry.id === provider.id);
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apis: [
          ...new Set(provider.models.map((model) => model.catalogApi).filter((api): api is string => !!api)),
        ].sort(),
        auth: [
          ...(builtin?.auth?.apiKey ? (["api_key"] as const) : []),
          ...(builtin?.auth?.oauth ? (["oauth"] as const) : []),
        ] as ("api_key" | "oauth")[],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Provider context used to prefer presets from the same endpoint or identity. */
export interface PresetProviderContext {
  id?: string;
  name?: string;
  baseUrl?: string;
}

/** List complete pi-ai model configurations for explicit manual selection. */
export function listModelPresets(
  api: ProviderConfig["api"],
  modelId: string,
  provider?: PresetProviderContext,
  filter = "",
): ModelPreset[] {
  const query = filter.trim().toLowerCase();
  return (
    getPiRecommendations()
      .flatMap((candidate) =>
        candidate.models
          .filter((model) => model.catalogApi === api)
          .map((model) => {
            const match = modelPresetScore(modelId, model.id);
            const affinity = provider ? providerAffinity(provider, candidate) : 0;
            const { catalogApi: _catalogApi, ...presetModel } = model;
            return {
              key: `${candidate.id}/${model.id}`,
              label: `${candidate.id} / ${model.id}`,
              providerId: candidate.id,
              modelId: model.id,
              model: {
                ...presetModel,
                input: [...presetModel.input],
                cost: cloneModelCost(presetModel.cost),
                thinkingLevelMap: presetModel.thinkingLevelMap ? { ...presetModel.thinkingLevelMap } : undefined,
                compat: presetModel.compat ? { ...presetModel.compat } : undefined,
              },
              recommended: match >= 700,
              match,
              affinity,
            };
          }),
      )
      .filter((preset) => !query || preset.label.toLowerCase().includes(query))
      // Same model id first, then the provider that shares the endpoint, id or name.
      .sort((a, b) => b.match - a.match || b.affinity - a.affinity || a.label.localeCompare(b.label))
      .map(({ match: _match, affinity: _affinity, ...preset }) => preset)
  );
}

/** Mirror of the catalog build rule: endpoint 16, origin 8, provider id 4, provider name 2. */
function providerAffinity(source: PresetProviderContext, candidate: RecommendationProvider): number {
  let score = 0;
  const sourceEndpoint = canonicalEndpoint(source.baseUrl);
  const candidateEndpoint = canonicalEndpoint(candidate.baseUrl);
  if (sourceEndpoint && sourceEndpoint === candidateEndpoint) score += 16;
  const sourceOrigin = canonicalOrigin(source.baseUrl);
  if (sourceOrigin && sourceOrigin === canonicalOrigin(candidate.baseUrl)) score += 8;
  if (source.id && norm(source.id) === norm(candidate.id)) score += 4;
  if (source.name && norm(source.name) === norm(candidate.id)) score += 2;
  return score;
}

function canonicalEndpoint(raw?: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw.trim());
    if (!url.protocol || !url.host) return "";
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return "";
  }
}

function canonicalOrigin(raw?: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw.trim());
    if (!url.protocol || !url.host) return "";
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return "";
  }
}

function modelPresetScore(actual: string, preset: string): number {
  const left = normalizedModelId(actual),
    right = normalizedModelId(preset);
  if (left === right) return 1000;
  if (modelLeaf(left) === modelLeaf(right)) return 900;
  const compactLeft = norm(left),
    compactRight = norm(right);
  if (compactRight.length >= 6 && compactLeft.endsWith(compactRight)) return 800;
  if (compactRight.length >= 6 && compactLeft.includes(compactRight)) return 700;
  return 0;
}

function cloneModelCost(cost: ModelCost | undefined): ModelCost | undefined {
  return cost
    ? {
        ...cost,
        tiers: cost.tiers?.map((entry) => ({ ...entry })),
      }
    : undefined;
}

/** Build selectable candidates. Native ids are enriched first; URL matches only add suggestions. */
export function recommendModels(
  native: DiscoveredModel[],
  providerId: string,
  provider: ProviderConfig,
  catalog: Record<string, ModelsDevProvider> = {},
): DiscoveredModel[] {
  const index = buildRecommendationIndex(catalog);
  const result = native.map((model) => {
    const match = findRecommendation(index, model.id, providerId, provider);
    if (match) return mergeNative(model, recommendationCandidate(match, provider.api, "model-id", model.id));
    return { ...model, suggestedBy: "api" as const };
  });

  // Base URL is a secondary recommendation source. These models are not
  // enabled automatically; the native UI presents them in the same pick list.
  const seen = new Set(result.map((model) => normalizedModelId(model.id)));
  const urlMatches = index.providers
    .map((entry) => ({ entry, score: recommendationProviderScore(provider.baseUrl, entry) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.priority - a.entry.priority)
    .map((x) => x.entry);
  for (const entry of urlMatches) {
    for (const model of entry.models) {
      if (model.catalogApi && model.catalogApi !== provider.api) continue;
      appendCandidate(result, recommendationCandidate({ provider: entry, model }, provider.api, "base-url"), seen);
    }
  }
  return result;
}

function buildRecommendationIndex(catalog: Record<string, ModelsDevProvider>): RecommendationIndex {
  const providers = [...getPiRecommendations(), ...fromRemoteCatalog(catalog)];
  const exact = new Map<string, IndexedRecommendation[]>(),
    leaf = new Map<string, IndexedRecommendation[]>();
  for (const provider of providers) {
    for (const model of provider.models) {
      addToIndex(exact, normalizedModelId(model.id), { provider, model });
      addToIndex(leaf, modelLeaf(model.id), { provider, model });
    }
  }
  return { providers, exact, leaf };
}

function addToIndex(index: Map<string, IndexedRecommendation[]>, key: string, value: IndexedRecommendation): void {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}

function fromRemoteCatalog(catalog: Record<string, ModelsDevProvider>): RecommendationProvider[] {
  return Object.entries(catalog).map(([key, provider]) => ({
    id: provider.id || key,
    name: provider.name || provider.id || key,
    priority: 1,
    models: Object.entries(provider.models || {}).map(([modelKey, model]) => fromCatalogModel(modelKey, model)),
  }));
}

function findRecommendation(
  index: RecommendationIndex,
  modelId: string,
  providerId: string,
  provider: ProviderConfig,
): IndexedRecommendation | undefined {
  const exact = index.exact.get(normalizedModelId(modelId)) || [];
  const leafFallback = exact.length === 0;
  let pool = exact.length ? exact : index.leaf.get(modelLeaf(modelId)) || [];
  const compatible = pool.filter(({ model }) => !model.catalogApi || model.catalogApi === provider.api);
  if (compatible.length) pool = compatible;
  if (!pool.length) return;

  const ranked = [...pool].sort(
    (a, b) =>
      recommendationProviderScore(provider.baseUrl, b.provider) -
        recommendationProviderScore(provider.baseUrl, a.provider) ||
      providerIdentityScore(providerId, b.provider) - providerIdentityScore(providerId, a.provider) ||
      b.provider.priority - a.provider.priority,
  );
  if (leafFallback) {
    const distinctIds = new Set(pool.map(({ model }) => normalizedModelId(model.id)));
    const best = ranked[0];
    if (
      distinctIds.size > 1 &&
      recommendationProviderScore(provider.baseUrl, best.provider) === 0 &&
      providerIdentityScore(providerId, best.provider) === 0
    )
      return;
  }
  return ranked[0];
}

function providerIdentityScore(providerId: string, provider: RecommendationProvider): number {
  const wanted = norm(providerId);
  return [provider.id, provider.name].some((value) => norm(value) === wanted) ? 1 : 0;
}

function recommendationProviderScore(baseUrl: string, provider: RecommendationProvider): number {
  const declaredUrlScore = provider.baseUrl ? baseUrlScore(baseUrl, provider.baseUrl) : 0;
  if (declaredUrlScore) return 1000 + declaredUrlScore;
  return Math.max(baseUrlIdentityScore(baseUrl, provider.id), baseUrlIdentityScore(baseUrl, provider.name));
}

function fromPiModel(model: Model<Api>): RecommendationModel {
  return {
    id: model.id,
    name: model.name || model.id,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost as ModelCost,
    thinkingLevelMap: model.thinkingLevelMap,
    compat: model.compat as Record<string, unknown> | undefined,
    catalogApi: model.api,
  };
}

function fromCatalogModel(key: string, model: ModelsDevModel): RecommendationModel {
  const id = (model.id || key).trim();
  return {
    id,
    name: model.name || id,
    reasoning: !!model.reasoning,
    input: inputFilter(model.modalities?.input),
    contextWindow: model.limit?.context || 128000,
    maxTokens: model.limit?.output || 16384,
    cost: toModelCost(model.cost),
  };
}

function recommendationCandidate(
  recommendation: IndexedRecommendation,
  api: ProviderConfig["api"],
  suggestedBy: DiscoveredModel["suggestedBy"],
  id = recommendation.model.id,
): DiscoveredModel {
  const { catalogApi, ...model } = recommendation.model;
  return {
    ...model,
    id,
    compat: !catalogApi || catalogApi === api ? model.compat : undefined,
    suggestedBy,
  };
}

function mergeNative(native: DiscoveredModel, suggested: DiscoveredModel): DiscoveredModel {
  return {
    ...suggested,
    id: native.id,
    name: native.name !== native.id ? native.name : suggested.name,
    reasoning: native.reasoning ?? suggested.reasoning,
    input: native.input ?? suggested.input,
    contextWindow: native.contextWindow ?? suggested.contextWindow,
    maxTokens: native.maxTokens ?? suggested.maxTokens,
    cost: native.cost ?? suggested.cost,
    thinkingLevelMap: native.thinkingLevelMap ?? suggested.thinkingLevelMap,
    compat: native.compat ?? suggested.compat,
    suggestedBy: "model-id",
  };
}

function appendCandidate(models: DiscoveredModel[], candidate: DiscoveredModel, seen: Set<string>): void {
  const id = normalizedModelId(candidate.id);
  if (!seen.has(id)) {
    seen.add(id);
    models.push(candidate);
  }
}

function bearer(key: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function isOllama(name: string, baseUrl: string): boolean {
  return (
    norm(name) === "ollama" ||
    (() => {
      try {
        return new URL(baseUrl).port === "11434";
      } catch {
        return false;
      }
    })()
  );
}

function norm(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}
function normalizedModelId(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
}
function modelLeaf(v: string): string {
  return normalizedModelId(v).split("/").at(-1) || "";
}
function normalizedUrl(v: string): string {
  try {
    const u = new URL(v);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return v.trim().replace(/\/+$/, "").toLowerCase();
  }
}
function baseUrlScore(actual: string, suggested: string): number {
  if (!actual || !suggested) return 0;
  const a = normalizedUrl(actual),
    b = normalizedUrl(suggested);
  if (a === b) return 100;
  if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return 90;
  try {
    return new URL(a).host === new URL(b).host ? 80 : 0;
  } catch {
    return 0;
  }
}
function baseUrlIdentityScore(baseUrl: string, identity: string): number {
  const candidate = norm(identity);
  return candidate.length >= 3 && norm(baseUrl).includes(candidate) ? candidate.length : 0;
}
function inputFilter(input?: string[]): Model<Api>["input"] {
  const r = (input || []).filter((v) => v === "text" || v === "image");
  return r.length ? [...new Set(r)] : ["text"];
}

export function toModelCost(c?: ModelsDevModel["cost"]): ModelCost | undefined {
  if (!c) return;
  const value = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
  const cost: ModelCost = {
    input: value(c.input),
    output: value(c.output),
    cacheRead: value(c.cache_read),
    cacheWrite: value(c.cache_write),
  };
  const tiers = c.tiers
    ?.filter((t) => t.tier?.type === "context" && Number.isFinite(t.tier.size))
    .map((t) => ({
      inputTokensAbove: t.tier!.size,
      input: value(t.input),
      output: value(t.output),
      cacheRead: value(t.cache_read),
      cacheWrite: value(t.cache_write),
    }));
  if (tiers?.length) cost.tiers = tiers;
  return cost;
}

// ─── Fetch ───────────────────────────────────────────────────────

async function get<T>(url: string, headers?: Record<string, string>): Promise<T | undefined> {
  const r = await fetchTimeout(url, headers ? { headers } : undefined);
  if (!r.ok)
    throw new OperationError(
      r.status === 401 || r.status === 403 ? "AUTH_FAILED" : "NETWORK_ERROR",
      `The model service returned HTTP ${r.status}.`,
      undefined,
      r.status === 429 || r.status >= 500,
    );
  return r.json() as T;
}

async function fetchTimeout(url: string, init?: RequestInit, ms = TIMEOUT_MS): Promise<Response> {
  const options = discoveryContext.getStore();
  const timeout = AbortSignal.timeout(options?.timeoutMs || ms);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const isCatalog = url === (options?.catalogUrl || CATALOG_URL);
  try {
    return await (options?.fetch || fetch)(url, {
      ...init,
      headers: { ...init?.headers, ...(!isCatalog ? options?.headers : {}) },
      signal,
      redirect: "error",
    });
  } catch {
    checkAbort(options?.signal);
    if (timeout.aborted) throw new OperationError("TIMEOUT", "Model discovery timed out.", undefined, true);
    throw new OperationError("NETWORK_ERROR", "Could not reach the model service.", undefined, true);
  }
}

export interface DiscoveryOptions {
  signal?: AbortSignal;
  catalogUrl?: string | null;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
const discoveryContext = new AsyncLocalStorage<DiscoveryOptions & { warnings: { code: string; message: string }[] }>();
export async function discover(
  providerId: string,
  provider: ProviderConfig,
  auth: { apiKey?: string; accountId?: string } = {},
  options: DiscoveryOptions = {},
) {
  const warnings: { code: string; message: string }[] = [];
  return discoveryContext.run({ ...options, warnings }, async () => {
    checkAbort(options.signal);
    const models =
      provider.oauthProvider === "openai-codex" && auth.apiKey
        ? await discoverCodexOAuthModels(providerId, provider, auth.apiKey, auth.accountId)
        : await discoverModels(providerId, provider, auth.apiKey);
    checkAbort(options.signal);
    return { models, warnings };
  });
}
export async function recommend(
  modelId: string,
  providerId: string,
  provider: ProviderConfig,
  options: DiscoveryOptions = {},
) {
  return discoveryContext.run({ ...options, warnings: [] }, async () => {
    const result = await recommendModel(modelId, providerId, provider);
    checkAbort(options.signal);
    return result;
  });
}
