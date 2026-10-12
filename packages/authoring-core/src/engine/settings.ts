// Per-step defaults: reasoning effort and the output budget. The model itself is chosen inside the adapter from
// `settings.models`; the engine only names the task ('authoring') and these two knobs.
import type { AiSettings, Effort } from '../contract';

/**
 * Default effort by step family. Overridable with `settings.effort[<family>]` (for example
 * `"unit_generate:section": "xhigh"`). Writing steps get `high` because lesson quality is what the owner
 * judges; transcription, titles, workbook, manual and review are bounded tasks at `medium`.
 */
export const DEFAULT_EFFORT: Record<string, Effort> = {
  'scheme_ingest:extract': 'medium',
  'chapter_plan:title': 'medium',
  'unit_generate:outline': 'high',
  'unit_generate:section': 'high',
  'unit_generate:workbook': 'medium',
  'unit_generate:manual': 'medium',
  'unit_generate:review': 'medium',
  'unit_generate:repair': 'high',
  'unit_generate:draft': 'high',
  'unit_revise:patch': 'high',
  'unit_revise:review': 'medium',
};

/**
 * Output budget per step family. Thinking tokens count against `max_tokens`, so these leave room for the
 * model to think. All stay below the adapter's non-streaming limit (21,333), so no step streams.
 */
export const MAX_OUTPUT_TOKENS: Record<string, number> = {
  'scheme_ingest:extract': 16000,
  'chapter_plan:title': 12000,
  'unit_generate:outline': 10000,
  'unit_generate:section': 20000,
  'unit_generate:workbook': 16000,
  'unit_generate:manual': 16000,
  'unit_generate:review': 10000,
  'unit_generate:repair': 20000,
  'unit_generate:draft': 20000,
  'unit_revise:patch': 20000,
  'unit_revise:review': 10000,
};

export function effortFor(settings: AiSettings, family: string): Effort {
  return settings.effort[family] ?? DEFAULT_EFFORT[family] ?? 'medium';
}

export function maxTokensFor(family: string): number {
  return MAX_OUTPUT_TOKENS[family] ?? 12000;
}
