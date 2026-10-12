import { rows } from './types';

// Typing tricks: invisible characters, case, odd separators, mixed kinds in one message.
export const OBFUSCATION_CASES = rows([
  ['0800\u200b000\u200b0000', '[phone]'],
  ['name\u200b@example.com', '[email]'],
  ['TeSt@ExAmPlE.CoM', '[email]'],
  ['0800 000 0000 or 0900 000 0000', '[phone] or [phone]'],
  ['mum 0800 000 0000, dad name@example.com', 'mum [phone], dad [email]'],
  ['visit EXAMPLE.COM or call 08000000000', 'visit [link] or call [phone]'],
  ['I live at 12 Test Street and my number is 08000000000', 'I live at [address] and my number is [phone]'],
  ['my name is Testa and my email is name@example.com', 'my name is [name] and my email is [email]'],
  ['wwW.Example.Com', '[link]'],
  ['0800_000_0000', '[phone]'],
  ['+234\u00a0800\u00a0000\u00a00000', '[phone]'],
  ['08000000000.', '[phone].'],
  ['"08000000000"', '"[phone]"'],
  ['call:08000000000', 'call:[phone]'],
]);
