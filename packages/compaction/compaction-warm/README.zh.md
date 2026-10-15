---
description: "热前缀压缩（compaction）后端：当路由到的模型报告前缀缓存复用时，对完整会话表面进行摘要，使压缩读取会话刚刚付费的同一提示前缀。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-warm

[English](README.md) | 中文

## 概述

本包是 `@deepseek-ai/dsh-compaction-basic` 的直接替换后端，让摘要请求复用会话的提供方前缀缓存。基础后端只对将要压缩的区域做摘要——那是一个提供方从未见过的新提示；本后端改为在压缩指令之前发送完整的活动会话表面，使拥有热前缀缓存的路由把共享历史按缓存输入计价，而不是全价。其余行为——触发器、阈值、区域事务与 `/compact`——全部沿用基础后端。当热调用无法发出或失败时，引擎无损降级到基础后端的头部重放，用户不可察觉。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包挂载到 `@deepseek-ai/dsh-compaction-basic` 原处——它提供同样的 `ctx.compaction` 服务。在 profile 补丁中禁用基础行并插入本包；在 preset 中，把压缩组内后端行的包名改为本包。

### 最小可用组合

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-warm'
```

### 配置

引擎接受 `@deepseek-ai/dsh-compaction-basic` 的全部选项（共享键见该包文档），外加三个自有选项：

| 选项 | 默认值 | 含义 |
|---|---|---|
| `warm` | `true` | 在回落到基础后端的头部重放之前，先尝试全表面热重放。 |
| `warmProviders` | 空（允许全部） | 逗号分隔的小写提供方白名单；为空允许所有提供方。 |
| `warmRequireReportedCache` | `false` | 要求最新的 assistant usage 事件报告为正的 `cacheReadTokens`，否则不发出热调用。 |

### 热路径被拒绝的情形

任一门槛失败时，引擎不发出热调用并使用基础后端行为；每次拒绝记录日志 `compaction-warm: path=refused reason=<code>`：

| 原因 | 条件 |
|---|---|
| `disabled` | `warm: false`。 |
| `provider_not_allowed` | 路由到的提供方不在 `warmProviders` 白名单内。 |
| `no_routed_request` | 没有可定位的持久路由：既无配置的摘要 provider/model 对，也无 `request/header` 事件，或适配器无法解析该路由。 |
| `reported_cache_zero` | 设置了 `warmRequireReportedCache`，且最新上报的 usage 显示缓存读取为零。 |
| `capacity` | 会话加摘要预算放不下路由的上下文窗口，或该路由未声明窗口。 |
| `unbalanced_live_tail` | 活动尾部以未应答的工具调用结尾，不存在平衡的全表面切点。 |

已发出的热调用失败时降级一次到头部重放（`path=degraded`）；取消会原样抛出。

<a id="understand-the-implementation"></a>
## 理解实现

### 设计理念

本包扩展 `BasicCompactionEngine` 且只覆写其 protected 的 `summarize` 钩子，因此区域事务、触发器、收缩校验与持久事件完全一致。热决策是纯粹的“先尝试、再降级”叠加：正确性从不依赖提供方的缓存行为。

### 热重放发送的内容

`buildFullSurfaceInput` 重建模型可见表面：系统头，随后是到最后一个节点为止的每一条投影表面消息——包括基础后端头部重放所省略的活动尾部——外加请求头的工具 schema。它换来的摘要仍然只是所选区域的严格替换；重放尾部只是为了让请求前缀与会话完全一致，持久压缩语义不变。

### 重放字段

由全表面产生的摘要在 `compaction/summary` 事件上记录 `replayScope: 'full-surface'` 与 `replayBoundarySeq`（重放锚定的表面节点）。头部重放的摘要省略这两个字段，因此持久日志总能说明摘要出自哪个提示。

### 路由选择

热调用优先瞄准配置的 `summarizationProvider`/`summarizationModel` 对（两者都设置时），否则瞄准会话最新 `request/header` 的路由。容量计价为：会话 token 加摘要预算加固定指令预留，对照解析出的上下文窗口。

### 源码地图

| 文件 | 角色 |
|---|---|
| `src/index.ts` | 引擎：门槛、热尝试、降级路径、重放字段。 |
| `src/warm-replay.ts` | 全表面输入构建器及其平衡检查。 |
| `src/config.ts` | 先于基础校验剥离热配置键。 |
| `src/types.ts` | 配置与重放类型。 |

-----

<a id="model-experience"></a>
## 模型体验

### 辅助摘要请求

#### 模型看到的内容

与基础后端的摘要请求完全一致——相同的有序历史与相同的最终压缩指令——以 `purpose: 'compaction'` 发送——仅热路径的历史是完整表面而非所选区域。

#### Token 影响

热尝试对完整表面议价，因此当该输入加 `maxTokens` 摘要预算不再容得下路由的上下文窗口时，它会在发出调用前拒绝；其回退的头部重放只对所选区域议价。任一路径都只发一次普通 `ctx.llm.stream()` 请求，会话轮次的持久 usage 记账不变。

#### KV 缓存效果

热请求复用会话的提供方前缀缓存，在提供方上报 `cacheReadTokens` 处共享历史按缓存输入计价。基础后端的头部重放开新前缀，按全价支付输入。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 不上报缓存用量的提供方会让 `warmRequireReportedCache` 拒绝一切热尝试；除非路由上报 usage，否则保持关闭。
- 热调用对整段会话计价，因此接近上下文窗口的长会话常以 `capacity` 被拒并经基础路径压缩。

<a id="dev-note"></a>
### 开发备注

重放字段沿用 `docs/persistence-changes/2026-10-14-compaction-replay-fields` 记录的可选载荷接缝；忽略它们的读取方看到基础行为。引擎由单元测试（门槛、降级、取消）与一个通过 `cordis.yml` 真实挂载本包的 Loader 组合测试覆盖，后者也经由 agent-preset 组与部署 `patches` 层装配。
