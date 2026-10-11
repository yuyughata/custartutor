import { describe, expect, it } from 'vitest';
import { goldenUnit2, colourChartProject } from './fixtures';
import {
  PackManifest,
  appCanReadPack,
  compareAppVersions,
  filesForPack,
  hasTeacherManual,
  joinUnitFromPacks,
  PackPath,
  packTotalBytes,
  parseGrownupContent,
  parseLearnerContent,
  splitUnitForPacks,
  STRIPPED_TEACHER_MANUAL,
  verifyManifestIntegrity,
} from './pack';
import { parseUnit } from './parse';
import { clone } from './test-utils';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const UNIT_ID = '11111111-1111-4111-8111-111111111111';

function manifest(): PackManifest {
  return {
    pack_version: 1,
    unit_id: UNIT_ID,
    version_no: 2,
    schema_version: 1,
    min_app_version: '1.0.0',
    content_hash: SHA_C,
    learner_content_path: 'learner.json',
    grownup_content_path: 'grownup.json',
    files: [
      { path: 'learner.json', sha256: SHA_A, bytes: 1000, kind: 'content', pack: 'learner' },
      { path: 'grownup.json', sha256: SHA_B, bytes: 200, kind: 'content', pack: 'grownup' },
      { path: 'media/zari.webp', sha256: SHA_C, bytes: 5000, kind: 'media', pack: 'learner' },
      {
        path: 'audio/zari.mp3',
        sha256: 'd'.repeat(64),
        bytes: 7000,
        kind: 'audio',
        pack: 'learner',
      },
    ],
  };
}

describe('PackManifest', () => {
  it('accepts a well formed manifest', () => {
    expect(PackManifest.safeParse(manifest()).success).toBe(true);
  });

  it('rejects hostile or malformed paths', () => {
    for (const path of ['../x', '/etc/passwd', 'a/../b', '.hidden', 'a//b', 'a\\b', '', 'a/']) {
      expect(PackPath.safeParse(path).success, path).toBe(false);
    }
    for (const path of ['learner.json', 'media/zari_waves.webp', 'a/b/c-1.2.json']) {
      expect(PackPath.safeParse(path).success, path).toBe(true);
    }
  });

  it('rejects a bad hash, version or pack_version', () => {
    const bad = (patch: Record<string, unknown>) =>
      PackManifest.safeParse({ ...manifest(), ...patch }).success;
    expect(bad({ content_hash: 'xyz' })).toBe(false);
    expect(bad({ min_app_version: 'v1' })).toBe(false);
    expect(bad({ pack_version: 2 })).toBe(false);
    expect(bad({ version_no: 0 })).toBe(false);
    expect(bad({ files: [] })).toBe(false);
  });

  it('allows a null grown-up path', () => {
    const m = manifest();
    m.grownup_content_path = null;
    m.files = m.files.filter((file) => file.pack !== 'grownup');
    expect(PackManifest.safeParse(m).success).toBe(true);
    expect(verifyManifestIntegrity(m)).toEqual([]);
  });
});

describe('verifyManifestIntegrity', () => {
  it('is clean for a sound manifest', () => {
    expect(verifyManifestIntegrity(manifest())).toEqual([]);
  });

  it('reports duplicate paths, missing and mis-typed content files', () => {
    const m = manifest();
    m.files.push({ ...m.files[2]!, sha256: 'e'.repeat(64) });
    expect(verifyManifestIntegrity(m).join('\n')).toContain('duplicate path "media/zari.webp"');

    const missing = manifest();
    missing.learner_content_path = 'nope.json';
    expect(verifyManifestIntegrity(missing).join('\n')).toContain('"nope.json" is not listed');

    const wrongPack = manifest();
    wrongPack.files[0]!.pack = 'grownup';
    expect(verifyManifestIntegrity(wrongPack).join('\n')).toContain('must be a learner-pack');
  });

  it('reports unreferenced content, empty content and conflicting blob sizes', () => {
    const m = manifest();
    m.files.push({ path: 'extra.json', sha256: SHA_A, bytes: 5, kind: 'content', pack: 'learner' });
    expect(verifyManifestIntegrity(m).join('\n')).toContain('"extra.json" is not referenced');

    const empty = manifest();
    empty.files[0]!.bytes = 0;
    expect(verifyManifestIntegrity(empty).join('\n')).toContain('is empty');

    const conflict = manifest();
    conflict.files.push({
      path: 'media/zari2.webp',
      sha256: SHA_C,
      bytes: 1,
      kind: 'media',
      pack: 'learner',
    });
    expect(verifyManifestIntegrity(conflict).join('\n')).toContain('two different sizes');
  });

  it('refuses media under blobs/ and a grown-up file with a null grown-up path', () => {
    const m = manifest();
    m.files[2]!.path = 'blobs/zari.webp';
    expect(verifyManifestIntegrity(m).join('\n')).toContain('must not live under blobs/');

    const nullPath = manifest();
    nullPath.grownup_content_path = null;
    expect(verifyManifestIntegrity(nullPath).join('\n')).toContain('lists grown-up files');
  });
});

describe('packTotalBytes', () => {
  it('sums per pack and for all', () => {
    const m = manifest();
    expect(packTotalBytes(m, 'learner')).toBe(1000 + 5000 + 7000);
    expect(packTotalBytes(m, 'grownup')).toBe(200);
    expect(packTotalBytes(m, 'all')).toBe(13200);
    expect(filesForPack(m, 'grownup')).toHaveLength(1);
  });

  it('counts a shared blob once', () => {
    const m = manifest();
    m.files.push({ ...m.files[2]!, path: 'media/zari_copy.webp' });
    expect(packTotalBytes(m, 'learner')).toBe(1000 + 5000 + 7000);
  });
});

describe('app versions', () => {
  it('compares numerically per segment', () => {
    expect(compareAppVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareAppVersions('1.0', '1.0.0')).toBe(0);
    expect(compareAppVersions('0.9.9', '1.0.0')).toBeLessThan(0);
    expect(appCanReadPack('1.2.0', '1.2.0')).toBe(true);
    expect(appCanReadPack('1.1.9', '1.2.0')).toBe(false);
  });
});

describe('splitUnitForPacks', () => {
  const unit = parseUnit(goldenUnit2);

  it('moves the teacher manual to the grown-up pack and keeps everything else', () => {
    const { learner, grownup } = splitUnitForPacks(unit);
    expect('teacher_manual' in learner).toBe(false);
    expect(grownup?.teacher_manual).toEqual(unit.kind === 'lesson' ? unit.teacher_manual : null);
    expect(learner.kind).toBe('lesson');
    if (learner.kind === 'lesson') {
      expect(learner.questions).toEqual(unit.kind === 'lesson' ? unit.questions : null);
      expect(learner.workbook).toBeDefined();
      expect(learner.sections.length).toBeGreaterThan(5);
    }
  });

  it('keeps the answers in the learner pack (offline grading needs them)', () => {
    const { learner } = splitUnitForPacks(unit);
    const json = JSON.stringify(learner);
    expect(json).toContain('"answer"');
    expect(json).not.toContain('helper_script');
  });

  it('makes the learner pack strictly smaller than the whole unit', () => {
    const { learner, grownup } = splitUnitForPacks(unit);
    const whole = JSON.stringify(unit).length;
    expect(JSON.stringify(learner).length).toBeLessThan(whole);
    expect(JSON.stringify(grownup).length).toBeGreaterThan(100);
  });

  it('round trips through JSON, parseLearnerContent and joinUnitFromPacks', () => {
    const { learner, grownup } = splitUnitForPacks(unit);
    const learnerOnDisk: unknown = JSON.parse(JSON.stringify(learner));
    const grownupOnDisk: unknown = JSON.parse(JSON.stringify(grownup));

    const learnerOnly = parseLearnerContent(learnerOnDisk);
    expect(hasTeacherManual(learnerOnly)).toBe(false);
    expect(learnerOnly.kind === 'lesson' && learnerOnly.teacher_manual).toEqual(
      STRIPPED_TEACHER_MANUAL,
    );

    const joined = joinUnitFromPacks(learnerOnly, parseGrownupContent(grownupOnDisk));
    expect(hasTeacherManual(joined)).toBe(true);
    expect(joined).toEqual(unit);
  });

  it('returns no grown-up content for a project and parses it as before', () => {
    const project = parseUnit(colourChartProject);
    const { learner, grownup } = splitUnitForPacks(project);
    expect(grownup).toBeNull();
    expect(learner).toBe(project);
    expect(parseLearnerContent(clone(learner))).toEqual(project);
    expect(joinUnitFromPacks(project, null)).toBe(project);
  });

  it('parseLearnerContent still accepts a unit that kept its manual', () => {
    expect(parseLearnerContent(clone(unit))).toEqual(unit);
  });

  it('parseLearnerContent degrades unknown blocks like parseUnitLenient', () => {
    const { learner } = splitUnitForPacks(unit);
    const raw = clone(learner);
    const first = raw.kind === 'lesson' ? raw.sections[0] : undefined;
    expect(first).toBeDefined();
    first!.blocks.push({ type: 'hologram', data: 1 } as never);
    const parsed = parseLearnerContent(raw);
    const blocks = parsed.kind === 'lesson' ? parsed.sections[0]!.blocks : [];
    expect(blocks[blocks.length - 1]).toMatchObject({ type: 'unknown', original_type: 'hologram' });
  });

  it('parseGrownupContent rejects a malformed manual', () => {
    expect(() => parseGrownupContent({ schema_version: 1, kind: 'lesson' })).toThrow();
  });
});
