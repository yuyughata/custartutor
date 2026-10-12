// The default cast: Zari and Zuri, from the facts the owner supplied on 2026-10-12 (OWNER_CAST_FACTS) plus
// guidance derived from AGE ONLY. The derived guidance is labelled as derived, makes no claim about personality,
// and is meant to be edited by the owner in the admin app's characters screen. The M2 migration seeds the same
// values into `characters.traits`.
import { OWNER_CAST_FACTS, type CastMember } from '../contract';

const ZARI_GUIDANCE =
  'Derived from age 7 (not supplied by the owner; may be adjusted): can usually read short sentences, count and add small numbers and follow a few steps in order. Her lines can be a little longer (up to about 10 words) and can give a simple reason with "because".';

const ZURI_GUIDANCE =
  'Derived from age, almost 5 (not supplied by the owner; may be adjusted): needs very simple words, one idea at a time and pictures. His lines are very short (about 3 to 6 words). Counting and naming things are comfortable; reading and writing are not expected yet.';

export const DEFAULT_CAST: CastMember[] = [
  {
    slug: 'zari',
    name: 'Zari',
    traits: { ...OWNER_CAST_FACTS['zari'], personality: [], derived_guidance: ZARI_GUIDANCE },
    voice: {},
  },
  {
    slug: 'zuri',
    name: 'Zuri',
    traits: { ...OWNER_CAST_FACTS['zuri'], personality: [], derived_guidance: ZURI_GUIDANCE },
    voice: {},
  },
];
