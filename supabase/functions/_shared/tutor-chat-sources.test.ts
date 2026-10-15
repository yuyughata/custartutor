// Tripwires on the SOURCES of the `tutor-chat` function and its migrations: nothing in the handler may log or print a
// child's words, the SQL defaults are the contract's defaults, the consent version of the database is the contract's, and
// the settings key list of the database is the contract's.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contract from '../../../packages/tutor-core/src/contract';

const SHARED = __dirname;
const MIGRATIONS = join(__dirname, '../../migrations');
const read = (path: string): string => readFileSync(path, 'utf8');
/** The code of a source file: its comments removed. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

const HANDLER_SOURCES = [
  'tutor-chat-handler.ts',
  'tutor-chat-context.ts',
  'tutor-chat-errors.ts',
  'tutor-chat-types.ts',
].map((name) => join(SHARED, name));

function migration(name: string): string {
  const file = readdirSync(MIGRATIONS).find((entry) => entry.endsWith(`_${name}.sql`));
  expect(file, `a migration named ${name}`).toBeDefined();
  return read(join(MIGRATIONS, file as string));
}

describe('the handler never prints', () => {
  it('has no console.* call in the handler, the context reader, the errors or the types', () => {
    for (const path of HANDLER_SOURCES) {
      expect(code(path), path).not.toMatch(/\bconsole\s*\./);
      expect(read(path), path).not.toMatch(/\bconsole\s*\./);
    }
  });

  it('never hands the message text to the logger', () => {
    for (const path of HANDLER_SOURCES) {
      const calls = read(path)
        .split('\n')
        .filter((line) => /\blog\(/.test(line) || /\blog\??\.?\(/.test(line));
      for (const line of calls) {
        expect(line, `${path}: ${line.trim()}`).not.toMatch(/input\.text|message\.text|child_text|\.text\b|reply_text|\bbody\b|rawBody/);
      }
    }
  });

  it('keeps the Deno glue to one structured log line that goes through the same logger', () => {
    const glue = read(join(SHARED, '../tutor-chat/index.ts'));
    const consoleCalls = glue.split('\n').filter((line) => /\bconsole\s*\./.test(line));
    expect(consoleCalls).toHaveLength(1);
    expect(consoleCalls[0]).toContain("fn: 'tutor-chat'");
  });

  it('never imports the raw SDK, a key or the vendored model code into the handler (only the glue does)', () => {
    for (const path of HANDLER_SOURCES) {
      expect(code(path), path).not.toMatch(/ANTHROPIC_API_KEY|@anthropic-ai|vendor\//);
    }
  });
});

describe('the database and the contract agree', () => {
  const settingsSql = migration('m3_tutor_settings_and_roles');

  it('has the contract\'s default for every setting', () => {
    const defaults = new Map<string, unknown>();
    const pattern = /when '([a-z_.]+)' then\s*'((?:[^']|'')*)'::jsonb/g;
    for (const match of settingsSql.matchAll(pattern)) {
      defaults.set(match[1] as string, JSON.parse((match[2] as string).replace(/''/g, "'")));
    }
    const d = contract.DEFAULT_TUTOR_SETTINGS;
    expect(Object.fromEntries(defaults)).toEqual({
      'tutor.enabled': d.enabled,
      'tutor.daily_turns_per_child': d.daily_turns_per_child,
      'tutor.retention_days': d.retention_days,
      'tutor.output_check': d.output_check,
      'tutor.max_history_turns': d.max_history_turns,
      'tutor.max_reply_tokens': d.max_reply_tokens,
      'tutor.persona_name': d.persona_name,
      'tutor.safe_replies': d.safe_replies,
      'tutor.helpline': d.helpline,
      'safeguarding.owner': d.owner,
      'safeguarding.sla_hours': d.sla_hours,
      'safeguarding.guardian_visible_categories': d.guardian_visible_categories,
    });
  });

  it('accepts exactly the contract\'s settings keys', () => {
    const check = /app_settings_key_check check \(\s*key in \(([\s\S]*?)\)\s*\)/.exec(settingsSql);
    expect(check).not.toBeNull();
    const keys = [...(check![1] as string).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    expect(keys.filter((key) => /^(tutor|safeguarding)\./.test(key as string)).sort()).toEqual(
      [...contract.TUTOR_SETTING_KEYS].sort(),
    );
    // and the RPC accepts the same list
    const rpcList = /p_key not in \(([\s\S]*?)\)\s*then/.exec(settingsSql);
    const rpcKeys = [...(rpcList![1] as string).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    expect(rpcKeys).toEqual(keys);
  });

  it('requires the contract\'s consent version and its scope', () => {
    const rpcs = migration('m3_tutor_rpcs');
    const version = /tutor_required_consent_version\(\)[\s\S]*?select '([^']+)'::text/.exec(rpcs);
    expect(version?.[1]).toBe(contract.CURRENT_TUTOR_CONSENT_VERSION);
    expect(rpcs).toContain(`scope = '${contract.TUTOR_CONSENT_SCOPE}'`);
    expect(rpcs).toContain(`'${contract.TUTOR_CONSENT_SCOPE}', p_version, p_action`);
  });

  it('knows the contract\'s moderation categories, severities and safe-reply keys', () => {
    const rpcs = migration('m3_tutor_rpcs');
    const tables = migration('m3_tutor_tables');
    for (const category of contract.MODERATION_CATEGORIES) {
      expect(rpcs).toContain(`'${category}'`);
      expect(tables).toContain(`'${category}'`);
    }
    for (const key of contract.SAFE_REPLY_KEYS) expect(settingsSql).toContain(`"${key}"`);
    for (const status of contract.TURN_STATUSES) expect(tables).toContain(`'${status}'`);
    for (const action of contract.SAFETY_ACTIONS) expect(rpcs).toContain(`'${action}'`);
  });

  it('puts every migration of this package under the version the server assigned', () => {
    const names = readdirSync(MIGRATIONS).filter((entry) => /_m3_/.test(entry));
    expect(names.map((name) => name.replace(/^\d{14}_/, '')).sort()).toEqual(
      [
        'm3_safeguarding_rpcs.sql',
        'm3_tutor_purge_schedule.sql',
        'm3_tutor_rpcs.sql',
        'm3_tutor_settings_and_roles.sql',
        'm3_tutor_tables.sql',
      ],
    );
    // in the order they must run
    expect(names.map((name) => name.replace(/^\d{14}_/, ''))).toEqual([
      'm3_tutor_tables.sql',
      'm3_tutor_settings_and_roles.sql',
      'm3_tutor_rpcs.sql',
      'm3_safeguarding_rpcs.sql',
      'm3_tutor_purge_schedule.sql',
    ]);
  });
});
