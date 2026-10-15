# dsh-litellm-extra-headers

给 DeepSeek Harness 用的宿主插件：把 `extra_headers: { "<header>": "<value>" }` 塞进 **OpenAI 兼容请求的 body**，只对「配置里列出的 provider 路由」+「配置里列出的上游 host」生效。

用途：绕过 LiteLLM 之类的反向代理丢弃客户端 HTTP 头的问题——某些上游（例如 OpenCode / 网关自建的会话亲和）要求每个请求带 `x-opencode-session`，而代理只在 `body.extra_headers` 里认这个字段。

简体中文 | [English summary](#english-summary)

## 为什么只能这么做（已核实，改动前先读）

1. **客户端 HTTP 头在 LiteLLM 这一跳被丢弃。** 实测把 `x-opencode-session` 加在请求头上，上游仍然 500；改放 `body.extra_headers` 后 200。
2. **DSH 的 `llm-pi-ai` 适配器只白名单转发** `temperature` / `maxTokens` / `sessionId` / `signal` / `headers` / … 这些字段（见其 `profileOptions()`），pi-ai 唯一能塞任意 body 字段的入口 `options.samplingParams` 在 DSH 里没有暴露，所以纯配置解决不了。
3. **现成的 `dsh-opencode-session` 插件是「加 HTTP 头」的**，在这条链路上注定无效；而且它的默认 `providers` 是 pi-ai 目录里的 `['opencode', 'opencode-go']`，不含自定义路由键（如 `gwds`、`go`）。
4. **pi-ai 的 `openai-completions` 走官方 `openai` SDK**（v6.40.0），SDK 通过 `this.fetch = options.fetch ?? globalThis.fetch` 调用 `globalThis.fetch`。因此运行时替换 `globalThis.fetch` 是当前唯一可用的宿主侧注入点。

结论：**不要在别处再加 header**，那条路已经验证过是死的；要新字段就往 body 里合。

## 安装

已发布在 npm：`dsh-litellm-extra-headers@0.1.0`

```sh
# npm（推荐）
dsh plugin --profile web add dsh-litellm-extra-headers

# 从本地目录（开发时推荐，link 安装，改动即时生效）
dsh plugin --profile web add ./dsh-litellm-extra-headers
# 从打包产物
dsh plugin --profile web add ./dsh-litellm-extra-headers-0.1.0.tgz
# 从 git 主机（本包是纯 JS，无需 pnpm 放行构建脚本）
dsh plugin --profile web add github:chenyifawan-cell/dsh-litellm-extra-headers
```

包内 `cordis.patch.yml` 会插入一行插件；`dsh plugin add` 识别到 `dsh.bundle` 后自动把本包加进该 profile 的 `bundles` 列表。装完确认一层存在：

```sh
dsh --profile web --dump-config | Select-String litellm-extra-headers
```

不想装包也可以手工把这一行写进 profile 的 `cordis.patch.yml`（行指向本包名或 `index.js` 路径）。包内自带的这一行 `providers` / `hosts` **默认留空**（空列表 = 插件保持惰性），把你的路由键和上游地址填进去才生效：

```yaml
- insert:
    - id: litellm-extra-headers
      name: dsh-litellm-extra-headers
      config:
        providers: [gwds, go]                # 你的路由键
        hosts: ["litellm.internal:4000"]     # 只有这些上游才注入
        header: x-opencode-session
        mode: session-id
        value: null
        debug: false
        debugFile: null
```

## 配置字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `providers` | `string[]` | `[]` | `llm/stream` 的 `options.provider` 路由键白名单。**必须显式列出**，匹配大小写不敏感。 |
| `hosts` | `string[]` | `[]` | 允许注入的上游 `host[:port]` 白名单；带 scheme / path 的写法会被归一化（`http://litellm.internal:4000/v1` → `litellm.internal:4000`）。**必须显式列出**。 |
| `header` | `string` | `x-opencode-session` | 放进 `extra_headers` 的字段名。 |
| `mode` | `session-id` \| `uuid` \| `fixed` | `session-id` | 取值来源：DSH 会话 id（跨轮次、跨重启稳定）／每会话一个进程内随机 uuid／配置里的字面量。 |
| `value` | `string` | — | `mode: fixed` 时的字面量；`fixed` 却没给值会在加载时报错。 |
| `debug` | `boolean` | `false` | 每次注入决策打一条 `ctx.logger.info`。 |
| `debugFile` | `string` | — | 每次注入决策追加一行 JSON（含 provider / model / session / host / path / event / reason），进程控制台看不到时用它排错。 |

`providers` 或 `hosts` 为空时插件**保持惰性**并打一条 warning：一个可以共享出去的包，不应该对别人没被告知过的网关偷偷加字段。

## 设计要点

1. **双层匹配，缺一不可。**
   - `llm/stream` waterfall 里判断 `options.provider ∈ providers` 且存在 `options.sessionId`，才把 `{ value, provider, model, session }` 放进 `AsyncLocalStorage`（这一步才有路由键）。
   - `fetch` patch 里再判断目标 URL 的 `host ∈ hosts` 才改 body。
   - 于是别人路由键跟你不同时，只会改白名单里的网关，不会给别人的网关塞未知字段。
2. **只改 `/chat/completions` 的 JSON body。** 条件是 `method === 'POST'` + `content-type` 含 `application/json` + `typeof init.body === 'string'` + `pathname` 以 `/chat/completions` 结尾。解析失败一律原样放行；`extra_headers` 已存在时**合并而不覆盖**，已有同名字段时尊重调用方、不覆盖。
3. **零依赖 + 可还原。** 只用 `node:async_hooks` / `node:crypto` / `node:fs/promises`；安装与卸载都是 `ctx.effect()`，dispose 时 `globalThis.fetch` 按引用还原（被别人又包了一层也不会误还原）。

## 验证

```sh
npm test          # node --test：条目命中 / 非命中 / 已存在不覆盖 / 非 JSON 原样 / dispose 还原（19 项）
npm run test:e2e  # 真机链路：本地 mock 上游 + 真实 dsh headless 跑一轮，对照组不带插件
```

按顺序，前一步不过不进下一步：

1. `npm test` 全绿。
2. `npm run test:e2e`：起一个会记录请求体的本地 OpenAI 兼容上游，用 `dsh --profile headless --patch` 把 provider 指向它并挂上本插件，跑一轮真实会话。断言：命中的请求 body 里多出 `extra_headers`、值在整轮里稳定（同一个会话 id）、**对照组（去掉插件行）没有这个字段**，并且 `debugFile` 有 `event: "inject"` 记录。
3. **换到能连到 LiteLLM 的那台机器上**（第 2 步用的是本地 mock 上游，不需要网络）再跑一轮，用 `debugFile` 确认日志里出现注入记录，且上游不再报缺少会话头。这一步验证的是 LiteLLM 自己的「body.extra_headers → 上游请求头」合并行为，只有真实网关能证明。
   对照实验：手动 `curl` 只带 HTTP 头、不带 `extra_headers` → 上游报错；body 里带 `extra_headers` → 通过。

## 发布备忘（首次发布踩过的坑）

1. **2FA 必须开**：npm 只支持安全密钥（Windows Hello 指纹/PIN 或 YubiKey），没有 Google Authenticator 那种 TOTP。
2. **`npm publish` 要在真终端里跑**：npm 只在 stdin/stdout 都是 TTY 时才走「自动开浏览器 → 轮询授权 → 自动重试上传」那条路（`lib/utils/auth.js` 的 `otplease`）；管道化的非交互进程会直接抛 EOTP，而错误文本里的授权 URL 被 `@npmcli/redact` 打码，等于拿不到链接。
3. **新包名会先进审核**：首次发布会先在 registry 上生成一个 `0.0.0-stage` 占位版本（"Temporary package placeholder for staged publishing"），真正的版本进入审核，CLI 只提示 `Your package is being processed`。几分钟后正式版本自动上线，`latest` 指向它，占位版留在历史里。期间 `npm stage list` 可能为空，不用慌。
4. 发布前记得 `--registry=https://registry.npmjs.org`：本机若把 registry 指向 npmmirror 这类只读镜像，默认 `npm publish` 会打错源。

## 已知边界

- `input` 是 `Request` 对象时（body 在 Request 里，同步读不出来）不改，原样放行；当前 pi-ai + openai SDK 走的是「URL 字符串 + init.body 字符串」，不触发这条。
- `extra_headers` 存在但不是普通对象（数组 / 字符串等）时原样放行，避免把别人的 body 改坏。
- 只注入，不做重试、不改 header、不改其它 body 字段。

## English summary

Host plugin for DeepSeek Harness: while a model call routed to a configured provider streams, `globalThis.fetch` merges `extra_headers[<header>] = <value>` into the JSON body of `POST .../chat/completions` requests sent to a configured upstream host. It exists because a LiteLLM relay drops client HTTP headers (verified: header-only 500, body `extra_headers` 200), DSH's pi-ai adapter whitelists request fields, and the existing `dsh-opencode-session` plugin only sets a header. Both `providers` and `hosts` must be listed explicitly, or the plugin stays inert. MIT.

## License

MIT
