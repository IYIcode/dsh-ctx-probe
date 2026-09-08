# 自动探测本地模型上下文（dsh-ctx-probe）

[![npm version](https://img.shields.io/npm/v/dsh-ctx-probe.svg)](https://www.npmjs.com/package/dsh-ctx-probe)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe.svg)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> 英文版：[README.md](./README.md)

DeepSeek Harness（DSH）的零配置插件：自动探测本地模型服务器（llama.cpp `llamaserver`、Ollama）的**真实运行时上下文窗口**，并把 `llm-pi-ai` 的 `contextWindow` 设置自动同步成探测值——服务器改小就在溢出前收紧，服务器重启改大也会自动放宽。**不用手动填写任何数字。**

## 解决什么问题

`llm-pi-ai` 在模型未声明 `contextWindow` 时默认使用 **262144** tokens 的兜底值。如果你的 llama.cpp 是用 `-c 65536` 启动的，内置的 80% 压力压缩永远达不到触发线——第一个超长请求就会直接 400 溢出。

本插件在每个模型请求前探测服务器的真实窗口（`/v1/models` 的 `meta.n_ctx`——**运行时**大小，不是 `n_ctx_train` 训练窗口），并让配置始终等于探测值，双向自动跟随。

## 工作方式

- **何时探测**：每次 `agent/request` 时，按 `(provider, model)`。**本机服务器**（localhost/127.0.0.1/0.0.0.0）**每个请求都重新探测**——所以重启 llama.cpp（改大或改小 `-c`）后，**下一条消息**就会把 settings 同步好；远端服务器走 ~10 分钟 TTL 缓存。单飞 + 指数退避（10s 起、5min 封顶）防止探测风暴。
- **探测源**（按顺序取第一个可用值，1.5s 超时，错误全部吞掉）：
  1. llama.cpp `GET {baseURL}/models` → 匹配 `data[].id` → `meta.n_ctx`（运行时窗口，不是 `n_ctx_train`）；
  2. llama.cpp `GET {root}/slots` → `slots[].n_ctx`；没有则 `GET {root}/props` → 顶层 `n_ctx`；
  3. Ollama `GET {root}/api/show?name=<model>` → `model_info["ollama.context.length"]`；
  4. 兜底：溢出报错文本里解析出的上限（`agent/request-error` 时学习）。
- **自动同步（双向）**：只要 `探测值 ≠ 当前生效值`，就通过带版本校验的 `settings.update()` 合并补丁写回 `contextWindow`（冲突自动重试 3 次）。**收紧和放宽都做**。放宽只允许来自上面 1–3 的可信运行时源；溢出报错只能收紧。因为放宽值永远不会超过服务器实际强制执行的 `n_ctx`，所以不可能引发溢出。
- **收紧后的即时压缩**：写回更小窗口后，若会话占用已 ≥ 新窗口的 80%，空闲时立即压缩（`compactNow`），繁忙时推迟到下一个 `agent/pre-step`。
- **热重载**：`llm-pi-ai` 设置文档变化会清空探测缓存；写入带 revision 校验，并发编辑不会冲突。

## 命令

```
/ctx-probe [force] [provider model]
```

只读报告当前路由（或指定 `provider model`）的 configured / effective / probed 三个窗口值。`force` 忽略缓存强制重新探测。

## 安装（web profile）

从 GitHub（当前源码源）：

```powershell
dsh plugin --profile web add https://github.com/IYIcode/dsh-ctx-probe
```

或本地目录：

```powershell
dsh plugin --profile web add C:\path\to\dsh-ctx-probe
```

（发布到 npm 后，`dsh plugin --profile web add dsh-ctx-probe` 也可以。）

无论哪种方式，CLI 都会把包写进 profile 的 `dsh.profile.bundles` 并安装到 `node_modules`；之后**重启 DSH Web Host**（装 bundle 属于启动期变更，只有用户 patch 文件才热重载）。

## 源码

<https://github.com/IYIcode/dsh-ctx-probe> · 话题 [`dsh-plugin`](https://github.com/topics/dsh-plugin)

## 设计约束

- 不改 `node_modules`；不依赖任何 `@deepseek-ai/*` 包（完全自包含）。
- 只注入 `settings` 和 `llm`；其余（`tokenMeter`、`compaction`、`commands`）在调用时按域防御性解析。
- 所有事件处理器都是透传（`return next()` / `return config`），插件侧错误全部吞掉——探测失败永远不会拖垮 agent 循环。

## 与"手动目录类"插件的区别

社区同类插件要么是**手动填写**上下文窗口（如 `dsh-model-context-catalog`），要么是**定时拉取**目录（分钟级，如 `@goodandready/dsh-model-sync`）。本插件是**请求时实时探测本机服务器 `n_ctx` + 双向自动同步**——零配置、服务器怎么重启就怎么跟。
