import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLES,
  canOpenRoute,
  CAPABILITIES,
  can,
  isAdminRole,
  roleLabel,
  rolesFor,
  visibleNav,
  whyNot,
} from './roles';

describe('role matrix', () => {
  it('knows the five roles', () => {
    expect(ADMIN_ROLES).toEqual([
      'super_admin',
      'content_editor',
      'reviewer',
      'support',
      'analyst',
    ]);
    expect(isAdminRole('reviewer')).toBe(true);
    expect(isAdminRole('owner')).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });

  it('lets the super admin do everything', () => {
    for (const capability of CAPABILITIES) expect(can('super_admin', capability)).toBe(true);
  });

  it('keeps approval and scheme approval away from content editors', () => {
    expect(can('content_editor', 'version.review')).toBe(false);
    expect(can('content_editor', 'scheme.approve')).toBe(false);
    expect(can('reviewer', 'version.review')).toBe(true);
    expect(can('reviewer', 'scheme.approve')).toBe(true);
  });

  it('keeps writing away from reviewers', () => {
    expect(can('reviewer', 'scheme.save')).toBe(false);
    expect(can('reviewer', 'plan.apply')).toBe(false);
    expect(can('reviewer', 'job.start')).toBe(false);
    expect(can('reviewer', 'characters.edit')).toBe(false);
    expect(can('reviewer', 'version.publish')).toBe(true);
  });

  it('gives support and analyst no content access', () => {
    for (const capability of CAPABILITIES) {
      if (capability === 'usage.view') continue;
      expect(can('support', capability)).toBe(false);
      expect(can('analyst', capability)).toBe(false);
    }
    expect(can('analyst', 'usage.view')).toBe(true);
    expect(can('support', 'usage.view')).toBe(false);
  });

  it('lets only the super admin edit settings', () => {
    expect(rolesFor('settings.edit')).toEqual(['super_admin']);
    expect(can('content_editor', 'settings.edit')).toBe(false);
    expect(can('content_editor', 'settings.view')).toBe(true);
  });

  it('treats a missing role as no access', () => {
    expect(can(null, 'content.view')).toBe(false);
    expect(can(undefined, 'usage.view')).toBe(false);
  });

  it('explains what is missing in words', () => {
    expect(whyNot('reviewer', 'scheme.save')).toBe('Needs the super admin or content editor role.');
    expect(whyNot('super_admin', 'scheme.save')).toBeNull();
    expect(whyNot('support', 'version.review')).toBe('Needs the super admin or reviewer role.');
    expect(whyNot(null, 'settings.edit')).toBe('Needs the super admin role.');
    expect(roleLabel('content_editor')).toBe('Content editor');
  });

  it('shows each role only the navigation it can use', () => {
    const ids = (role: Parameters<typeof visibleNav>[0]) => visibleNav(role).map((item) => item.id);
    expect(ids('super_admin')).toEqual(['schemes', 'characters', 'usage', 'jobs']);
    expect(ids('reviewer')).toEqual(['schemes', 'characters', 'usage', 'jobs']);
    expect(ids('analyst')).toEqual(['usage']);
    expect(ids('support')).toEqual([]);
    expect(ids(null)).toEqual([]);
  });
});

describe('canOpenRoute', () => {
  it('opens home and the preview for every signed-in role', () => {
    for (const role of ADMIN_ROLES) {
      expect(canOpenRoute(role, '/')).toBe(true);
      expect(canOpenRoute(role, '/preview/golden-unit-2')).toBe(true);
    }
    expect(canOpenRoute(null, '/')).toBe(false);
  });

  it('keeps content pages for content staff', () => {
    for (const path of [
      '/schemes',
      '/schemes/new',
      '/schemes/abc/chapters',
      '/units/abc',
      '/jobs/abc',
      '/characters',
    ]) {
      expect(canOpenRoute('reviewer', path)).toBe(true);
      expect(canOpenRoute('analyst', path)).toBe(false);
      expect(canOpenRoute('support', path)).toBe(false);
    }
  });

  it('opens usage for analysts and settings readers', () => {
    expect(canOpenRoute('analyst', '/usage')).toBe(true);
    expect(canOpenRoute('reviewer', '/usage')).toBe(true);
    expect(canOpenRoute('support', '/usage')).toBe(false);
  });

  it('does not mistake a longer name for a content route', () => {
    expect(canOpenRoute('support', '/schemes-archive')).toBe(true);
  });
});
