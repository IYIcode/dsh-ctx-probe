/**
 * dsh-ctx-probe — detect the real context window of local model servers.
 *
 * Problem: llm-pi-ai defaults an undeclared `contextWindow` to 262144, so the
 * built-in 80%-pressure compaction never triggers against a llama.cpp server
 * that was actually started with `-c 65536` (or smaller) → hard 400 overflow.
 *
 * Strategy (all defensive, never throws into waterfalls):
 *  - On every `agent/request`, probe the model's real window from the server
 *    itself (llama.cpp `/v1/models` meta.n_ctx → `/slots` → `/props` → Ollama
 *    `/api/show`). Loopback servers are re-probed on EVERY request so a server
 *    restart (changed -c, larger or smaller) is applied on the very next model
 *    call; remote servers use a TTL cache. Single-flight + exponential backoff
 *    on failure.
 *  - Keep `llm-pi-ai`'s configured window in sync with the probed value — write
 *    back through a revision-checked `update()` merge patch with conflict retry
 *    whenever probed ≠ effective, in BOTH directions. Expansion is allowed only
 *    from trusted runtime sources (llama.cpp n_ctx / slots / props, Ollama);
 *    overflow-error learning can only tighten.
 *  - After a successful tightening, if session usage is already >= 80% of the
 *    new window, compact now (idle) or defer to the next pre-step (busy).
 *  - Overflow error text is parsed as a last-resort probe source.
 *  - `/ctx-probe` command reports configured vs effective vs probed values.
 *
 * The plugin is self-contained: no imports from @deepseek-ai/* packages.
 */

import { appendFileSync, mkdirSync } from "node:fs";

export const name = "ctx-probe";
export const inject = ["settings", "llm"];

const LLM_NS = "llm-pi-ai";
const PROBE_TTL_MS = 10 * 60 * 1000; // ~10 min cache
const PROBE_TIMEOUT_MS = 1500; // short per-request timeout
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
const MAX_CREDIBLE_WINDOW = 8_000_000;
const MIN_CREDIBLE_WINDOW = 1024;
const PRESSURE_RATIO = 0.8; // matches the built-in compaction default
const DEFAULT_PI_WINDOW = 262144; // pi-ai defaultContextWindow fallback

// Overflow-error phrasings → the limit is captured, not the "exceeded" count.
const OVERFLOW_PATTERNS = [
  /maximum(?:\s+[\w]+)?\s+context\s+(?:length|window)\s+of\s+([\d,]+)/i,
  /context[_ ]length[_ ]exceeded:\s*\d+\s*>\s*([\d,]+)/i,
  /configured\s+context\s+size\s+is\s+([\d,]+)/i,
  /available\s+context\s+size\s*(?:of\s*)?\(?([\d,]+)\)?/i,
  /exceeds? the (?:available )?context (?:size|length|window)(?: of)?\s*\(?\s*([\d,]+)/i,
];

// Probe sources that report the server's real runtime window — only these may
// EXPAND the configured window. Overflow-error learning reports a limit that
// was already exceeded and may therefore only tighten.
const EXPANSION_SOURCES = new Set([
  "llama.cpp /v1/models",
  "llama.cpp /slots|/props",
  "ollama /api/show",
]);

export function apply(ctx) {
  const log = ctx.logger;
  const disposers = [];

  // File-based diagnostic trace (independent of ctx.logger routing, which is
  // not visible on the web server console). Appended synchronously; failures
  // are swallowed so tracing can never break a hook.
  const TRACE_PATH =
    process.env.DSH_CTX_PROBE_TRACE ?? "C:/Users/IYI/Documents/DSH/ctx-probe-runtime.log";
  let traceOn = false;
  try {
    const dir = TRACE_PATH.slice(0, Math.max(TRACE_PATH.lastIndexOf("/"), TRACE_PATH.lastIndexOf("\\")));
    if (dir) mkdirSync(dir, { recursive: true });
    appendFileSync(TRACE_PATH, `\n--- ctx-probe process ${process.pid} start ${new Date().toISOString()} ---\n`);
    traceOn = true;
  } catch {
    traceOn = false;
  }
  function dbg(line) {
    if (!traceOn) return;
    try {
      appendFileSync(TRACE_PATH, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* never break the hook over tracing */
    }
  }

  /** (provider, model) → { value, source, at } */
  const probes = new Map();
  /** (provider, model) → Promise (single-flight) */
  const inflight = new Map();
  /** (provider, model) → { count, until } */
  const failures = new Map();
  /** agent ids awaiting a deferred post-tighten compaction */
  const pendingCompaction = new Set();

  log?.info?.("ctx-probe: plugin loaded (inject: settings, llm)");
  dbg(`apply(): loaded (trace=${traceOn}) settings.get(llm-pi-ai) type=${typeof ctx?.settings?.get}`);

  // ------------------------------------------------------------------ utils

  const keyFor = (provider, model) => `${provider}\u0000${model}`;

  function parseWindow(v) {
    if (typeof v === "number") return Number.isInteger(v) ? v : null;
    if (typeof v === "string" && /^\d[\d,]*$/.test(v)) return parseInt(v.replace(/,/g, ""), 10);
    return null;
  }

  function isCredibleWindow(n) {
    return Number.isInteger(n) && n >= MIN_CREDIBLE_WINDOW && n <= MAX_CREDIBLE_WINDOW;
  }

  /** Strip a trailing /v1 from an OpenAI-compatible baseURL to get the server root. */
  function serverRoot(baseUrl) {
    try {
      const u = new URL(baseUrl);
      const p = u.pathname.replace(/\/+$/, "");
      if (p === "/v1") u.pathname = "/";
      else if (p.endsWith("/v1")) u.pathname = p.slice(0, -3) || "/";
      return u.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  function openAiFace(baseUrl) {
    const trimmed = String(baseUrl).replace(/\/+$/, "");
    return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }

  async function fetchJson(url, signal, timeoutMs = PROBE_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const upstream = signal && typeof signal.addEventListener === "function" ? signal : null;
    const onAbort = () => ctrl.abort();
    if (upstream?.aborted) ctrl.abort();
    else upstream?.addEventListener?.("abort", onAbort);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
      if (upstream) upstream.removeEventListener?.("abort", onAbort);
    }
  }

  // ------------------------------------------------------------- probe sources

  async function probeLlamaModels(baseUrl, model, signal) {
    const data = await fetchJson(`${openAiFace(baseUrl)}/models`, signal);
    const entry = Array.isArray(data?.data) ? data.data.find((m) => m?.id === model) : undefined;
    // meta.n_ctx is the runtime context size; n_ctx_train is the model's trained size.
    return parseWindow(entry?.meta?.n_ctx);
  }

  async function probeLlamaSlots(baseUrl, model, signal) {
    const root = serverRoot(baseUrl);
    if (!root) return null;
    try {
      const body = await fetchJson(`${root}/slots`, signal);
      const slots = Array.isArray(body?.slots) ? body.slots : [];
      const withCtx = slots.find((s) => parseWindow(s?.n_ctx) !== null);
      const n = withCtx ? parseWindow(withCtx.n_ctx) : null;
      if (n) return n;
    } catch {
      /* slots endpoint missing — try props */
    }
    const props = await fetchJson(`${root}/props`, signal);
    return parseWindow(props?.n_ctx);
  }

  async function probeOllama(baseUrl, model, signal) {
    const root = serverRoot(baseUrl);
    if (!root) return null;
    const body = await fetchJson(`${root}/api/show?name=${encodeURIComponent(model)}`, signal);
    return parseWindow(body?.model_info?.["ollama.context.length"]);
  }

  /**
   * Resolve the configured route for `provider` from llm-pi-ai settings.
   * Returns the provider section (or undefined).
   */
  function routeProvider(provider) {
    try {
      const section = ctx.settings.get(LLM_NS);
      return section?.providers?.[provider];
    } catch {
      return undefined;
    }
  }

  async function runProbe(provider, model, signal) {
    const route = routeProvider(provider);
    const baseUrl = route?.baseURL;
    if (!baseUrl || typeof baseUrl !== "string") {
      log?.warn?.(`ctx-probe: no baseURL for provider ${provider}; cannot probe ${provider}/${model}`);
      return null;
    }
    const sources = [
      ["llama.cpp /v1/models", () => probeLlamaModels(baseUrl, model, signal)],
      ["llama.cpp /slots|/props", () => probeLlamaSlots(baseUrl, model, signal)],
      ["ollama /api/show", () => probeOllama(baseUrl, model, signal)],
    ];
    let lastErr = null;
    for (const [source, fn] of sources) {
      try {
        const value = await fn();
        if (value !== null && isCredibleWindow(value)) {
          return { value, source };
        }
        lastErr = new Error(`${source}: no usable context window`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("all probe sources failed");
  }

  const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

  /** Whether the provider's baseURL points at this machine (loopback). */
  function isLoopbackProvider(provider) {
    try {
      const baseUrl = routeProvider(provider)?.baseURL;
      if (typeof baseUrl !== "string") return false;
      const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
      return LOOPBACK_HOSTS.has(host);
    } catch {
      return false;
    }
  }

  /**
   * Probe with single-flight, exponential backoff and a TTL cache. Loopback
   * servers are re-probed on every `alwaysProbe` call so a server restart
   * (changed -c) is picked up by the very next model request; remote servers
   * keep the TTL cache. Returns { value, source, at } or null. Never throws.
   */
  async function ensureProbe(provider, model, signal, opts = {}) {
    const key = keyFor(provider, model);
    const now = Date.now();
    // Providers without an llm-pi-ai route have no probeable server — skip
    // quietly (e.g. catalog routes like deepseek-official).
    try {
      const baseUrl = routeProvider(provider)?.baseURL;
      if (typeof baseUrl !== "string") return null;
    } catch {
      return null;
    }
    const alwaysFresh = !!opts.alwaysProbe && isLoopbackProvider(provider);
    const backoff = failures.get(key);
    if (!opts.force && backoff && now < backoff.until) {
      dbg(`ensureProbe(${provider}/${model}): backing off until +${Math.round((backoff.until - now) / 1000)}s (attempt ${backoff.count})`);
      return null; // backing off
    }
    if (!opts.force && !alwaysFresh) {
      const hit = probes.get(key);
      if (hit && now - hit.at < PROBE_TTL_MS) {
        dbg(`ensureProbe(${provider}/${model}): cache hit value=${hit.value} age=${Math.round((now - hit.at) / 1000)}s`);
        return hit;
      }
    }
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        const result = await runProbe(provider, model, signal);
        if (!result || !isCredibleWindow(result.value)) throw new Error("no usable context window from any source");
        const hit = { ...result, at: Date.now() };
        probes.set(key, hit);
        failures.delete(key);
        log?.info?.(`ctx-probe: probed ${provider}/${model} → contextWindow ${hit.value} (${hit.source})`);
        dbg(`ensureProbe(${provider}/${model}): fresh probe → value=${hit.value} source=${hit.source}`);
        return hit;
      })().catch((err) => {
        const prev = failures.get(key);
        const count = (prev?.count ?? 0) + 1;
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_CAP_MS);
        failures.set(key, { count, until: Date.now() + delay });
        log?.warn?.(
          `ctx-probe: probe failed for ${provider}/${model} (attempt ${count}, backing off ${Math.round(delay / 1000)}s): ${err?.message ?? err}`,
        );
        dbg(`ensureProbe(${provider}/${model}): probe FAILED attempt=${count} err=${err?.message ?? err}`);
        return null;
      }).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, p);
    } else {
      dbg(`ensureProbe(${provider}/${model}): joining in-flight probe`);
    }
    return await p;
  }

  // ------------------------------------------------------------ settings write

  function findDescriptor() {
    try {
      const descs = ctx.settings.describe({ redactSecrets: true });
      return descs.find((d) => d?.ns === LLM_NS);
    } catch {
      return undefined;
    }
  }

  /** Currently effective window for the target, live first, config fallback. */
  async function currentEffective(provider, model, signal) {
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, signal);
      const w = info?.context?.contextWindow;
      if (isCredibleWindow(w)) {
        dbg(`currentEffective(${provider}/${model}): resolveModelInfo → ${w}`);
        return w;
      }
      dbg(`currentEffective(${provider}/${model}): resolveModelInfo returned no credible window (${JSON.stringify(info)?.slice(0, 120)})`);
    } catch (err) {
      dbg(`currentEffective(${provider}/${model}): resolveModelInfo threw: ${err?.message ?? err}`);
    }
    const desc = findDescriptor();
    const prov = desc?.user?.providers?.[provider];
    const models = Array.isArray(prov?.models) ? prov.models : [];
    const entry = models.find((m) => m?.id === model);
    const configured = parseWindow(entry?.contextWindow);
    if (isCredibleWindow(configured)) {
      dbg(`currentEffective(${provider}/${model}): config entry.contextWindow → ${configured}`);
      return configured;
    }
    const override = parseWindow(prov?.modelOverrides?.[model]?.contextWindow);
    if (isCredibleWindow(override)) {
      dbg(`currentEffective(${provider}/${model}): config modelOverrides → ${override}`);
      return override;
    }
    const routeDefault = parseWindow(prov?.defaultContextWindow);
    if (isCredibleWindow(routeDefault)) {
      dbg(`currentEffective(${provider}/${model}): route defaultContextWindow → ${routeDefault}`);
      return routeDefault;
    }
    dbg(`currentEffective(${provider}/${model}): no config value → DEFAULT ${DEFAULT_PI_WINDOW}`);
    return DEFAULT_PI_WINDOW;
  }

  /**
   * Keep the configured window in sync with the probed real runtime window —
   * both smaller (tighten) and larger (expand). Expansion is only ever allowed
   * from a trusted runtime probe source (llama.cpp /v1/models|/slots|/props
   * n_ctx or Ollama context length); overflow-error learning may only tighten.
   * Returns { applied, previous?, reason? }. Never throws.
   */
  async function writeWindow(provider, model, probed, agent, signal, source) {
    if (!isCredibleWindow(probed)) {
      dbg(`writeWindow(${provider}/${model}): probed ${probed} not credible → skip`);
      return { applied: false, reason: `probed value ${probed} not credible` };
    }
    let desc = findDescriptor();
    dbg(
      `writeWindow(${provider}/${model}): desc=${desc ? `found ns=${desc.ns} rev=${desc.revision}` : "NOT FOUND"} ` +
        `userHasProviders=${!!desc?.user?.providers}`,
    );
    if (!desc) {
      log?.warn?.(`ctx-probe: settings namespace ${LLM_NS} not registered; skipping write-back`);
      return { applied: false, reason: "namespace not registered" };
    }
    const effective = await currentEffective(provider, model, signal);
    dbg(`writeWindow(${provider}/${model}): probed=${probed} effective=${effective} source=${source ?? "(none)"}`);
    if (probed === effective) {
      log?.debug?.(
        `ctx-probe: no change for ${provider}/${model} (probed ${probed} == effective ${effective}); already in sync`,
      );
      return { applied: false, reason: "already-in-sync", previous: effective };
    }
    if (probed > effective && !(typeof source === "string" && EXPANSION_SOURCES.has(source))) {
      log?.info?.(
        `ctx-probe: probed ${probed} > effective ${effective} for ${provider}/${model} but source ${source ?? "(none)"} cannot expand; keeping ${effective}`,
      );
      return { applied: false, reason: "expansion-source-not-trusted", previous: effective };
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      // Rebuild the patch from the freshest descriptor each attempt. The
      // settings service's path ops (mutate/applyPathOp) cannot address array
      // elements — models[idx] is not a plain object, so a path op would drop
      // the whole models array and validation would reject. `update()` merges
      // (mergeLayers replaces arrays wholesale), so patch the models array via
      // a deep merge instead of a path write.
      const userProv = desc.user?.providers?.[provider];
      const models = Array.isArray(userProv?.models) ? userProv.models : [];
      const idx = models.findIndex((m) => m?.id === model);
      let patch;
      if (idx >= 0) {
        const nextModels = models.map((m, i) => (i === idx ? { ...m, contextWindow: probed } : m));
        patch = { providers: { [provider]: { models: nextModels } } };
        dbg(`writeWindow(${provider}/${model}): update patch models[${idx}].contextWindow=${probed} rev=${desc.revision}`);
      } else if (models.length === 0) {
        patch = { providers: { [provider]: { modelOverrides: { [model]: { contextWindow: probed } } } } };
        dbg(`writeWindow(${provider}/${model}): update patch modelOverrides.${model}.contextWindow=${probed} rev=${desc.revision}`);
      } else {
        log?.warn?.(
          `ctx-probe: model ${model} not listed under providers.${provider}.models; cannot write contextWindow`,
        );
        dbg(`writeWindow(${provider}/${model}): model not listed in models=[${models.map((m) => m?.id).join(",")}] → skip`);
        return { applied: false, reason: "model-not-listed" };
      }
      try {
        await ctx.settings.update(LLM_NS, patch, desc.revision);
        log?.info?.(
          `ctx-probe: wrote contextWindow ${probed} to ${LLM_NS} (providers.${provider} models); was ${effective}`,
        );
        dbg(`writeWindow(${provider}/${model}): update OK attempt=${attempt} value=${probed}`);
        probes.set(keyFor(provider, model), { value: probed, source: "settings-write", at: Date.now() });
        await maybeCompactAfterTighten(agent, probed, signal);
        return { applied: true, previous: effective };
      } catch (err) {
        dbg(`writeWindow(${provider}/${model}): update attempt=${attempt} failed code=${err?.code} msg=${err?.message ?? err}`);
        if (err?.code === "SETTINGS_CONFLICT" && attempt < 2) {
          const fresh = findDescriptor();
          if (!fresh) return { applied: false, reason: "namespace gone after conflict" };
          desc = fresh;
          const eff2 = await currentEffective(provider, model, signal);
          if (probed === eff2) {
            log?.info?.(`ctx-probe: conflict resolved by concurrent writer (effective now ${eff2}); nothing to do`);
            return { applied: false, reason: "already-in-sync", previous: eff2 };
          }
          continue; // retry with fresh revision
        }
        log?.warn?.(`ctx-probe: settings write-back failed: ${err?.message ?? err}`);
        return { applied: false, reason: "write-failed" };
      }
    }
    return { applied: false, reason: "conflict-retries-exhausted" };
  }

  // ---------------------------------------------------------- compaction hook

  function resolveMeter(agent) {
    try {
      const a = agent?.ctx?.get?.("tokenMeter");
      if (a) return a;
    } catch {
      /* keep falling back */
    }
    try {
      const h = ctx.get?.("tokenMeter");
      if (h) return h;
    } catch {
      /* keep falling back */
    }
    return ctx.tokenMeter ?? null;
  }

  function resolveCompaction(agent) {
    let svc = null;
    try {
      svc = agent?.ctx?.get?.("compaction");
    } catch {
      /* keep falling back */
    }
    if (!svc) {
      try {
        svc = ctx.get?.("compaction");
      } catch {
        /* keep falling back */
      }
    }
    if (!svc) svc = ctx.compaction ?? null;
    if (svc && typeof svc.compactNow !== "function") return null;
    return svc;
  }

  async function maybeCompactAfterTighten(agent, newWindow, signal) {
    if (!agent?.session) return;
    const meter = resolveMeter(agent);
    let usage = 0;
    try {
      usage = meter?.measure(agent.session)?.totalTokens ?? 0;
    } catch {
      usage = 0;
    }
    if (usage < PRESSURE_RATIO * newWindow) return;
    const svc = resolveCompaction(agent);
    if (!svc) {
      log?.warn?.(
        `ctx-probe: usage ${usage} >= ${PRESSURE_RATIO} x ${newWindow} but no compaction service resolvable; skipping immediate compaction`,
      );
      return;
    }
    try {
      const result = await svc.compactNow(agent, signal);
      log?.info?.(
        `ctx-probe: post-tighten compaction ${result ? "ran" : "no-op below threshold"} (usage ${usage} vs ${PRESSURE_RATIO} x ${newWindow})`,
      );
    } catch (err) {
      const busy = err?.code === "busy" || /busy/i.test(err?.message ?? "");
      if (busy) {
        pendingCompaction.add(agent.id ?? agent);
        log?.info?.("ctx-probe: agent busy; deferring compaction to next agent/pre-step");
      } else {
        log?.warn?.(`ctx-probe: compactNow failed: ${err?.message ?? err}`);
      }
    }
  }

  // ------------------------------------------------------------- agent events

  disposers.push(
    ctx.on("agent/request", async (payload, next) => {
      const config = await next();
      const provider = config?.provider;
      const model = config?.model;
      const signal = payload?.signal;
      dbg(
        `agent/request: provider=${provider ?? "(none)"} model=${model ?? "(none)"} aborted=${!!signal?.aborted} agentCtxGet=${typeof payload?.agent?.ctx?.get}`,
      );
      if (provider && model && !signal?.aborted) {
        try {
          // Loopback servers are re-probed on every request so a server restart
          // (changed -c, larger or smaller) is applied to settings immediately.
          const probe = await ensureProbe(provider, model, signal, { alwaysProbe: true });
          dbg(`agent/request: probe=${probe ? JSON.stringify({ v: probe.value, s: probe.source }) : "null"}`);
          if (probe) await writeWindow(provider, model, probe.value, payload?.agent, signal, probe.source);
        } catch (err) {
          dbg(`agent/request: handler threw: ${err?.message ?? err}`);
          log?.warn?.(`ctx-probe: probe/write-back failed for ${provider}/${model}: ${err?.message ?? err}`);
        }
      }
      return config;
    }),
  );

  disposers.push(
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      const k = agent?.id ?? agent;
      if (k !== undefined && pendingCompaction.has(k)) {
        pendingCompaction.delete(k);
        const svc = resolveCompaction(agent);
        if (svc && typeof svc.compactIfNeeded === "function") {
          try {
            const result = await svc.compactIfNeeded(agent, "pressure", signal);
            if (result) log?.info?.("ctx-probe: deferred post-tighten compaction ran at pre-step");
          } catch (err) {
            log?.warn?.(`ctx-probe: deferred compaction failed: ${err?.message ?? err}`);
          }
        }
      }
      return next();
    }),
  );

  function targetOf(agent) {
    try {
      const cfg = agent?.session?.requestHeader?.()?.config;
      if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model };
    } catch {
      /* fall through */
    }
    const opts = agent?.options;
    if (opts?.provider && opts?.model) return { provider: opts.provider, model: opts.model };
    return null;
  }

  function defaultTarget() {
    try {
      const d = ctx.settings.get("agent-default-model");
      if (d?.provider && d?.model) return { provider: d.provider, model: d.model };
    } catch {
      /* not registered */
    }
    return null;
  }

  function failureText(failure) {
    if (typeof failure === "string") return failure;
    return failure?.message ?? (failure ? String(failure) : "");
  }

  function isOverflowFailure(failure) {
    if (!failure) return false;
    const code = typeof failure.code === "string" ? failure.code.toLowerCase() : "";
    if (code.includes("context")) return true;
    const text = failureText(failure);
    return OVERFLOW_PATTERNS.some((re) => re.test(text));
  }

  /** Smallest credible limit mentioned in an overflow error. */
  function extractOverflowLimit(text) {
    if (!text) return null;
    const values = [];
    for (const re of OVERFLOW_PATTERNS) {
      const m = re.exec(text);
      if (m) values.push(parseWindow(m[1]));
    }
    const credible = values.filter((v) => isCredibleWindow(v));
    return credible.length ? Math.min(...credible) : null;
  }

  disposers.push(
    ctx.on("agent/request-error", async (payload, next) => {
      const action = await next();
      try {
        const { agent, failure } = payload ?? {};
        if (agent && isOverflowFailure(failure)) {
          const limit = extractOverflowLimit(failureText(failure));
          const target = targetOf(agent);
          if (limit !== null && target) {
            const key = keyFor(target.provider, target.model);
            const cur = probes.get(key);
            if (!cur || limit < cur.value) {
              probes.set(key, { value: limit, source: "overflow-error", at: Date.now() });
              log?.info?.(
                `ctx-probe: learned context limit ${limit} from overflow error for ${target.provider}/${target.model}`,
              );
              await writeWindow(target.provider, target.model, limit, agent, payload?.signal, "overflow-error");
            }
          }
        }
      } catch (err) {
        log?.warn?.(`ctx-probe: overflow learning failed: ${err?.message ?? err}`);
      }
      return action;
    }),
  );

  // ----------------------------------------------------- settings hot reload

  disposers.push(
    ctx.on("settings/document-updated", (ns) => {
      dbg(`settings/document-updated: ns=${ns}`);
      if (ns === LLM_NS) {
        probes.clear();
        failures.clear();
        log?.debug?.("ctx-probe: llm-pi-ai document changed; probe cache invalidated");
      }
    }),
  );

  // ---------------------------------------------------------- /ctx-probe cmd

  let commands = null;
  try {
    commands = ctx.get?.("commands") ?? ctx.commands ?? null;
  } catch {
    commands = null;
  }

  let disposed = false;
  let registered = false;
  let registerTimer = null;

  const tryRegisterCommand = () => {
    if (registered || disposed) return;
    if (!commands) {
      try {
        commands = ctx.get?.("commands") ?? ctx.commands ?? null;
      } catch {
        commands = null;
      }
    }
    if (!commands || typeof commands.register !== "function") {
      // The commands service may start after this plugin; retry until it is up.
      if (!disposed && registerTimer === null) {
        registerTimer = setTimeout(() => {
          registerTimer = null;
          tryRegisterCommand();
        }, 2000);
        registerTimer.unref?.();
      }
      return;
    }
    let reg;
    try {
      reg = commands.register({
        name: "ctx-probe",
        description:
          "Probe the local model server (llama.cpp/Ollama) for the real context window of the routed model and report configured vs effective vs probed values. Usage: /ctx-probe [force] [provider model]",
        handler: async (invocation) => {
          try {
            const raw = typeof invocation?.rawInput === "string" ? invocation.rawInput : "";
            const force = /\bforce\b/i.test(raw);
            const signal = invocation?.signal ?? null;
            const parts = raw.replace(/\bforce\b/gi, "").trim().split(/\s+/).filter(Boolean);
            let provider, model;
            if (parts.length >= 2) {
              provider = parts[0];
              model = parts[1];
            } else {
              const t = targetOf(invocation?.agent ?? null) ?? defaultTarget();
              if (!t) {
                return {
                  kind: "error",
                  text: "no provider/model selected. Usage: /ctx-probe [force] <provider> <model>",
                };
              }
              provider = t.provider;
              model = t.model;
            }

            let effective = null;
            try {
              effective = (await ctx.llm.resolveModelInfo(provider, model, signal))?.context?.contextWindow ?? null;
            } catch {
              effective = null;
            }

            let configured = null;
            try {
              const desc = findDescriptor();
              const prov = desc?.user?.providers?.[provider];
              const entry = Array.isArray(prov?.models) ? prov.models.find((m) => m?.id === model) : undefined;
              configured = parseWindow(entry?.contextWindow) ?? parseWindow(prov?.modelOverrides?.[model]?.contextWindow);
            } catch {
              configured = null;
            }

            const probe = await ensureProbe(provider, model, signal, { force });
            const lines = [`target: ${provider}/${model}`];
            lines.push(
              `configured: ${configured ?? "(unset)"}${configured != null ? " (explicit in settings)" : ""}`,
            );
            lines.push(`effective:  ${effective ?? "(unresolved)"}`);
            if (probe) {
              const age = Math.max(0, Math.round((Date.now() - probe.at) / 1000));
              lines.push(`probed:     ${probe.value} (${probe.source}, ${age}s ago)`);
              if (effective != null && probe.value !== effective) {
                lines.push("note: probed != effective — the next model call will sync settings automatically");
              } else if (effective != null && probe.value === effective) {
                lines.push("note: settings already match the probed window");
              }
            } else {
              lines.push("probed:     unavailable (probe failed or in backoff — see logs)");
            }
            return { kind: "success", text: lines.join("\n") };
          } catch (err) {
            return { kind: "error", text: `ctx-probe failed: ${err?.message ?? err}` };
          }
        },
      });
    } catch (err) {
      log?.warn?.(`ctx-probe: /ctx-probe registration failed: ${err?.message ?? err}`);
      return;
    }
    registered = true;
    if (typeof reg === "function") disposers.push(reg);
    else if (reg && typeof reg.dispose === "function") disposers.push(() => reg.dispose());
    log?.info?.("ctx-probe: /ctx-probe command registered");
    dbg("command /ctx-probe registered");
  };

  tryRegisterCommand();

  // --------------------------------------------------------------- disposal

  return () => {
    disposed = true;
    if (registerTimer !== null) {
      clearTimeout(registerTimer);
      registerTimer = null;
    }
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}
