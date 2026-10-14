---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-14-compaction-replay-fields

English | [中文](2026-10-14-compaction-replay-fields.zh.md)

## Summary

Adds optional replayScope and replayBoundarySeq fields to the compaction/summary event so a summarizer backend that replaced the replayed conversation input durably records which surface prefix the model saw.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid. Absence of both fields preserves the default shadowed-head replay pinned by shadowedSeqs; the shipped backends never write them, and readers infer nothing from their absence. Presence follows the payload-declared pairing and reader reconstruction rule.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/compaction/compaction-basic/tests/manual-compaction.spec.ts: 35 tests passed, including the two new append/omit passthrough cases.

<a id="dev-note"></a>
## Dev Note

None.
