# Domain Docs

How engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** - read ADRs that touch the area you're about to work in.

If either doesn't exist, **proceed silently**. The `/domain-modeling` skill creates them lazily when terms or decisions are actually resolved.

## File structure

This repository uses a single-context layout:

```
/
|-- CONTEXT.md
|-- docs/adr/
`-- src/
```

## Use the glossary's vocabulary

When output names a domain concept, use the term defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If a needed concept isn't in the glossary, reconsider whether it belongs or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
