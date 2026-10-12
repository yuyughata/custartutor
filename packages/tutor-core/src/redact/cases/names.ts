import { rows } from './types';

// Names. "Testa", "Sampleton" and friends are invented, not real people.
export const NAME_CASES = rows([
  ['my name is Testa', 'my name is [name]'],
  ['my name is testa sample', 'my name is [name]'],
  ['My name is Testa Sample Example', 'My name is [name]'],
  ['i am called Testa', 'i am called [name]'],
  ['call me Testa', 'call me [name]'],
  ["I'm Testa", "I'm [name]"],
  ['I am Testa', 'I am [name]'],
  ['this is Testa speaking', 'this is [name] speaking'],
  ['my name na Testa', 'my name na [name]'],
  ['dem dey call me Testa', 'dem dey call me [name]'],
  ['na Testa be my name', 'na [name] be my name'],
  ['Orukọ mi ni Testa', 'Orukọ mi ni [name]'],
  ['Aha m bụ Testa', 'Aha m bụ [name]'],
  ['Sunana Testa', 'Sunana [name]'],
  ['my surname is Sample', 'my surname is [name]'],
  ['my first name is Testa', 'my first name is [name]'],
  ['my teacher is Mrs Sample', 'my teacher is [name]'],
  ['my mum name is Testa', 'my mum name is [name]'],
  ['Mr Sample taught us', 'Mr [name] taught us'],
  ['Aunty Testa is nice', 'Aunty [name] is nice'],
  ['my uncle Testa came', 'my uncle [name] came'],
  ['my friend Testa is here', 'my friend [name] is here'],
  ['Mama Testa sells yams', 'Mama [name] sells yams'],
  ['They call me Testa at school', 'They call me [name] at school'],
  ["I'm Testa and my number is 0800 000 0000", "I'm [name] and my number is [phone]"],
  ['everybody dey call me Testa', 'everybody dey call me [name]'],
  ['Dr Sample is my doctor', 'Dr [name] is my doctor'],
  ['my name is Testa.', 'my name is [name].'],
]);

const OBI = ['Testa Sample'];

export const KNOWN_NAME_CASES = rows([
  ['Testa said hi', '[name] said hi', OBI],
  ['TESTA said hi', '[name] said hi', OBI],
  ["Testa's book", "[name]'s book", OBI],
  ['Sample is my class', '[name] is my class', OBI],
  ['testa sample is here', '[name] is here', OBI],
  ['Tèstá is here', '[name] is here', OBI],
  ['I saw Testa and Sample today', 'I saw [name] and [name] today', OBI],
  ['it was Testa, then Sample.', 'it was [name], then [name].', OBI],
  ['my brother Zed went home', 'my brother [name] went home', ['Zed']],
  ['ZED!', '[name]!', ['Zed']],
  ['Ọlá is my name', '[name] is my name', ['Ola']],
]);
