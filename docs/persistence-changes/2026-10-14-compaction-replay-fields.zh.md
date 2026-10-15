---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-14-compaction-replay-fields

[English](2026-10-14-compaction-replay-fields.md) | 中文

## 概述

为 compaction/summary 事件添加可选的 replayScope 和 replayBoundarySeq 字段，使替换了回放会话输入的摘要后端能够持久记录模型实际看到的会话前缀。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-14-compaction-replay-fields
baseline: false
changes:
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "b0bbd551ecb3bad4d5130fa5a038bfd8dd2c064e4dc64914339e897f81a00b85"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。两个字段同时缺失时，保持由 shadowedSeqs 固定的默认 shadowed-head 回放语义；已发布的后端从不写入它们，读取方不得从缺失中推断其他情况。存在时遵循事件负载声明的配对与读取重建规则。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/compaction/compaction-basic/tests/manual-compaction.spec.ts：35 个测试通过，包含两个新增的写入/省略透传用例。

<a id="dev-note"></a>
## 开发备注

无。
