# OpenAPI 统一动态加载适配器 — 设计文档

> 状态: 设计稿 (openapi-adapter-design 分支)
> 前置: AgentCLI v0.1.1 已实现 MCP → CLI 的动态转换。本文设计把 OpenAPI (3.x JSON) 纳入同一运行时。

## 0. 一句话

**CLI 核心只认识 "工具 + JSON Schema";后端负责生产它们。**
MCP 后端从协议里拿工具列表;OpenAPI 后端把 spec 编译成工具列表。往下 (flag 编译 / 帮助 / 执行 / 缓存 / 错误 / 退出码) 全部复用,零分叉。

```
        agentcli <server> <tool> --flags
                     │
           dispatch.ts  (backend 无关)
                     │   ToolDef { name, description, inputSchema, tags? }
        ┌────────────┴─────────────┐
   McpBackend                  OpenApiBackend
   stdio/http + daemon         snapshot → compile → fetch
   tools cache (TTL)           tools cache (同一套)
```

统一的四个锚点:

| 锚点 | 含义 |
|---|---|
| ToolDef | 同一种工具定义 (JSON Schema inputSchema) → 同一个 flag 编译器 (`flags.ts` 不动) |
| Result envelope | callTool 返回同一种 MCP 形状结果 → 同一个 `extractData` / 输出路径 |
| Cache | 同一个 `<name>.tools.json` TTL/refresh 语义 |
| Errors | 同一张错误码表 → 同一套 exit code 协议 |

## 1. 目标 / 非目标

**目标**
1. `agentcli server add petstore --openapi <path|url>` 之后,`agentcli petstore -h` 列出全部 operation,`agentcli petstore getPetById --petId 1` 直接执行。
2. 对 dispatch / flags / help / 输出层 **零改动或近零改动** — "统一"由一个 Backend 接口完成,不是新写一个平行 CLI。
3. 离线友好: spec 快照落盘,`--refresh` 才回源。
4. 凭据与 MCP 同等隔离: header 值支持 `${ENV_VAR}` 展开,永不落盘。

**非目标 (明确不做)**
- Swagger 2.0 (报错并提示升级到 3.x)
- YAML spec (P2; JSON 先行,检测到 `.yaml` 报错给出明确 hint)
- OAuth2 流程、token 刷新 — 只做 header 注入,凭据由用户提供
- multipart / form body (报错带 hint)
- 响应体按 schema 校验、分页自动翻页 (`--all` 留作 P3)
- OpenAPI → MCP 反向桥接 (架构上已具备 — Backend 产 ToolDef,未来可包一层 MCP server;本文不含)

## 2. Backend 接口 (统一点)

```ts
// src/backend/types.ts
export interface Backend {
  readonly kind: "mcp" | "openapi";
  listTools(opts: { refresh?: boolean; timeoutMs?: number }): Promise<ListToolsResultEnvelope>;
  callTool(tool: string, args: Record<string, unknown>, opts: { timeoutMs?: number; daemon?: boolean }): Promise<CallToolResultEnvelope>;
}

export function openBackend(cfg: AgentCliConfig, name: string): Backend;
// 按 cfg.servers[name].type 分发: "mcp 类" (stdio/http) → McpBackend, "openapi" → OpenApiBackend
```

- `McpBackend`: 薄封装现有 `client.ts` 的 `listTools/callTool`,逻辑一行不改。
- `OpenApiBackend`: 新增。忽略 `daemon` 选项 (无状态 HTTP,无持久连接需求),`via` 恒为 `"direct"`。
- **改造点**: `dispatch.ts` 与 `index.ts` 的 `server tools` 改调 `openBackend(...)`;`client.ts` 保持 MCP 专用。
- `ToolDef` = 现有 `McpTool` 更名 (纯重命名,字段不变,新增可选 `tags?: string[]` 供 help 分组)。

OpenAPI 的 callTool 返回值伪装成 MCP 形状 — 这是"统一"的实惠:

```ts
{
  content: [{ type: "text", text: rawBody }],
  structuredContent: parsedJson ?? undefined,
  isError: status >= 400
}
```

dispatch 的 `extractData` / `extractText` / `--output text` 全部直接工作。

## 3. 配置层

### 3.1 ServerSpec 新变体

```ts
export interface OpenApiServerSpec {
  type: "openapi";
  spec: string;        // 本地快照路径 (add 时已下载/复制),相对 dataDir
  origin: string;      // 原始来源: URL 或绝对文件路径 (--refresh 回源用)
  baseUrl?: string;    // 覆盖 spec.servers[0].url
  headers?: Record<string, string>;  // 可含 ${ENV_VAR} 占位
}
```

### 3.2 注册: server add

```bash
agentcli server add petstore --openapi https://petstore3.swagger.io/api/v3/openapi.json \
  [--base-url https://...] [--header "Authorization: Bearer ${PETSTORE_TOKEN}"]
agentcli server add myapi --openapi ./myapi.json   # 本地文件同样快照
```

add 时的动作 (fail-fast,注册即验证):
1. 拉/读 spec → 校验 `openapi: "3.x"` → **快照落盘** `~/.agentcli/specs/<name>.json` (0600)
2. 试编译一遍: operation 数、命名冲突、致命 $ref 问题在 add 时就报,不留到调用时
3. 写 config (`spec` 指向快照,`origin` 记录来源) → 输出 `{ ok, server, operations: N }`

`--refresh` 语义: 有 origin URL → 重新拉取 + 重新快照 + 重新编译;origin 是本地文件 → 重新复制 + 重编译 (方便用户改了本地 spec)。

### 3.3 凭据

- header 值里的 `${VAR}` 在 **请求时** 展开;引用了未定义变量 → `AUTH_REQUIRED` (hint: 设置环境变量)。
- 与 MCP stdio 的 env whitelist 哲学一致: 凭据不进 config 文件明文,不进日志。
- P2 增强: 读 `components.securitySchemes`,发现 spec 需要 bearer 而配置没给 Authorization → 调用时给一条 helpful hint。

## 4. OpenAPI → ToolDef 编译规则 (src/openapi/compile.ts)

### 4.1 operation → 工具名

| 优先级 | 规则 | 例子 |
|---|---|---|
| 1 | `operationId` (做 slug 清洗: 非 `[a-zA-Z0-9_.-]` → `_`) | `getPetById` |
| 2 | 兜底 `METHOD + "_" + pathSlug`: `{param}` → 参数名, `/` → `_` | `GET /pets/{petId}` → `get_pets_petId` |

- 重名: 确定性自动加后缀 `_2`, `_3`;工具 description 首行标注 `METHOD /path — origin: <operationId or path>`,保证 agent 可追溯。
- description = `operation.summary` + `operation.description`。

### 4.2 参数 → inputSchema.properties

把 path / query / header 三类参数**打平**到同一个顶层 properties (cookie 忽略):

```jsonc
// GET /pets/{petId}?verbose=  →  inputSchema:
{ "type": "object",
  "required": ["petId"],
  "properties": {
    "petId":  { "type": "integer", "description": "…" },
    "verbose":{ "type": "boolean" } } }
```

- path 参数强制 required (spec 没写也补上)。
- OpenAPI param schema 支持 `schema.$ref` → 解引用后内联 (见 4.4)。
- query 数组: flag 重复传值 → 序列化为 repeat (`?tags=a&tags=b`,form/explode 默认);`style: csv` 的 spec 少见,P1 按单值字符串透传 (spec 里写了 enum 的照常生成 choices)。

### 4.3 requestBody → body 参数打平

仅处理 `application/json`:

| body schema 形状 | 编译结果 |
|---|---|
| object,顶层属性是简单类型 | **属性全部提升为顶层 flags** — `POST /pets` 的 `{name, tag}` 直接 `--name x --tag y` |
| object,含嵌套/复杂属性 | 简单属性照常 flag;复杂属性进 `plan.complex` (→ `--input`),与 MCP 路径完全一致 |
| 顶层 `allOf` | 合并各段的 properties/required 后按上两行处理 (allOf-merge 常见,值得做) |
| array / string / 无 schema | 单个复杂参数 `--input '{"body": [...]}'` 形态,body 键名固定 |
| 其他 content-type | 编译期不报错;调用时若真传了 body → `INVALID_ARGUMENT` + hint |

命名冲突 (如 path 有 `id`,body 也有 `id`): 冲突键以 body 侧加前缀 `body_` 消解,并在 description 标注原名。编译期不再因冲突失败 — 自动消解优于报错 (真实 spec 里同名不罕见)。

### 4.4 $ref 解析 (src/openapi/ref.ts)

- 只支持 **本地 ref** `#/components/...`;内部 `$ref` 递归内联,**循环检测**: 二次命中同一 ref 路径 → 替换为 `{type: "object", description: "(circular ref)"}` 并视为 complex。
- 内联深度上限 (如 8) 防深递归炸弹。
- 外部 ref (`file://`, `http://`) → 编译期 `INVALID_ARGUMENT`,hint 指明哪个 operation 引用了它 (常见于拆分的多文件 spec,P2 再考虑 bundle)。

### 4.5 tags

`operation.tags` 收集进 `ToolDef.tags`。服务级 help (`agentcli petstore -h`) 有 tag 就按 tag 分组显示 (无 tag 的进 `—` 组);工具名保持扁平。解决"一个 spec 500 个 operation 刷屏"的发现问题,命令面不引入层级 (与 MCP 侧一致)。

## 5. 执行层 (src/openapi/exec.ts)

```
callTool(tool, args) →
  1. 查编译产物 (operation 元数据: method, pathTemplate, paramLocations, bodyInfo, securityHint)
  2. URL = baseUrl 解析 + path 参数替换 ({petId} → String(args.petId))
  3. query: 非 path/header/body 的参数 → URLSearchParams (数组 repeat)
  4. header params → 请求头; config headers (env 展开) 合并
  5. body 参数存在 → JSON.stringify + content-type: application/json
  6. fetch (AbortSignal.timeout(--timeout-ms, 默认 60s))
  7. 包成 MCP 形状 envelope (见 §2)
```

### 5.1 HTTP → 错误码映射

| 情况 | code | 附加 |
|---|---|---|
| DNS/网络失败 | `CONNECT_FAILED` | — |
| 超时 | `TIMEOUT` | hint 同现有 |
| 401 / 403 | `AUTH_REQUIRED` | — |
| 404 | `NOT_FOUND` | — |
| 429 | `EXECUTION_ERROR` | details 带 `retryAfter` (读 header) |
| 其余 4xx / 5xx | `EXECUTION_ERROR` | details: `{ httpStatus, body }` (body 截断 2KB) |
| 响应非 JSON | data 走 text 路径 | `--output text` 原样输出 |

错误响应体里若能解出 `message/error` 字段,提升为错误 message 首行 — agent 第一眼看到 API 自己的话术。

### 5.2 servers/variables

`spec.servers[0]` 为基准;URL 模板变量用 variables 默认值展开;`--base-url` (config `baseUrl`) 覆盖一切。多个 server entry 只取第一个 (P2: `server add --server-label` 选择)。

## 6. 缓存与 daemon

- 编译产物写现有 tools cache (`<name>.tools.json`,同一 TTL 10min / `AGENTCLI_TTL_MS` / `--refresh`)。cache 里存的是 **编译后的 ToolDef[] + 每工具的 operation 元数据** (method/path/paramLocations/bodyInfo),调用时不需要重新碰 spec。
- 快照 (specs/<name>.json) 与编译缓存 (cache/<name>.tools.json) 分层: 快照是"源",编译缓存是"产物"。`--refresh`: TTL 之外重编译;快照损坏 → 自动回源重拉。
- daemon 不参与 openapi (无状态);`meta.via: "direct"`。daemon status 里也不计入。
- `server remove` 同步删快照与编译缓存 (现有删 cache 的地方加一行)。

## 7. 模块布局与改造点

```
src/backend/types.ts        新  Backend 接口 + ToolDef (自 types.ts 迁移更名)
src/backend/index.ts        新  openBackend(cfg, name) 工厂
src/backend/mcp.ts          新  薄封装 client.ts (零逻辑)
src/openapi/specstore.ts    新  快照下载/复制/回源刷新 (fetch + fs, 0600)
src/openapi/ref.ts          新  $ref 内联解析 (循环/深度保护)
src/openapi/compile.ts      新  spec → ToolDef[] + operation 元数据
src/openapi/exec.ts         新  args → HTTP 请求 → envelope + 错误映射
src/dispatch.ts             改  listTools/callTool → openBackend(...)  (≈5 行)
src/index.ts                改  server add --openapi/--base-url;server tools 走 backend
src/types.ts                改  +OpenApiServerSpec;McpTool → ToolDef (tags?)
src/config.ts               改  removeServer 清快照
src/flags.ts / jsonout / errors / fuzzy / daemon/*  不动
```

外部依赖: **零新增** (fetch 是 Node ≥18 内建)。

## 8. 测试计划

| 层 | 内容 |
|---|---|
| 单元: compile | petstore 迷你 fixture: 命名 (operationId/兜底/冲突后缀)、path 强制 required、query/header 参数、body 打平 (简单/复杂/allOf/array)、$ref 内联与循环、tags 收集 |
| 单元: exec | URL 构建 (path 替换/query 数组 repeat)、header env 展开 (含未定义 → AUTH_REQUIRED)、错误码映射表全分支 |
| e2e | test 内起一个真 http server (node:http): GET+path、POST+JSON body、401→AUTH_REQUIRED、500→EXECUTION_ERROR、非 JSON 响应 → text 输出;快照 add → 断网 (删 origin 指向) 仍可执行 |
| 回归 | 现有 MCP 全部测试不动通过 (证明"统一"没破坏旧路径) |

## 9. 分阶段落地

- **P1 (本分支目标)**: Backend 接口 + openapi 全链路 (JSON/3.x、参数打平、body 打平、本地 $ref、快照、错误映射、tag 分组 help) + 全部测试
- **P2**: securitySchemes 自动提示、YAML、query style (csv/spaceDelimited)、外部 $ref bundle、`--server-label`
- **P3**: 响应 schema 感知输出、`--all` 分页、OpenAPI→MCP 反向桥接 (Backend 已产 ToolDef,包一层 stdio server 即可)

## 10. 关键决策记录 (ADR 摘要)

| # | 决策 | 备选与理由 |
|---|---|---|
| 1 | 统一点放在 Backend 接口而非"编译期生成 CLI 代码" | 动态运行时与现有 MCP 路径同构;不引入代码生成、构建步骤 |
| 2 | callTool 返回 MCP 形状 envelope | dispatch/输出层零改动;代价是 openapi 侧一次包装,可控 |
| 3 | add 时快照落盘 | 离线可用、可审计、spec 变更不破坏已注册 CLI;live 模式 (每次调用回源拉 spec) 被否 — 慢且不稳 |
| 4 | body 属性打平为顶层 flags | agent 体验优先 (不用每次 --input);冲突用 `body_` 前缀消解而非报错 |
| 5 | operationId 缺失兜底为机械 slug | 语义化改名 (如 list_issues) 需要启发式,不可预测;机械规则 agent 可推理 |
| 6 | daemon 不服务 openapi | 无状态 HTTP 无持久连接收益;少一条守护进程职责,复杂度换不来性能 |
| 7 | 零新增依赖 | fetch 内建;$ref 自写解析器 (<100 行) 比引入 api-ref-parser 轻 10 倍 |