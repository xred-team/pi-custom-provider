import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderService } from "../src/domain/service";
import { runOperation } from "../src/operations/runner";
import type { Caller, Interaction } from "../src/operations/types";
import { Authentication } from "../src/extension/adapters/authentication";
import { listModelPresets } from "../src/extension/adapters/discovery";

const values = (id = "fixture") => ({
  id,
  name: "Fixture",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:18080/v1",
  auth: { mode: "none" },
  models: [{ id: "m1", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
});
function fixture(options: any = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-service-"));
  let synced: any,
    active: any,
    busy = false,
    failSync = false;
  const runtime = {
    sync: async (c: any) => {
      if (failSync) throw new Error("internal secret");
      synced = c;
    },
    active: () => active,
    busy: () => busy,
  };
  const service = new ProviderService({
    directory,
    now: options.now,
    runtime,
    discovery: { catalogUrl: null, ...options.discovery },
    authentication: options.authFactory?.(directory),
  });
  const definitions = service.definitions();
  const events: Interaction[] = [];
  let answer: (request: Interaction) => Promise<string> = async () => {
    throw new Error("Unexpected prompt");
  };
  const run = (name: string, args: any, caller: Caller = "user_client", signal?: AbortSignal) =>
    runOperation(definitions, name, args, {
      caller,
      signal: signal ?? new AbortController().signal,
      prompt: (request) => answer(request),
      notify: (request) => events.push(request),
      progress: () => {},
    });
  return {
    directory,
    service,
    events,
    run,
    onPrompt: (handler: (request: Interaction) => Promise<string>) => {
      answer = handler;
    },
    get synced() {
      return synced;
    },
    setActive: (a: any) => {
      active = a;
    },
    failSync: () => {
      failSync = true;
    },
    dispose: async () => {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("create/update/rename/delete use revisions and preserve unrelated configuration", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.directory, "models.json"), JSON.stringify({ extra: { keep: 1 }, providers: {} }));
    let r = await f.run("provider.create", values());
    assert.equal(r.status, "succeeded");
    assert.equal(r.effects.config, "committed");
    assert.equal(f.synced.providers.fixture.models[0].id, "m1");
    assert.equal((await f.run("provider.create", values())).error?.code, "CONFLICT");
    const revision = r.data.revision;
    r = await f.run("provider.update", {
      providerId: "fixture",
      expectedRevision: revision,
      set: { id: "renamed", name: "Renamed" },
    });
    assert.equal(r.status, "succeeded");
    assert.equal(
      (await f.run("provider.update", { providerId: "renamed", expectedRevision: revision, set: { name: "stale" } }))
        .error?.code,
      "CONFLICT",
    );
    assert.equal((await f.run("provider.get", { providerId: "fixture" })).error?.code, "NOT_FOUND");
    f.setActive({ provider: "renamed", id: "m1" });
    assert.equal(
      (await f.run("provider.delete", { providerId: "renamed", expectedRevision: r.data.revision })).error?.code,
      "ACTIVE_MODEL_IN_USE",
    );
    f.setActive(undefined);
    assert.equal(
      (await f.run("provider.delete", { providerId: "renamed", expectedRevision: r.data.revision })).status,
      "succeeded",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "models.json"), "utf8")), {
      extra: { keep: 1 },
      providers: {},
    });
  } finally {
    await f.dispose();
  }
});
test("draft changes are explicit, versioned, discardable and preserve model fields", async () => {
  const f = fixture();
  try {
    await f.run("provider.create", values());
    const before = fs.readFileSync(path.join(f.directory, "models.json"), "utf8");
    let d = (await f.run("draft.open", { providerId: "fixture" })).data;
    const old = d.revision;
    d = (
      await f.run("draft.upsertModel", {
        draftId: d.draftId,
        revision: d.revision,
        model: {
          id: "m2",
          reasoning: true,
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            tiers: [{ inputTokensAbove: 100, input: 2, output: 3, cacheRead: 1, cacheWrite: 1 }],
          },
          compat: { supportsStore: false },
        },
      })
    ).data;
    assert.equal(
      (await f.run("draft.patch", { draftId: d.draftId, revision: old, set: { name: "stale" } })).error?.code,
      "STALE_REVISION",
    );
    assert.equal(fs.readFileSync(path.join(f.directory, "models.json"), "utf8"), before);
    d = (await f.run("draft.selectModels", { draftId: d.draftId, revision: d.revision, modelIds: ["m2"] })).data;
    const saved = await f.run("draft.commit", { draftId: d.draftId, revision: d.revision });
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.data.models[0].cost.tiers[0].inputTokensAbove, 100);
    const draft = (await f.run("draft.open", { providerId: "fixture" })).data;
    await f.run("draft.discard", { draftId: draft.draftId, revision: draft.revision });
    assert.equal((await f.run("draft.get", { draftId: draft.draftId })).error?.code, "NOT_FOUND");
  } finally {
    await f.dispose();
  }
});
test("validation does not silently replace values; broken config is never overwritten", async () => {
  const f = fixture();
  try {
    assert.equal((await f.run("provider.create", { ...values(), apiKey: "secret" })).error?.code, "VALIDATION_ERROR");
    assert.equal(
      (await f.run("provider.create", { ...values(), baseUrl: "https://x.test?token=SECRET" })).error?.code,
      "VALIDATION_ERROR",
    );
    assert.equal(
      (await f.run("provider.create", { ...values(), models: [{ id: "m", maxTokens: -1 }] })).error?.code,
      "VALIDATION_ERROR",
    );
    fs.writeFileSync(path.join(f.directory, "models.json"), "BROKEN");
    assert.equal((await f.run("provider.create", values())).error?.code, "CONFIG_READ_FAILED");
    assert.equal(fs.readFileSync(path.join(f.directory, "models.json"), "utf8"), "BROKEN");
  } finally {
    await f.dispose();
  }
});
test("credentials and header values are absent from every public projection, destination changes detach them", async () => {
  const f = fixture();
  try {
    let p = (await f.run("provider.create", { ...values(), auth: { mode: "api_key" } })).data;
    assert.equal(
      (await f.run("auth.configure", { providerId: p.id, expectedRevision: p.revision, value: "SENTINEL_KEY" })).status,
      "succeeded",
    );
    assert.equal(
      (
        await f.run("headers.set", {
          providerId: p.id,
          expectedRevision: p.revision,
          name: "X-Token",
          value: "SENTINEL_HEADER",
        })
      ).status,
      "succeeded",
    );
    p = (await f.run("provider.get", { providerId: p.id })).data;
    assert.equal(p.auth.status, "configured");
    assert.equal(p.headers[0].hasValue, true);
    assert(!JSON.stringify(f.events).includes("SENTINEL"));
    assert.equal(
      (await f.run("auth.configure", { providerId: p.id, expectedRevision: p.revision, value: "x" }, "model_tool"))
        .error?.code,
      "USER_ACTION_REQUIRED",
    );
    let r = await f.run("provider.update", { providerId: p.id, expectedRevision: p.revision, set: { id: "new-id" } });
    assert.equal(r.data.auth.status, "configured");
    p = r.data;
    r = await f.run("provider.update", {
      providerId: p.id,
      expectedRevision: p.revision,
      set: { baseUrl: "https://other.test/v1" },
    });
    assert.equal(r.data.auth.status, "missing");
    assert.deepEqual(r.data.headers, []);
  } finally {
    await f.dispose();
  }
});
test("discovery cancellation aborts HTTP and never updates a discarded or newer draft", async () => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let aborted = false;
  const f = fixture({
    discovery: {
      fetch: async (_url: any, init: any) =>
        new Promise((_r, reject) => {
          started();
          init.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(init.signal.reason);
            },
            { once: true },
          );
        }),
    },
  });
  try {
    const d = (await f.run("draft.create", values())).data;
    const controller = new AbortController();
    const task = f.run(
      "model.discover",
      { draftId: d.draftId, revision: d.revision },
      "user_client",
      controller.signal,
    );
    await ready;
    controller.abort();
    assert.equal((await task).status, "cancelled");
    assert(aborted);
    assert.equal((await f.run("draft.get", { draftId: d.draftId })).data.revision, d.revision);
    assert(!fs.existsSync(path.join(f.directory, "models.json")));
  } finally {
    await f.dispose();
  }
});
test("a sync failure after a committed write reports committed effects", async () => {
  const f = fixture();
  try {
    const r = await f.run("provider.create", values());
    f.failSync();
    const failed = await f.run("provider.update", {
      providerId: "fixture",
      expectedRevision: r.data.revision,
      set: { name: "Committed" },
    });
    assert.equal(failed.error?.code, "RUNTIME_SYNC_FAILED");
    assert.equal(failed.effects.config, "committed");
    assert.equal(failed.effects.runtime, "failed");
    assert(!JSON.stringify(failed).includes("internal secret"));
  } finally {
    await f.dispose();
  }
});
test("OAuth returns typed user actions, handles callback cancellation and stores no secrets in results", async () => {
  const f = fixture({
    authFactory: (directory: string) =>
      new Authentication(
        directory,
        () =>
          [
            {
              id: "openai-codex",
              name: "Fake",
              getModels: () => [],
              stream: () => undefined,
              streamSimple: () => undefined,
              auth: {
                oauth: {
                  name: "Fake",
                  login: async (interaction: any) => {
                    const method = await interaction.prompt({
                      type: "select",
                      message: "Method",
                      options: [{ id: "device", label: "Device" }],
                    });
                    assert.equal(method, "device");
                    interaction.notify({
                      type: "device_code",
                      verificationUri: "https://fixture.test",
                      userCode: "FAKE-CODE",
                    });
                    const value = await interaction.prompt({ type: "manual_code", message: "Code" });
                    assert.equal(value, "fixture-code");
                    return {
                      type: "oauth",
                      access: "SENTINEL_ACCESS",
                      refresh: "SENTINEL_REFRESH",
                      expires: Date.now() + 3600000,
                    };
                  },
                  refresh: async (c: any) => c,
                  toAuth: async (c: any) => ({ apiKey: c.access }),
                },
              },
            },
          ] as any,
      ),
  });
  try {
    const p = (
      await f.run("provider.create", {
        ...values(),
        api: "openai-codex-responses",
        auth: { mode: "oauth", methodId: "openai-codex" },
      })
    ).data;
    const answers = ["device", "fixture-code"];
    const asked: Interaction[] = [];
    f.onPrompt(async (request) => {
      asked.push(request);
      return answers.shift()!;
    });
    const result = await f.run("auth.begin", { providerId: p.id, expectedRevision: p.revision });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.equal(asked.length, 2);
    assert.equal(asked[0].kind, "select");
    assert.deepEqual(
      asked[0].options?.map((option) => option.id),
      ["device"],
    );
    assert(!JSON.stringify(f.events).includes("SENTINEL"));
    const stored = f.service.store.read().config.providers.fixture;
    assert.equal((await f.service.auth.resolve("fixture", stored)).auth.apiKey, "SENTINEL_ACCESS");
  } finally {
    await f.dispose();
  }
});

test("concurrent updates cannot overwrite another writer", async () => {
  const f = fixture();
  try {
    const p = (await f.run("provider.create", values())).data;
    const args = { providerId: p.id, expectedRevision: p.revision };
    const results = await Promise.all([
      f.run("provider.update", { ...args, set: { name: "A" } }),
      f.run("provider.update", { ...args, set: { name: "B" } }),
    ]);
    assert.equal(results.filter((r) => r.status === "succeeded").length, 1);
    assert.equal(results.filter((r) => r.error?.code === "CONFLICT").length, 1);
    assert.equal(
      (await f.run("provider.get", { providerId: p.id })).data.name,
      results.find((r) => r.status === "succeeded")!.data.name,
    );
  } finally {
    await f.dispose();
  }
});

test("clearing legacy credentials removes the fallback; model URL edits detach authorization", async () => {
  const f = fixture();
  try {
    let p = (await f.run("provider.create", { ...values(), auth: { mode: "api_key" } })).data;
    await f.run("auth.configure", { providerId: p.id, expectedRevision: p.revision, value: "SENTINEL_KEY" });
    let d = (await f.run("draft.open", { providerId: p.id })).data;
    d = (
      await f.run("draft.upsertModel", {
        draftId: d.draftId,
        revision: d.revision,
        model: { id: "m1", baseUrl: "https://new.test" },
      })
    ).data;
    p = (await f.run("draft.commit", { draftId: d.draftId, revision: d.revision })).data;
    assert.equal(p.auth.status, "missing");
    const file = path.join(f.directory, "models.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.providers.fixture.apiKey = "SENTINEL_OLD_KEY";
    fs.writeFileSync(file, JSON.stringify(raw));
    p = (await f.run("provider.get", { providerId: p.id })).data;
    assert.equal(p.auth.status, "configured");
    const cleared = await f.run("auth.clear", { providerId: p.id, expectedRevision: p.revision });
    assert.equal(cleared.status, "succeeded");
    assert.equal(cleared.data.status, "missing");
    assert.equal(cleared.effects.config, "committed");
    assert(!JSON.stringify(f.events).includes("SENTINEL"));
  } finally {
    await f.dispose();
  }
});

test("model presets prefer the provider that shares the endpoint", () => {
  const ranked = listModelPresets("openai-completions", "glm-5.3", {
    id: "zai-zhoujie",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  });
  assert.equal(ranked[0].providerId, "zai-coding-cn");
  assert(ranked[0].recommended);
  // Without the provider context the same model id sorts alphabetically instead.
  assert.notEqual(listModelPresets("openai-completions", "glm-5.3")[0].providerId, "zai-coding-cn");
});

test("Pi model presets satisfy the public model contract", async () => {
  const f = fixture();
  try {
    const catalog = (await f.run("catalog.list", {})).data;
    for (const api of catalog.apis) {
      let cursor: string | undefined;
      do {
        const result = await f.run("catalog.presets", {
          api: api.id,
          modelId: "gpt",
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        assert.equal(result.status, "succeeded", `${api.id}: ${JSON.stringify(result.error)}`);
        cursor = result.data.nextCursor;
      } while (cursor);
    }
  } finally {
    await f.dispose();
  }
});

test("applying a model preset enriches metadata while preserving the model ID", async () => {
  const f = fixture();
  try {
    await f.run("provider.create", { ...values(), models: [{ id: "gpt-4o", input: ["text"] }] });
    const draft = (await f.run("draft.open", { providerId: "fixture" })).data;
    const presets = (await f.run("catalog.presets", { api: "openai-completions", modelId: "gpt-4o", limit: 5 })).data;
    assert(presets.items.length > 0);
    const applied = (
      await f.run("draft.applyPreset", {
        draftId: draft.draftId,
        revision: draft.revision,
        modelId: "gpt-4o",
        presetId: presets.items[0].id,
      })
    ).data;
    const model = applied.values.models.find((m: any) => m.id === "gpt-4o");
    assert(model);
    assert.equal(model.id, "gpt-4o");
    assert(model.contextWindow > 0);
    assert(model.maxTokens > 0);
    assert(!applied.values.models.some((m: any) => m.id !== "gpt-4o"));
  } finally {
    await f.dispose();
  }
});

test("model recommendation enriches a manual model ID from the local catalog", async () => {
  const f = fixture();
  try {
    await f.run("provider.create", { ...values(), models: [] });
    const result = await f.run("model.recommend", { providerId: "fixture", modelId: "gpt-4o" });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.equal(result.data.model.id, "gpt-4o");
    assert.equal(result.data.source, "catalog");
    assert(result.data.model.contextWindow > 0);
  } finally {
    await f.dispose();
  }
});

test("creating a draft with an API key stores it for discovery and removes it on discard", async () => {
  const authHeaders: string[] = [];
  const f = fixture({
    discovery: {
      fetch: async (_url: string, options: any) => {
        authHeaders.push(options?.headers?.Authorization || "");
        return new Response(JSON.stringify({ data: [{ id: "m-from-api" }] }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  try {
    const draft = (
      await f.run("draft.create", {
        id: "keyed",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:18080/v1",
        auth: { mode: "api_key" },
        models: [],
        apiKey: "SENTINEL-KEY",
      })
    ).data;
    assert.equal(draft.values.auth.mode, "api_key");
    assert(!JSON.stringify(f.events).includes("SENTINEL-KEY"));
    assert(!JSON.stringify(draft).includes("SENTINEL-KEY"));
    const credentialFile = path.join(f.directory, "auth.json");
    assert(JSON.stringify(JSON.parse(fs.readFileSync(credentialFile, "utf8"))).includes("SENTINEL-KEY"));
    const discovered = await f.run("model.discover", { draftId: draft.draftId, revision: draft.revision });
    assert.equal(discovered.status, "succeeded", JSON.stringify(discovered.error));
    assert(authHeaders.includes("Bearer SENTINEL-KEY"));
    await f.run("draft.discard", { draftId: draft.draftId, revision: discovered.data.revision });
    assert(!fs.readFileSync(credentialFile, "utf8").includes("SENTINEL-KEY"));
  } finally {
    await f.dispose();
  }
});

test("creating a draft with OAuth JSON stores the credential and discard removes it", async () => {
  const f = fixture({
    authFactory: (directory: string) =>
      new Authentication(
        directory,
        () =>
          [
            {
              id: "openai-codex",
              name: "Fake",
              getModels: () => [],
              stream: () => undefined,
              streamSimple: () => undefined,
              auth: {
                oauth: {
                  name: "Fake",
                  login: async () => ({
                    type: "oauth",
                    access: "SENTINEL_ACCESS",
                    refresh: "SENTINEL_REFRESH",
                    expires: Date.now() + 3600000,
                  }),
                  refresh: async (c: any) => c,
                  toAuth: async (c: any) => ({ apiKey: c.access }),
                },
              },
            },
          ] as any,
      ),
  });
  try {
    const draft = (
      await f.run("draft.create", {
        id: "oauth-draft",
        api: "openai-codex-responses",
        baseUrl: "https://fixture.test",
        auth: { mode: "oauth", methodId: "openai-codex" },
        models: [],
        oauthJson: JSON.stringify({
          access: "SENTINEL_ACCESS",
          refresh: "SENTINEL_REFRESH",
          expires: Date.now() + 3600000,
        }),
      })
    ).data;
    assert(!JSON.stringify(draft).includes("SENTINEL_ACCESS"));
    const credentialFile = path.join(f.directory, "auth.json");
    assert(fs.readFileSync(credentialFile, "utf8").includes("SENTINEL_ACCESS"));
    await f.run("draft.discard", { draftId: draft.draftId, revision: draft.revision });
    assert(!fs.readFileSync(credentialFile, "utf8").includes("SENTINEL_ACCESS"));
  } finally {
    await f.dispose();
  }
});

test("draft.login completes OAuth before the provider is saved", async () => {
  const f = fixture({
    authFactory: (directory: string) =>
      new Authentication(
        directory,
        () =>
          [
            {
              id: "openai-codex",
              name: "Fake",
              getModels: () => [],
              stream: () => undefined,
              streamSimple: () => undefined,
              auth: {
                oauth: {
                  name: "Fake",
                  login: async (interaction: any) => {
                    await interaction.prompt({
                      type: "select",
                      message: "Method",
                      options: [{ id: "device", label: "Device" }],
                    });
                    return {
                      type: "oauth",
                      access: "SENTINEL_ACCESS",
                      refresh: "SENTINEL_REFRESH",
                      expires: Date.now() + 3600000,
                    };
                  },
                  refresh: async (c: any) => c,
                  toAuth: async (c: any) => ({ apiKey: c.access }),
                },
              },
            },
          ] as any,
      ),
  });
  try {
    const draft = (
      await f.run("draft.create", {
        id: "oauth-login",
        api: "openai-codex-responses",
        baseUrl: "https://fixture.test",
        auth: { mode: "oauth", methodId: "openai-codex" },
        models: [],
      })
    ).data;
    f.onPrompt(async () => "device");
    const result = await f.run("draft.login", { draftId: draft.draftId, revision: draft.revision });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert(!JSON.stringify(f.events).includes("SENTINEL_ACCESS"));
    assert(fs.readFileSync(path.join(f.directory, "auth.json"), "utf8").includes("SENTINEL_ACCESS"));
  } finally {
    await f.dispose();
  }
});

test("every operation exposes an object input schema so agent tools pass provider validation", async () => {
  const f = fixture();
  try {
    const definitions = f.service.definitions();
    assert(definitions.length > 0);
    for (const definition of definitions)
      assert.equal(
        (definition.inputSchema as any).type,
        "object",
        `${definition.name} must declare an object input schema`,
      );
    const discover = definitions.find((d) => d.name === "model.discover")!;
    assert.deepEqual(Object.keys((discover.inputSchema as any).properties ?? {}).sort(), [
      "draftId",
      "providerId",
      "revision",
    ]);
    const missing = await f.run("model.discover", {});
    assert.equal(missing.error?.code, "VALIDATION_ERROR");
    const incomplete = await f.run("model.discover", { draftId: "draft", revision: undefined });
    assert.equal(incomplete.error?.code, "VALIDATION_ERROR");
    const conflicting = await f.run("model.discover", { providerId: "fixture", draftId: "draft", revision: 1 });
    assert.equal(conflicting.error?.code, "VALIDATION_ERROR");
  } finally {
    await f.dispose();
  }
});

test("discovery cannot overwrite an edited draft and model callers cannot access user drafts", async () => {
  let release!: (response: Response) => void, started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const f = fixture({
    discovery: {
      fetch: async () => {
        started();
        return new Promise<Response>((r) => (release = r));
      },
    },
  });
  try {
    const draft = (await f.run("draft.create", values())).data;
    const rejected = await f.run("model.discover", { draftId: draft.draftId, revision: draft.revision }, "model_tool");
    assert.equal(rejected.status, "requires_user_action");
    const pending = f.run("model.discover", { draftId: draft.draftId, revision: draft.revision });
    await ready;
    const changed = (
      await f.run("draft.patch", { draftId: draft.draftId, revision: draft.revision, set: { name: "Changed" } })
    ).data;
    release(
      new Response(JSON.stringify({ data: [{ id: "late" }] }), { headers: { "content-type": "application/json" } }),
    );
    assert.equal((await pending).error?.code, "STALE_REVISION");
    const current = (await f.run("draft.get", { draftId: draft.draftId })).data;
    assert.equal(current.revision, changed.revision);
    assert(!current.candidates.some((c: any) => c.model.id === "late"));
  } finally {
    await f.dispose();
  }
});

test("reselecting a draft candidate cannot restore headers detached by an endpoint change", async () => {
  const f = fixture();
  try {
    let p = (await f.run("provider.create", values())).data;
    await f.run("headers.set", {
      providerId: p.id,
      expectedRevision: p.revision,
      modelId: "m1",
      name: "X-Secret",
      value: "SENTINEL_HEADER",
    });
    let d = (await f.run("draft.open", { providerId: p.id })).data;
    d = (await f.run("draft.selectModels", { draftId: d.draftId, revision: d.revision, modelIds: [] })).data;
    d = (await f.run("draft.patch", { draftId: d.draftId, revision: d.revision, set: { baseUrl: "https://new.test" } }))
      .data;
    assert.deepEqual(d.candidates, []);
    assert.equal(
      (await f.run("draft.selectModels", { draftId: d.draftId, revision: d.revision, modelIds: ["m1"] })).error?.code,
      "VALIDATION_ERROR",
    );
    d = (await f.run("draft.upsertModel", { draftId: d.draftId, revision: d.revision, model: { id: "m1" } })).data;
    const result = await f.run("draft.commit", { draftId: d.draftId, revision: d.revision });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.data.modelHeaders, []);
    assert(!fs.readFileSync(path.join(f.directory, "models.json"), "utf8").includes("SENTINEL"));
  } finally {
    await f.dispose();
  }
});

test("unset removes provider fields through both direct and draft updates", async () => {
  const f = fixture();
  try {
    let p = (await f.run("provider.create", { ...values(), compat: { supportsStore: false } })).data;
    p = (
      await f.run("provider.update", {
        providerId: p.id,
        expectedRevision: p.revision,
        set: {},
        unset: ["name", "compat"],
      })
    ).data;
    assert.equal(p.name, undefined);
    assert.equal(p.compat, undefined);
    p = (
      await f.run("provider.update", {
        providerId: p.id,
        expectedRevision: p.revision,
        set: { name: "Again", compat: { supportsStore: true } },
      })
    ).data;
    let d = (await f.run("draft.open", { providerId: p.id })).data;
    d = (await f.run("draft.patch", { draftId: d.draftId, revision: d.revision, set: {}, unset: ["name", "compat"] }))
      .data;
    assert.equal(d.values.name, undefined);
    assert.equal(d.values.compat, undefined);
    const saved = await f.run("draft.commit", { draftId: d.draftId, revision: d.revision });
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.data.name, undefined);
  } finally {
    await f.dispose();
  }
});

test("saving cannot consume a draft changed while persistence is waiting", async () => {
  const f = fixture();
  try {
    const d = (await f.run("draft.create", values())).data;
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    const commit = f.service.store.commit.bind(f.service.store);
    f.service.store.commit = async (...args) => {
      started();
      await gate;
      return commit(...args);
    };
    const saving = f.run("draft.commit", { draftId: d.draftId, revision: d.revision });
    await ready;
    const changed = (await f.run("draft.patch", { draftId: d.draftId, revision: d.revision, set: { id: "later-id" } }))
      .data;
    release();
    const result = await saving;
    assert.equal(result.error?.code, "STALE_REVISION");
    assert.equal(result.effects.config, "unchanged");
    assert.equal((await f.run("draft.get", { draftId: d.draftId })).data.revision, changed.revision);
    assert(!fs.existsSync(path.join(f.directory, "models.json")));
  } finally {
    await f.dispose();
  }
});

test("invalid discovery output cannot poison a draft or advance its revision", async () => {
  const f = fixture({
    discovery: { fetch: async () => new Response(JSON.stringify({ data: [{ id: "x".repeat(300) }] })) },
  });
  try {
    const d = (await f.run("draft.create", values())).data;
    assert.equal((await f.run("model.discover", { draftId: d.draftId, revision: d.revision })).status, "failed");
    const current = await f.run("draft.get", { draftId: d.draftId });
    assert.equal(current.status, "succeeded");
    assert.equal(current.data.revision, d.revision);
    assert.deepEqual(current.data.candidates, d.candidates);
  } finally {
    await f.dispose();
  }
});

test("all model edits update candidates consistently and direct writes do not consume draft capacity", async () => {
  const f = fixture();
  try {
    let d = (await f.run("draft.create", values())).data;
    d = (
      await f.run("draft.patch", { draftId: d.draftId, revision: d.revision, set: { models: [{ id: "new-model" }] } })
    ).data;
    d = (await f.run("draft.selectModels", { draftId: d.draftId, revision: d.revision, modelIds: [] })).data;
    const selected = await f.run("draft.selectModels", {
      draftId: d.draftId,
      revision: d.revision,
      modelIds: ["new-model"],
    });
    assert.equal(selected.status, "succeeded");
    for (let n = 1; n < 100; n++) assert.equal((await f.run("draft.create", values(`draft-${n}`))).status, "succeeded");
    assert.equal((await f.run("provider.create", values("direct"))).status, "succeeded");
  } finally {
    await f.dispose();
  }
});

test("expired draft slots are reclaimed before creation", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  try {
    for (let n = 0; n < 100; n++) await f.run("draft.create", values(`d-${n}`));
    now += 31 * 60_000;
    assert.equal((await f.run("draft.create", values("after-expiry"))).status, "succeeded");
  } finally {
    await f.dispose();
  }
});

test("OAuth completing after a configuration change cannot persist stale credentials", async () => {
  let entered!: () => void, finish!: (value: any) => void;
  const ready = new Promise<void>((r) => (entered = r));
  const f = fixture({
    authFactory: (directory: string) =>
      new Authentication(
        directory,
        () =>
          [
            {
              id: "openai-codex",
              auth: {
                oauth: {
                  login: async () => {
                    entered();
                    return new Promise((r) => (finish = r));
                  },
                  refresh: async (c: any) => c,
                  toAuth: async (c: any) => ({ apiKey: c.access }),
                },
              },
            },
          ] as any,
      ),
  });
  try {
    const p = (
      await f.run("provider.create", {
        ...values(),
        api: "openai-codex-responses",
        auth: { mode: "oauth", methodId: "openai-codex" },
      })
    ).data;
    const pending = f.run("auth.begin", { providerId: p.id, expectedRevision: p.revision });
    await ready;
    await f.run("provider.update", {
      providerId: p.id,
      expectedRevision: p.revision,
      set: { baseUrl: "https://changed.test" },
    });
    finish({ type: "oauth", access: "STALE_SENTINEL", refresh: "refresh", expires: Date.now() + 3600000 });
    const result = await pending;
    assert.equal(result.error?.code, "CONFLICT");
    assert.equal(result.effects.credentials, "unchanged");
    assert(!fs.existsSync(path.join(f.directory, "auth.json")));
  } finally {
    await f.dispose();
  }
});

test("credential writes refuse empty or malformed auth storage", async () => {
  const f = fixture();
  try {
    const p = (await f.run("provider.create", { ...values(), auth: { mode: "api_key" } })).data;
    const file = path.join(f.directory, "auth.json");
    for (const raw of ["", "[]", "null", "BROKEN"]) {
      fs.writeFileSync(file, raw);
      const result = await f.run("auth.configure", {
        providerId: p.id,
        expectedRevision: p.revision,
        value: "SENTINEL",
      });
      assert.equal(result.status, "failed");
      assert.equal(result.effects.credentials, "unchanged");
      assert.equal(fs.readFileSync(file, "utf8"), raw);
    }
  } finally {
    await f.dispose();
  }
});

test("invalid known compat fields identify the provider and field without exposing values", async () => {
  const f = fixture();
  try {
    const bad = { ...values(), models: [{ id: "fixture", compat: { supportsStore: "PRIVATE_SENTINEL" } }] };
    fs.writeFileSync(path.join(f.directory, "models.json"), JSON.stringify({ providers: { broken: bad } }));
    const before = fs.readFileSync(f.service.store.file, "utf8");
    const result = await f.run("provider.get", { providerId: "broken" });
    assert.equal(result.error?.code, "VALIDATION_ERROR");
    assert.match(result.error!.message, /\/providers\/broken\/models\/0\/compat\/supportsStore/);
    assert(!JSON.stringify(result).includes("PRIVATE_SENTINEL"));
    assert.equal(fs.readFileSync(f.service.store.file, "utf8"), before);
  } finally {
    await f.dispose();
  }
});

test("discovery accepts runtime-advertised Baseten metadata without dropping the batch", async () => {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const native = builtinProviders()
    .flatMap((provider) => provider.getModels())
    .filter((model) => (model.compat as any)?.thinkingFormat === "baseten");
  assert(native.length > 0, "The regression must exercise the runtime format missed by the old schema");
  const f = fixture({
    discovery: {
      fetch: async () =>
        new Response(JSON.stringify({ data: native.map((model) => ({ id: model.id })) }), { status: 200 }),
    },
  });
  try {
    await f.run("provider.create", values());
    const opened = await f.run("draft.open", { providerId: "fixture" });
    const d = opened.data;
    const result = await f.run("model.discover", { draftId: d.draftId, revision: d.revision });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert(result.data.candidates.some((candidate: any) => candidate.model.compat?.thinkingFormat === "baseten"));
    assert.deepEqual(result.data.selectedModelIds, ["m1"]);
  } finally {
    await f.dispose();
  }
});

test("OpenAI-compatible discovery preserves context and output limits from the model list", async () => {
  const f = fixture({
    discovery: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "deepseek-v4-flash",
                display_name: "DeepSeek V4 Flash",
                context_window: 1_000_000,
                context_length: 900_000,
                max_output_tokens: 32_000,
                reasoning: true,
                modalities: { input: ["text", "image"] },
              },
              {
                id: "codex-model",
                context_length: 872_000,
                max_completion_tokens: 16_000,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
  });
  try {
    await f.run("provider.create", values());
    const draft = (await f.run("draft.open", { providerId: "fixture" })).data;
    const discovered = await f.run("model.discover", {
      draftId: draft.draftId,
      revision: draft.revision,
    });
    assert.equal(discovered.status, "succeeded", JSON.stringify(discovered.error));
    const models: Array<Record<string, unknown>> = discovered.data.candidates.map(
      (candidate: { model: Record<string, unknown> }) => candidate.model,
    );
    const deepseek = models.find((model) => model.id === "deepseek-v4-flash");
    assert.ok(deepseek);
    assert.equal(deepseek.name, "DeepSeek V4 Flash");
    assert.equal(deepseek.contextWindow, 1_000_000);
    assert.equal(deepseek.maxTokens, 32_000);
    assert.equal(deepseek.reasoning, true);
    assert.deepEqual(deepseek.input, ["text", "image"]);
    const codex = models.find((model) => model.id === "codex-model");
    assert.ok(codex);
    assert.equal(codex.contextWindow, 872_000);
    assert.equal(codex.maxTokens, 16_000);
  } finally {
    await f.dispose();
  }
});

test("a provider Pi ships is listed once it is usable, and adjusting a model patches only it", async () => {
  const f = fixture();
  try {
    // Nothing is stored for Pi's own providers, so an unusable one stays out of the list.
    const before = await f.run("provider.list", {});
    assert(before.data.items.every((item: any) => item.source === "configured"));
    assert(!before.data.items.some((item: any) => item.id === "anthropic"));

    const view = await f.run("provider.get", { providerId: "anthropic" });
    assert.equal(view.data.source, "builtin");
    assert(view.data.models.length > 0, "Pi's own models are shown");
    assert(view.data.baseUrl);

    const target = view.data.models[0];
    const patched = await f.run("model.override", {
      providerId: "anthropic",
      modelId: target.id,
      expectedRevision: view.data.revision,
      set: { contextWindow: 123456, compat: { supportsTemperature: false } },
    });
    assert.equal(patched.status, "succeeded", JSON.stringify(patched.error));
    assert.deepEqual(patched.data.overriddenModelIds, [target.id]);
    // Without a bound runtime the patch is reported as stored; Pi's registry supplies the
    // effective value (see the adapter test below).
    assert.deepEqual(patched.data.modelOverrides[target.id], {
      contextWindow: 123456,
      compat: { supportsTemperature: false },
    });

    // The record holds the patch and nothing else, so Pi keeps its own endpoint and models.
    const record = JSON.parse(fs.readFileSync(path.join(f.directory, "models.json"), "utf8")).providers.anthropic;
    assert.deepEqual(Object.keys(record), ["modelOverrides"]);
    assert.equal(record.modelOverrides[target.id].contextWindow, 123456);
    assert(record.modelOverrides[target.id].baseUrl === undefined);

    // Other models of the same provider are untouched, and clearing the last patch removes the record.
    assert.equal(patched.data.models.length, view.data.models.length);
    const cleared = await f.run("model.override", {
      providerId: "anthropic",
      modelId: target.id,
      expectedRevision: patched.data.revision,
      unset: ["contextWindow", "compat"],
    });
    assert.equal(cleared.status, "succeeded", JSON.stringify(cleared.error));
    assert.deepEqual(cleared.data.overriddenModelIds, []);
    assert.deepEqual(cleared.data.modelOverrides, {});
    assert(
      JSON.parse(fs.readFileSync(path.join(f.directory, "models.json"), "utf8")).providers.anthropic === undefined,
    );
  } finally {
    await f.dispose();
  }
});

test("a model override refuses a provider or model Pi does not ship", async () => {
  const f = fixture();
  try {
    const revision = (await f.run("provider.list", {})).data.revision;
    assert.equal(
      (await f.run("model.override", { providerId: "nope", modelId: "x", expectedRevision: revision })).error?.code,
      "VALIDATION_ERROR",
    );
    const view = await f.run("provider.get", { providerId: "anthropic" });
    assert.equal(
      (
        await f.run("model.override", {
          providerId: "anthropic",
          modelId: "not-a-model",
          expectedRevision: view.data.revision,
        })
      ).error?.code,
      "NOT_FOUND",
    );
  } finally {
    await f.dispose();
  }
});

test("a built-in provider reports the models its runtime serves, patches included", async () => {
  const f = fixture();
  try {
    // The runtime is the source of truth for effective values: it already applied every layer.
    const effective = [{ id: "m", api: "anthropic-messages", contextWindow: 4242, name: "Patched" }];
    (f.service as any).options.runtime.modelsOf = () => effective;
    const view = await f.run("provider.get", { providerId: "anthropic" });
    assert.deepEqual(view.data.models, effective);
    assert.equal(view.data.source, "builtin");
  } finally {
    await f.dispose();
  }
});
