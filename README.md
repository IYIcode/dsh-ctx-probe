# dsh-ctx-probe

[![npm version](https://img.shields.io/npm/v/dsh-ctx-probe.svg)](https://www.npmjs.com/package/dsh-ctx-probe)
[![npm downloads](https://img.shields.io/npm/dm/dsh-ctx-probe.svg)](https://www.npmjs.com/package/dsh-ctx-probe)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe.svg)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Profile plugin for DeepSeek Harness that detects the **real runtime context
window** of local model servers (llama.cpp `llamaserver`, Ollama) and keeps the
`llm-pi-ai` `contextWindow` setting in sync automatically — tightening it
before context overflow, and widening it when the server is restarted with a
larger `-c`. Zero configuration.

## Problem

`llm-pi-ai` defaults an undeclared `contextWindow` to **262144**, so the
built-in 80%-pressure compaction never triggers against a llama.cpp server
started with `-c 65536` — the first oversized request hard-fails with a 400
context overflow. This plugin probes the server for its actual runtime window
(`/v1/models` `meta.n_ctx` — the runtime size, not `n_ctx_train`) and keeps the
configured window equal to it, in both directions.

## Behavior

- **When:** on every `agent/request` (before the model call is dispatched),
  per `(provider, model)`. **Loopback servers** (localhost/127.0.0.1/0.0.0.0)
  are re-probed on **every** request so a server restart (changed `-c`,
  larger or smaller) is picked up by the very next model call; remote servers
  use a TTL cache (~10 min). Single-flight per key; exponential backoff
  (10 s base, 5 min cap) on probe failure.
- **Probe sources (first usable wins, 1.5 s timeouts, all errors swallowed):**
  1. llama.cpp `GET {baseURL}/models` → `data[].id` match → `meta.n_ctx`
     (the runtime size — *not* `n_ctx_train`).
  2. llama.cpp `GET {root}/slots` → `slots[].n_ctx`, else `GET {root}/props`
     → top-level `n_ctx` (`root` = `baseURL` minus trailing `/v1`).
  3. Ollama `GET {root}/api/show?name=<model>` →
     `model_info["ollama.context.length"]`.
  4. Last resort: overflow error text (parsed at `agent/request-error`).
- **Auto-sync (write-back):** keeps the configured window equal to the real
  runtime window — whenever `probed ≠ effective`, writes `contextWindow` back
  via a revision-checked `settings.update()` **merge patch** (deep
  `mergeLayers` semantics — arrays replace wholesale) with 3× conflict retry.
  Writes **both** smaller (tighten) and larger (expand) values. Expansion is
  allowed only from the trusted runtime sources (1–3) above; the
  overflow-error source may only tighten. Because expansion never exceeds what
  the server actually enforces (`n_ctx`), it cannot cause overflow. Note:
  `settings.mutate()` path ops are avoided on purpose — the real service's
  `applyPathOp` cannot address array elements and would corrupt the `models`
  array (see the smoke suite's faithful mock).
- **Immediate compaction (§3.4):** after a successful tightening, if the
  session already uses ≥ 80% of the new window, compact now when idle
  (`compactNow`), or defer to the next `agent/pre-step`
  (`compactIfNeeded`, pressure trigger) when busy. The built-in engine's own
  pre-step pressure check (which reads the live window) provides the same
  guarantee from the other direction; double calls are no-ops.
- **Hot reload:** settings document changes for `llm-pi-ai` invalidate the
  probe cache; writes are revision-checked so reloads cause no conflicts.

## Command

```
/ctx-probe [force] [provider model]
```

Read-only report of configured vs effective vs probed windows for the routed
model (or an explicit `provider model`). `force` re-probes, bypassing the TTL
cache.

## Install (web profile)

From npm (published):

```powershell
dsh plugin --profile web add dsh-ctx-probe
```

Or from a local copy:

```powershell
dsh plugin --profile web add C:\path\to\dsh-ctx-probe
```

Either way the package reconciles `dsh.profile.bundles` in the profile's
`package.json` and links into the profile's `node_modules`; restart the DSH Web
Host afterwards (installing a bundle is a boot-time change — only user patch
files hot-reload).

## Source

<https://github.com/IYIcode/dsh-ctx-probe> · topic
[`dsh-plugin`](https://github.com/topics/dsh-plugin)

## Design constraints

- No `node_modules` modifications; no `@deepseek-ai/*` imports (self-contained).
- Injects only `settings` and `llm`; everything else (`tokenMeter`,
  `compaction`, `commands`) is resolved defensively per-realm at call time.
- All event handlers are pass-through (`return next()` / `return config`) and
  swallow every plugin-side error — a probe failure can never break the agent
  loop.
