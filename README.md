# 自动探测本地模型上下文 · dsh-ctx-probe

> **中文为主 · English translation follows each section**
> 自动探测本地 llama.cpp / Ollama 的真实上下文窗口并自动同步进 dsh 设置，双向跟随，零配置。
> Auto-detect the real context window of local llama.cpp / Ollama servers and keep `llm-pi-ai` in sync — both directions, zero config.

[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe.svg)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 🛠 给 Agent 的安装指引（可直接整段复制）

> **Agent install block — copy everything inside this box and hand it to a DSH coding agent.**
> 把这整段复制给你的 agent，它就能自己完成安装。

```text
请帮我安装 dsh 插件「dsh-ctx-probe / 自动探测本地模型上下文」，并在装好后验证：

1. 安装（GitHub 源，web profile）：
   dsh plugin --profile web add https://github.com/IYIcode/dsh-ctx-probe
2. 验证安装成功：运行
   dsh --profile web --dump-config
   确认输出层栈末尾包含三行：
   # == dsh-ctx-probe
   - id: ctx-probe
     name: dsh-ctx-probe
3. 如果步骤 1 报"declares no dsh.bundle"，说明安装方式不对，改用本地目录源或检查网络。
4. 装完后必须重启 DSH Web Host（Ctrl+C 后重新运行 dsh web）——bundle 是启动期加载，
   刷新页面不够。
5. 重启后验证功能：
   a. 在聊天里执行 /ctx-probe force，应看到目标 provider/model 的
      configured / effective / probed 三个值；
   b. 给本地模型发任意一条消息，插件会在请求前探测服务器真实 n_ctx 并自动同步设置
      （模型设置里能看到 contextWindow 变成服务器实际值，服务器 -c 改了也会自动跟随）。
```

*EN: This is the only block an agent needs — install from GitHub, verify the layer row in `--dump-config`, restart the DSH Web Host, then confirm with `/ctx-probe force`.*

---

## 这个插件解决什么问题 / Problem

`llm-pi-ai` 对未声明 `contextWindow` 的模型默认使用 **262144** tokens 兜底。若你的 llama.cpp 以 `-c 65536` 启动，内置的 80% 压力压缩永远达不到触发线——第一个超长请求直接 400 溢出。

> *EN: `llm-pi-ai` defaults an undeclared `contextWindow` to **262144**. Against a llama.cpp started with `-c 65536` the built-in 80% compaction never triggers, so the first oversized request hard-fails with a 400 overflow.*

本插件探测服务器的**真实运行时窗口**（`/v1/models` 的 `meta.n_ctx`，不是 `n_ctx_train`），并让配置始终保持等于探测值——**改小→溢出前自动收紧；重启改大→自动放宽**。全程无需手填任何数字。

> *EN: The plugin probes the real runtime window (`meta.n_ctx`, not `n_ctx_train`) and keeps the configured window equal to it — tightening before overflow when the server shrinks, widening when it grows. No manual numbers.*

## 工作方式 / How it works

- **何时探测 When**：每次 `agent/request`（模型调用发出前），按 `(provider, model)` 进行。
  **本机服务器**（localhost / 127.0.0.1 / 0.0.0.0）**每个请求都重新探测**——重启 llama.cpp 后**下一条消息**即自动同步；远端服务器走 ~10 分钟 TTL 缓存。单飞 + 指数退避（10s 起、5min 封顶）防探测风暴。
  > *EN: On every `agent/request`. Loopback servers are re-probed on EVERY request (a server restart is applied on the very next model call); remote servers use a ~10 min TTL cache. Single-flight + exponential backoff (10 s base, 5 min cap).*
- **探测源 Probe sources**（首个可用即胜，1.5s 超时，错误全部吞掉 / first usable wins, errors swallowed）：
  1. llama.cpp `GET {baseURL}/models` → `meta.n_ctx`（运行时窗口）；
  2. llama.cpp `GET {root}/slots` → `slots[].n_ctx`；否则 `GET {root}/props` → `n_ctx`；
  3. Ollama `GET {root}/api/show` → `model_info["ollama.context.length"]`；
  4. 兜底：溢出报错文本中解析的上限（`agent/request-error` 时学习，只能收紧）。
- **自动双向同步 Auto-sync**：只要 `探测值 ≠ 生效值`，就通过 revision 校验的 `settings.update()` 合并补丁写回 `contextWindow`（冲突重试 3 次）。扩张只允许来自 1–3 的可信运行时源；由于扩张值永不超过服务器实际执行的 `n_ctx`，不会引发溢出。
  > *EN: Whenever `probed ≠ effective` the plugin writes `contextWindow` back via a revision-checked `settings.update()` merge patch (3× conflict retry) — tightening AND widening. Widening is only allowed from trusted runtime sources (1–3); because it never exceeds the server's enforced `n_ctx`, it cannot cause overflow.*
- **收紧后即时压缩 Post-tighten compaction**：若会话占用已 ≥ 新窗口 80%，空闲时立即压缩，繁忙时推迟到下个 `agent/pre-step`。
- **热重载 Hot reload**：`llm-pi-ai` 设置文档变化即清空探测缓存；写入带 revision 校验，并发编辑不冲突。

## 命令 / Command

```
/ctx-probe [force] [provider model]
```

只读报告 configured / effective / probed 三个窗口值；`force` 忽略缓存强制重探。
> *EN: Read-only report of configured vs effective vs probed windows; `force` bypasses the cache.*

## 安装（人工操作版）/ Manual install

```powershell
dsh plugin --profile web add https://github.com/IYIcode/dsh-ctx-probe
```

或本地目录 / or from a local copy：`dsh plugin --profile web add C:\path\to\dsh-ctx-probe`
（发布到 npm 后也可 `add dsh-ctx-probe`。）

装完**重启 DSH Web Host**（安装 bundle 是启动期变更，只有用户 patch 文件热重载）。
> *EN: Install, then RESTART the DSH Web Host — adding a bundle is a boot-time change.*

## 源码 / Source

<https://github.com/IYIcode/dsh-ctx-probe> · 话题/ topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)

## 设计约束 / Design constraints

- 不改 `node_modules`；不依赖任何 `@deepseek-ai/*` 包（完全自包含）。
- 只注入 `settings` 与 `llm`；其余服务按需防御性解析。
- 所有事件处理器透传、插件侧错误全吞——探测失败永远不会拖垮 agent 循环。
- 与同类插件的区别：本插件是**请求时实时探测 + 双向自动同步**（非手填目录、非定时拉取）。

> *EN: No `node_modules` edits, no `@deepseek-ai/*` imports (self-contained); injects only `settings`/`llm`; handlers are pass-through and swallow errors so a probe failure can never break the agent loop. Unlike manual-catalog or scheduled-sync plugins, this one probes per-request and syncs both ways.*
