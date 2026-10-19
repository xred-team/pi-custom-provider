# pi-custom-provider

[English](README.md) · 中文

为 Pi 0.85.1 管理自定义供应商、模型和认证。终端、RPC 客户端和模型工具共用同一套业务逻辑。

## 终端使用

在仓库中运行：

```bash
pnpm install --frozen-lockfile
pnpm exec pi -e ./src/index.ts
```

进入 Pi 后执行 `/model-config`，界面使用英文。对话框、列表、搜索、编辑器、页面、布局和边框均复用 Pi 原生组件。上下键连续遍历模型和操作，不需要 Tab 切换；直接输入可同时搜索两组内容，回车打开选中项。

`/model-config` 首屏是分组的供应商列表：Actions 区块（`Create provider`）和 Providers 区块，都不折叠、不隐藏。打开供应商后同样是分组列表：Provider 区块（可编辑字段 + 认证方式、凭据、请求 Header、删除），再是 Models（`Add model` 是第一行）。模型直接显示 ID，选中后进入模型编辑页面，返回后回到原位置。上下键连续遍历所有分组；直接输入同时搜索各分组，回车打开选中项。搜索框不会跨操作保留——操作后光标回到你刚操作的那一行——所以列表始终可回到任意一行。

切换开关、循环枚举、改思考等级和 compat 取值这类只改草稿的操作都是就地完成，面板不会卸载重建，所以不会闪屏；只有需要打开 Pi 对话框或另一个面板的操作才先让出编辑器区域。

Esc 关闭当前页面回到上一层，所以每个页面都不放多余的 Back / Close 行。模型编辑页按 Actions / Model / Pricing / Thinking level mapping / Compat 分组，每个值显示实际生效值（不再有笼统的 `Default`）；布尔与输入类型就地切换；凡是有确定取值集合的字段（思考等级、`thinkingFormat`、API type、认证方式）都在面板内打开一个选择列表：所有取值一次列出、当前值有标记，页面不会被拆掉。显示的是人类可读的名字，保存的仍然是 id。Compat 只列出该模型实际配置的字段，用 `Add compat field` 添加、`Remove compat field` 删除。所有修改自动保存，没有 Save / Discard 步骤。

`Create provider` 先选 API type，再列出 Pi 已知的该 API 的 endpoint —— `Enter a base URL myself` 保留手填路径。选一个已知 endpoint 不会新建任何东西：那个 provider 已经存在，所以流程会先要凭据，然后打开它的页面。`Add model` 会先发现模型，界面分为 Actions 与 Models 两块；选中某个模型会打开它自己的菜单：`Add to provider` / `Remove from provider`、`Edit model config`、`Apply model preset`，不用离开添加页就能改配置和套预设。`Enter model manually` 打开完整模型表单（ID、名称、API、上下文、输出长度等）；取消不会留下半个模型。

供应商字段、发现、模型选择、认证和删除均为主窗口里的直接操作。API Key 和 OAuth 凭据在创建供应商时输入，因此首次保存前就能发现模型；请求 Header 需要先保存供应商。

OpenAI 兼容接口的 `/models` 响应若包含上下文长度、输出上限、推理能力或输入模态，模型发现会保留这些元数据。

支持显示名称、改名、模型增删、价格及价格分档、思考等级、兼容配置，以及供应商和模型的请求 Header。可清除可选字段。保存后立即同步到 Pi；当前对话正在使用的供应商不能改名、删除或移除当前模型。

认证输入使用 Pi 原生输入框，输入内容可见，界面会明确提示。已存凭据不会回填。服务端 OAuth 文件引用的自动刷新会写回该文件；重新登录、导入或清除后会移除旧引用。更换接口地址、API 或认证方式会解除旧凭据和 Header 的关联，需要重新配置。

## Pi 自带的 provider

用 Pi 自己的 `/login` 登录过的 provider 并不在 `models.json` 里，`/model-config` 现在会直接列出来并标上
`Pi built-in`（例如 `openai-codex (OpenAI Codex, Pi built-in)`），改过模型后还会带 `n adjusted` 标记：
选中它，再选模型即可。改这类模型写的是 **`modelOverrides` 补丁**——Pi 最上层的配置层——所以只有你改的
字段被替换，Pi 自己的 endpoint、API、认证和模型列表都保留。改过的模型带 `(adjusted)` 标记，
`Reset all adjustments` 可以一次撤销该 provider 的全部补丁。Pi 自带 provider 的 endpoint、API 和模型
列表在这里是只读的，因为那属于 Pi。但它的**凭据可以改**：`Sign in` 走 Pi 自己的 OAuth 流程，
`Set API key` 写入 API Key，`Import OAuth JSON` 导入凭据，`Clear credentials` 清除。这些都写进 Pi 的
`auth.json`，键就是 provider id —— 和 `/login` 用的是同一个位置 —— 并且不会往 `models.json` 加记录。新建一个全新的 provider 仍然写普通的 `models[]`，因为没有内置模型
会被替换。

## 程序化调用

程序化调用就是 Pi 自己的 RPC 模式。本包不再自带传输层，只注册 `model-config` 命令，所以裸的 Pi RPC 进程直接就能用。

```bash
pi --mode rpc -e ./src/index.ts
```

先看命令和操作目录：

```json
{"id":"c1","type":"get_commands"}
{"id":"c2","type":"prompt","message":"/model-config help"}
{"id":"c3","type":"get_entries"}
```

`get_commands` 里能看到 `model-config`；`help` 会追加一条 `provider-manager/result` 类型的会话 entry，`data.operations` 里是每条操作的 `inputSchema` 和 `resultSchema`。

执行一条操作：

```json
{"id":"i1","type":"prompt","message":"/model-config provider.list {\"limit\":50}"}
```

需要输入时走 Pi 的扩展 UI 子协议（`extension_ui_request` / `extension_ui_response`），进度用 `setStatus`，结果作为 `provider-manager/result` 会话 entry 追加，用 `get_entries` 读回。全程不绕过 Pi 的协议，其他扩展和它们的命令照常工作。

用法见 [RPC 使用说明](docs/rpc.md)。

## 模型工具

模型可查询供应商、查看目录、发现和推荐模型。新增、修改、删除、保存模型需要用户通过 Pi 原生确认框确认；无 UI 时返回 `requires_user_action`。工具不提供密钥写入、OAuth 登录、Header 写入或用户草稿修改。

所有入口都有版本校验、明确错误和取消状态。配置通过文件锁与原子替换保存；运行时同步失败会如实返回“配置已保存、同步失败”，可调用 `runtime.sync` 重试。删除供应商默认保留凭据。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm pack:check
```

测试使用临时目录、真实 Pi 0.85.1 子进程、本地 HTTP 服务和假 OAuth，不读取个人配置。终端测试需要 Python 3 和支持 PTY 的系统。

- [实现及验证记录](docs/implementation.md)
- [原始需求与设计](docs/refactor-requirements.md)
- [Pi 0.82.0 接口核对及更正](docs/pi-0.82.0-interface-audit.md)

未修改 Pi 上游或 Pixle，尚未对接实际原生客户端；客户端可以按公开协议独立适配。

界面只依赖操作描述和结果，不引用业务服务或配置存储；RPC、TUI 和模型工具复用同一组业务操作。详见[重构说明](docs/tui-refactor.md)。
