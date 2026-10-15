---
description: "Warm-prefix compaction backend: summarizes against the full conversation surface when the routed route reports prefix-cache reuse, so condensation reads the same prompt prefix the conversation just paid for."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-warm

English | [中文](README.zh.md)

## Summary

This package is a drop-in replacement for `@deepseek-ai/dsh-compaction-basic` whose summarization request reuses the conversation's provider prefix cache. The base summarizes only the region being condensed, a fresh prompt the provider has never seen; this backend instead sends the entire live conversation surface ahead of the compaction instruction, so a warm route bills the shared history as cached input. Every other behavior — triggers, thresholds, the region transaction, `/compact` — is the base's. When the warm call cannot be issued or fails, the engine degrades to the base's head replay with no user-visible change.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package in place of `@deepseek-ai/dsh-compaction-basic` — it provides the same `ctx.compaction` service. In a profile patch, disable the base row and insert this one; in a preset, restate the compaction group's backend row with this package name.

### Smallest working composition

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-warm'
```

### Configuration

The engine accepts every option of `@deepseek-ai/dsh-compaction-basic` (see that package for the shared keys) plus three of its own:

| Option | Default | Meaning |
|---|---|---|
| `warm` | `true` | Attempt the full-surface warm replay before falling back to the base's head replay. |
| `warmProviders` | `` (empty) | Comma-separated lowercase provider allowlist; empty allows every provider. |
| `warmRequireReportedCache` | `false` | Require the newest assistant usage event to report a positive `cacheReadTokens` before issuing the warm call. |

### When the warm path is refused

The engine issues no warm call and uses the base's behavior when any gate fails; each refusal is logged as `compaction-warm: path=refused reason=<code>`:

| Reason | Condition |
|---|---|
| `disabled` | `warm: false`. |
| `provider_not_allowed` | The routed provider is outside `warmProviders`. |
| `no_routed_request` | No durable route to target: neither a configured summarization pair nor a `request/header` event exists, or the adapter cannot resolve the route. |
| `reported_cache_zero` | `warmRequireReportedCache` is set and the newest reported usage shows zero cached read tokens. |
| `capacity` | The conversation plus the summary budget does not fit the routed context window, or the route declares no window. |
| `unbalanced_live_tail` | The live tail ends in an unanswered tool call, so no balanced full-surface cut exists. |

A warm call that is issued but fails degrades to the head replay once (`path=degraded`); cancellation is rethrown unchanged.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design philosophy

The package extends `BasicCompactionEngine` and overrides only its protected `summarize` hook, so the region transaction, triggers, shrink validation, and durable events stay identical. The warm decision is a pure attempt-then-degrade addition: correctness never depends on the provider's cache behavior.

### What the warm replay sends

`buildFullSurfaceInput` reconstructs the model-visible surface: the system head, then every projected surface message up to the last node — including the live tail the base's head replay omits — plus the header's tool schemas. The summary it elicits is still a strict replacement for the selected region; the tail is replayed only to keep the request prefix identical to the conversation's, and durable compaction semantics are unchanged.

### Replay fields

A summary produced from the full surface records `replayScope: 'full-surface'` and `replayBoundarySeq` (the surface node the replay was anchored at) on the `compaction/summary` event. Head-replay summaries omit both fields, so the durable log always says which prompt built the summary.

### Route selection

The warm call targets the configured `summarizationProvider`/`summarizationModel` pair when both are set, otherwise the route in the session's latest `request/header`. Capacity is priced as session tokens plus the summary budget plus a fixed instruction reserve against the resolved context window.

### Source map

| File | Role |
|---|---|
| `src/index.ts` | The engine: gates, warm attempt, degrade path, replay fields. |
| `src/warm-replay.ts` | Full-surface input builder and its balance check. |
| `src/config.ts` | Warm-key extraction ahead of base validation. |
| `src/types.ts` | Configuration and replay types. |

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary summarizer request

#### What the model sees

Identical to the base's summarizer request — the same ordered history and the same final compaction instruction — sent under `purpose: 'compaction'`, except that on the warm path the history is the complete surface rather than the selected region.

#### Token effect

The warm attempt prices the complete surface, so it refuses before issuing a call when that input plus the `maxTokens` summary budget no longer fits the routed context window; the head replay it falls back to prices only the selected region. Either path issues one ordinary `ctx.llm.stream()` request, so durable `assistant/message`-style usage accounting is unchanged for conversation turns.

#### KV Cache effect

The warm request reuses the conversation's provider prefix cache, so the shared history is billed at cached-input rates where the provider reports `cacheReadTokens`. The base's head replay starts a fresh prefix and pays full input price.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Providers that report no cache usage make `warmRequireReportedCache` refuse every warm attempt; leave it off unless the route reports usage.
- The warm call prices the whole conversation, so long sessions near the context window routinely refuse on `capacity` and condense through the base path.

<a id="dev-note"></a>
### Dev Note

The replay fields ride the optional-payload seam recorded in `docs/persistence-changes/2026-10-14-compaction-replay-fields`; readers that ignore them see base behavior. The engine is covered by unit specs (gates, degrade, cancellation) and a real Loader-composition spec that mounts it through `cordis.yml`, including through an agent-preset group and a deployment `patches` layer.
