import { rows } from './types';

// Addresses and schools. "Test Street" and friends are invented.
export const ADDRESS_CASES = rows([
  ['I live at 12 Test Street', 'I live at [address]'],
  ['my address is 5 Sample Road, Testville', 'my address is [address]'],
  ['no. 5 Sample Avenue', '[address]'],
  ['No 7 Example Close', '[address]'],
  ['Plot 12 Sample Estate', '[address]'],
  ['Block 5, Flat 3', '[address]'],
  ['I stay in Testville', 'I stay in [address]'],
  ['I dey stay for Testville', 'I dey stay for [address]'],
  ['na for Testville I dey stay', 'na for [address] I dey stay'],
  ['my house dey for Sample Phase 1', 'my house dey for [address]'],
  ['my address na 7 Test Road Samplestate', 'my address na [address]'],
  ['We live at Sample Estate Testville and my uncle', 'We live at [address] and my uncle'],
  ['i live in Testville', 'i live in [address]'],
  ['He lives near 15 Example Thomas Road', 'He lives near [address]'],
  ['I live on 3 Test Street', 'I live on [address]'],
  ['we stay for Sampleton', 'we stay for [address]'],
  ['my home address is 4 Test Lane', 'my home address is [address]'],
  ['I live at 2B Sample Crescent, Testville, Samplestate', 'I live at [address]'],
  ['my school dey for Testville', 'my school dey for [address]'],
  ['I am living in Example Heights', 'I am living in [address]'],
]);

export const SCHOOL_CASES = rows([
  ["I go to St Test's Primary School", 'I go to [school]'],
  ['my school is Sample Academy', 'my school is [school]'],
  ['I go to Example College.', 'I go to [school].'],
  ['I dey go to Sample Hope Academy', 'I dey go to [school]'],
  ['my school name is Test Heights Nursery School', 'my school name is [school]'],
  ['I attend Sample Stars School and I like it', 'I attend [school] and I like it'],
  ['I am a pupil of Example Primary School', 'I am a pupil of [school]'],
  ['we go to Sample Montessori', 'we go to [school]'],
]);
