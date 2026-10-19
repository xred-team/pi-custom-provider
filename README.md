# pi-custom-provider

English · [中文](README.zh-CN.md)

Manage custom providers, models, and credentials in **Pi 0.85.1** through a shared service with native terminal controls, programmatic RPC, and confirmed agent tools.

## Native terminal

```bash
pnpm install --frozen-lockfile
pnpm exec pi -e ./src/index.ts
```

Run `/model-config`. The English interface uses Pi's native dialogs, `SelectList`, `Input`, `SettingsList`, `Container`, `Text`, `DynamicBorder` and editors. Pi owns rendering, list navigation, search, prompts and screen transitions; the extension only connects operations and switches focus between sections.

Opening `/model-config` shows a sectioned provider list: an Actions block (`Create provider`) and a Providers block. Nothing is folded or hidden. Opening a provider lists everything the same way: one Provider block with the editable fields plus authentication, credentials, request headers and delete, then Models with `Add model` as the first row. Model IDs distinguish matching display names. Up/Down moves continuously across sections without switching modes. Typing searches every section; Enter edits a field or opens the selected model or action. The filter never persists across an action — the cursor returns to the row you acted on — so the whole list stays reachable. Actions that only change the draft (toggles, enum cycles, thinking levels, compat values) run in place and rebuild the list without unmounting the panel, so they never flash the page; a row that opens a Pi dialog or another panel declares that, and only those hand the editor area over first. Esc closes any screen and returns to the one below it, so no screen carries a redundant Back or Close row. Opening a model groups its fields under Actions, Model, Pricing, Thinking level mapping and Compat headings; every value shows its effective value (not "Default"), booleans and input types toggle in place, and every field with a known set of values (thinking levels, `thinkingFormat`, the API type, authentication) opens a select list rendered inside the panel: the values are listed with the current one marked, and the page is never torn down. Values show the human name while the id is what gets saved. Compat lists only the keys that model configures, with `Add compat field` and `Remove compat field` to add or delete one. `Create provider` asks for the API type first, then lists the endpoints Pi already knows for that API — `Enter a base URL myself` keeps the manual path. Picking a known endpoint does not create anything: that provider exists, so the flow asks for its credential and then opens its page. `Add model` performs discovery and shows Actions and Models blocks; choosing a model opens its own menu with `Add to provider`/`Remove from provider`, `Edit model config` and `Apply model preset`, so a model is configured and preset before you leave the screen. Creating a provider collects the API key or OAuth credentials up front and discovers models immediately. Every change is saved automatically: there is no Save or Discard step. `Enter model manually` opens the complete model form (ID, name, API, context, output limits and other metadata); cancelling leaves no partial model.

Provider fields, discovery, model selection, credentials, and deletion are direct actions in the provider window. API keys and OAuth credentials are entered while creating the provider, so discovery works before the first save; request headers are configured after saving. Validation failures appear as error notifications.

OpenAI-compatible model discovery preserves server-reported context windows, output limits, reasoning support, and input modalities when the `/models` response includes them.

The interface supports provider renaming, model selection with native search and scrolling, full model metadata including cost tiers, optional-field removal, compatibility settings, and write-only provider/model headers. Changes immediately synchronize with Pi. Switch the active model before renaming or deleting its provider or removing that model.

Pi's native credential input is visible; the interface tells you this and never prefills stored secrets. OAuth supports Pi authentication flows, JSON import, and explicit server-side file references. File-backed refresh updates the selected file. Logging in again, importing, or clearing credentials detaches an old file reference. Changing an endpoint, API, or authentication method detaches previous credentials and headers.

## Providers Pi already ships

A provider you logged into with Pi's own `/login` is not in `models.json`, so `/model-config` lists it
directly and tags it `Pi built-in` (`openai-codex (OpenAI Codex, Pi built-in)`), with an `n adjusted`
tag once you changed any of its models. Choose it, then pick a model. Editing such a model writes a **`modelOverrides` patch** — Pi's
topmost configuration layer — so only the fields you change are replaced and Pi keeps its own endpoint,
API, authentication and model list. A `(adjusted)` marker shows which models you changed, and
`Reset all adjustments` removes every patch for that provider. The endpoint, API and model list of a
provider Pi ships are read-only here, because Pi owns them. Its **credentials are editable**: `Sign in`
runs Pi's own OAuth flow, `Set API key` stores a key, `Import OAuth JSON` accepts an exported credential
and `Clear credentials` removes it. All of them write to Pi's `auth.json` under the provider id — the same
slot `/login` uses — and never add a record to `models.json`. Adding a brand-new provider still writes a
plain `models[]` entry, which is safe because no built-in model is being replaced.

## Programmatic access

Programmatic access is Pi's own RPC mode. This package adds no transport of its own: it registers the `model-config` command, so a plain Pi RPC process already exposes it.

```bash
pi --mode rpc -e ./src/index.ts
```

Discover the command and the operation catalog:

```json
{"id":"c1","type":"get_commands"}
{"id":"c2","type":"prompt","message":"/model-config help"}
{"id":"c3","type":"get_entries"}
```

`get_commands` lists `model-config`; `help` appends a session entry of type `provider-manager/result` whose `data.operations` carries every operation with its `inputSchema` and `resultSchema`.

Run one operation:

```json
{"id":"i1","type":"prompt","message":"/model-config provider.list {\"limit\":50}"}
```

Input is requested through Pi's extension UI sub-protocol (`extension_ui_request` / `extension_ui_response`), progress is reported with `setStatus`, and the result is appended as a `provider-manager/result` session entry read back with `get_entries`. Nothing bypasses Pi's protocol, so other extensions and their commands keep working unchanged.

See the [RPC usage guide](docs/rpc.md).

## Agent tools

Agent tools expose safe provider/catalog queries, discovery, recommendation, and configuration changes. Writes require native user confirmation; environments without UI return `requires_user_action`. Tools cannot accept credentials, start login, write headers, or edit user-owned drafts.

All entry points share validation and revision checks. Persistence uses a file lock and atomic replacement. Results distinguish committed configuration from failed runtime synchronization; `runtime.sync` retries synchronization. Deleting a provider retains its credentials by default.

## Development

```bash
pnpm typecheck
pnpm test
pnpm pack:check
```

Tests use isolated directories, actual Pi processes, local HTTP fixtures, and fake OAuth credentials. Native terminal tests require Python 3 and PTY support.

- [Implementation and validation](docs/implementation.md)
- [Original design](docs/refactor-requirements.md)
- [Pi interface audit and corrections](docs/pi-0.82.0-interface-audit.md)

Pi upstream and Pixle are unchanged. No actual native client integration is claimed; clients can implement the documented generic protocol independently.

The UI consumes operation descriptors and results through a small client interface. Domain rules and persistence stay outside the UI; RPC and agent tools use the same operations. See [design and tradeoffs](docs/tui-refactor.md).
