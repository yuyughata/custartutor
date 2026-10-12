// The stable system prefix. Pure functions of the job KIND and the cast: nothing about the unit being written
// (those facts come after the cache breakpoint, in the user message). So every call of every step of a job
// sends byte-identical system text, and every unit job with the same cast shares it too.
import type { CastMember, LlmSystemBlock } from '../contract';
import { renderCastBible } from './cast';
import { renderExemplar } from './exemplar';
import {
  DATA_RULE,
  INGEST_RULES,
  PLAN_RULES,
  ROLE_INGEST,
  ROLE_PLAN,
  ROLE_UNIT,
  RULES_CORE,
  SESSION_SHAPE,
  STAGE_AND_VOICE,
  UNIT_MODE_NOTE,
} from './rules';
import { SCHEMA_GUIDE } from './schemaGuide';

export type PrefixMode = 'ingest' | 'plan' | 'unit';

function join(parts: readonly string[]): string {
  return parts.join('\n\n');
}

export function buildSystemPrefix(mode: PrefixMode, cast: readonly CastMember[]): string {
  switch (mode) {
    case 'ingest':
      return join([ROLE_INGEST, DATA_RULE, INGEST_RULES]);
    case 'plan':
      return join([
        ROLE_PLAN,
        DATA_RULE,
        RULES_CORE,
        STAGE_AND_VOICE,
        PLAN_RULES,
        renderCastBible(cast),
      ]);
    case 'unit':
      return join([
        ROLE_UNIT,
        DATA_RULE,
        RULES_CORE,
        STAGE_AND_VOICE,
        SESSION_SHAPE,
        UNIT_MODE_NOTE,
        SCHEMA_GUIDE,
        renderCastBible(cast, { withExemplar: true }),
        renderExemplar(),
      ]);
  }
}

/** The system blocks of a request. One block, marked as the end of the cacheable prefix. */
export function buildSystem(mode: PrefixMode, cast: readonly CastMember[]): LlmSystemBlock[] {
  return [{ text: buildSystemPrefix(mode, cast), cache: true }];
}
