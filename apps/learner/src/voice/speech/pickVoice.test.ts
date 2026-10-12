import { describe, expect, it } from 'vitest';
import { normalizeLang, pickVoice, type VoiceInfo } from './pickVoice';

const v = (identifier: string, language: string, quality?: string): VoiceInfo => ({
  identifier,
  language,
  ...(quality ? { quality } : {}),
});

describe('normalizeLang', () => {
  it('lowercases and uses hyphens', () => {
    expect(normalizeLang('en_NG')).toBe('en-ng');
    expect(normalizeLang(' EN-gb ')).toBe('en-gb');
  });
});

describe('pickVoice', () => {
  it('prefers the exact language tag, whatever the separator or case', () => {
    const voices = [v('us', 'en-US'), v('ng', 'en_NG'), v('gb', 'en-GB')];
    expect(pickVoice(voices, 'en-NG')?.identifier).toBe('ng');
  });

  it('falls back to nearby English: GB before US', () => {
    const voices = [v('us', 'en-US'), v('gb', 'en-GB'), v('fr', 'fr-FR')];
    expect(pickVoice(voices, 'en-NG')?.identifier).toBe('gb');
    expect(pickVoice([v('us', 'en-US'), v('fr', 'fr-FR')], 'en-NG')?.identifier).toBe('us');
  });

  it('accepts a bare language voice for a regional request', () => {
    expect(pickVoice([v('en', 'en')], 'en-NG')?.identifier).toBe('en');
  });

  it('prefers an enhanced voice among equals', () => {
    const voices = [v('plain', 'en-GB', 'Default'), v('rich', 'en-GB', 'Enhanced')];
    expect(pickVoice(voices, 'en-GB')?.identifier).toBe('rich');
  });

  it('returns null when no voice speaks the language', () => {
    expect(pickVoice([v('fr', 'fr-FR')], 'en-NG')).toBeNull();
    expect(pickVoice([], 'en-NG')).toBeNull();
  });

  it('works for a language with no fallback table', () => {
    expect(pickVoice([v('yo', 'yo-NG'), v('en', 'en-NG')], 'yo')?.identifier).toBe('yo');
  });
});
