---
title: Alpha
status: active
---
# Alpha

Alpha is the internal search service.

## Plan

Rebuild the vector index before the migration. The migration moves every document to the new schema.

## Risks

The migration can double the storage while both schemas live.

## Decisions

We keep the lexical fallback when the embedding service is down.
