import { rows } from './types';

// Emails, links and handles. Every address and domain is a reserved example one.
export const EMAIL_CASES = rows([
  ['email me at name@example.com', 'email me at [email]'],
  ['my email is first.last99@example.co.uk', 'my email is [email]'],
  ['name at example dot com', '[email]'],
  ['name (at) example (dot) com', '[email]'],
  ['name[at]example[dot]com', '[email]'],
  ['NAME AT EXAMPLE DOT COM', '[email]'],
  ['NAME@EXAMPLE.COM', '[email]'],
  ['send to a_b-c@school.example.edu.ng', 'send to [email]'],
  ['name at gmail', '[email]'],
  ['my mum is name@example.org and my dad too', 'my mum is [email] and my dad too'],
  ['mail: x.y@test-mail.example.', 'mail: [email].'],
]);

export const LINK_CASES = rows([
  ['go to https://example.com/page?x=1', 'go to [link]'],
  ['visit www.example.com', 'visit [link]'],
  ['see example.ly/abc123', 'see [link]'],
  ['example dot com', '[link]'],
  ['w w w dot example dot com', '[link]'],
  ['w w w . example . com', '[link]'],
  ['visit example.com now', 'visit [link] now'],
  ['example.com/path/to/page', '[link]'],
  ['go to my site dot com', 'go to my [link]'],
  ['example . com', '[link]'],
  ['HTTP://EXAMPLE.ORG', '[link]'],
  ['check example.ng', 'check [link]'],
  ['see http://example.com.', 'see [link].'],
  ['ftp://files.example.net/a', '[link]'],
  ['open (https://example.com)', 'open ([link])'],
  ['visit the dot com', 'visit [link]'],
  ['example.co.uk is cool', '[link] is cool'],
  ['sub.domain.example.org/x', '[link]'],
]);

export const HANDLE_CASES = rows([
  ['follow me @test_user99', 'follow me [handle]'],
  ['my insta is test_user_1', 'my insta is [handle]'],
  ['my username is test.user', 'my username is [handle]'],
  ['dm @testuser', 'dm [handle]'],
  ['snapchat: test_user.2', 'snapchat: [handle]'],
  ['add me @a.b.c', 'add me [handle]'],
]);
