# ADR 0006: The unit template wins over the brief's "2 to 3 enrichment sections"

Status: accepted (owner decision, 2026-10-12)

## Context

The Master Development Brief (principle 7 and section 7) says a unit uses the core plus **two or three** enrichment
sections from a rotating menu, "so depth never bloats the day". The P1 Basic Science Unit 2 template the owner
supplied carries **five** sections tagged ENRICH: Come and Explore!, Remember?, Do & Discover, Keeping Our
Environment Clean, and Tell It Back & My Notebook. The two documents disagree, and the lint rule built from the brief
(an error outside 2 to 3) rejected the template.

## Decision

**The template wins.**

- A lesson uses **2 to 5** sections from the enrichment menu, each type at most once. The lint rule
  `enrichment_count` is an error outside that range and silent inside it (`ENRICHMENT_MIN` / `ENRICHMENT_MAX` in
  `packages/content-schema/src/lint.ts`).
- The golden Unit 2 keeps all five template sections as printed. "Keeping Our Environment Clean" is typed
  `character_values` and "Tell It Back & My Notebook" is typed `tell_it_back`. The workbook's application task is the
  template's "Take It Home".
- The rotation warning (`enrichment_not_rotated`) stays: consecutive units should still vary their menu choices.
- The AI authoring prompts (M2) tell Claude to use 2 to 5 enrichment sections and give the golden unit as the model
  of rhythm and density.
- `docs/brief/` is the owner's source document and is left unchanged. This ADR supersedes the brief for the
  **count only**.

## What does not change

NERDC stays dominant and visible; every always-present section is still required (concept, worked examples,
practice, Think Deeper, quick-fire, mastery check); enrichment still adds and never replaces an objective; a unit
must still fit its one-hour periods (the timing lint stays), so more enrichment means splitting a unit across more
periods rather than lengthening the hour.

## Consequences

- Units can be richer, and the template is the authoritative shape.
- The over-stacking risk the brief warns about is now managed by the timing lint and human review, not a hard cap
  of three.
- The template's own "Tell It Back" prompt is one long sentence, so the golden unit carries one accepted
  `reading_level` warning (plus `no_global_window`).
- Small unrelated difference noted, not changed: the brief tags Think Deeper CORE+ and the template prints CORE.
  They share the same teal bar, so children see no difference.
