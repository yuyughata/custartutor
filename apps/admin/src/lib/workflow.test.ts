import { describe, expect, it } from 'vitest';
import { versionStatusStyle, workflowActions, type WorkflowInput } from './workflow';

const base: WorkflowInput = {
  status: 'draft',
  role: 'super_admin',
  lintBlocking: false,
  isLatest: true,
};
const actions = (patch: Partial<WorkflowInput>) => workflowActions({ ...base, ...patch });
const byId = (patch: Partial<WorkflowInput>) =>
  Object.fromEntries(actions(patch).map((action) => [action.id, action]));

describe('workflowActions', () => {
  it('offers only "Submit for review" on a draft', () => {
    expect(actions({}).map((a) => a.id)).toEqual(['submit']);
    expect(byId({}).submit?.to).toBe('in_review');
    expect(byId({}).submit?.enabled).toBe(true);
  });

  it('blocks submitting a draft with lint errors and says why', () => {
    const submit = byId({ lintBlocking: true }).submit;
    expect(submit?.enabled).toBe(false);
    expect(submit?.reason).toMatch(/lint errors/i);
  });

  it('offers approve and send back on a version in review, for reviewers', () => {
    const result = byId({ status: 'in_review', role: 'reviewer' });
    expect(Object.keys(result)).toEqual(['approve', 'send_back']);
    expect(result.approve?.enabled).toBe(true);
    expect(result.approve?.to).toBe('approved');
    expect(result.send_back?.to).toBe('draft');
    expect(result.send_back?.enabled).toBe(true);
  });

  it('disables approval for a content editor and names the roles that can', () => {
    const result = byId({ status: 'in_review', role: 'content_editor' });
    expect(result.approve?.enabled).toBe(false);
    expect(result.approve?.reason).toBe('Needs the super admin or reviewer role.');
    expect(result.send_back?.enabled).toBe(false);
  });

  it('does not let a version with lint errors be approved', () => {
    const result = byId({ status: 'in_review', role: 'reviewer', lintBlocking: true });
    expect(result.approve?.enabled).toBe(false);
    expect(result.send_back?.enabled).toBe(true);
  });

  it('offers publish only for an approved version', () => {
    expect(actions({ status: 'approved' }).map((a) => a.id)).toEqual(['publish']);
    for (const status of ['draft', 'in_review'] as const) {
      expect(actions({ status }).some((a) => a.id === 'publish')).toBe(false);
    }
  });

  it('blocks publishing when lint errors exist, even on an approved version', () => {
    const publish = byId({ status: 'approved', lintBlocking: true }).publish;
    expect(publish?.enabled).toBe(false);
  });

  it('has no publish shortcut: a draft can never be published directly', () => {
    for (const status of ['draft', 'in_review', 'approved', 'published', 'superseded'] as const) {
      for (const role of [
        'super_admin',
        'content_editor',
        'reviewer',
        'support',
        'analyst',
      ] as const) {
        const ids = workflowActions({ ...base, status, role }).map((a) => a.id);
        if (ids.includes('publish')) expect(status).toBe('approved');
      }
    }
  });

  it('offers nothing for published, superseded or older versions', () => {
    expect(actions({ status: 'published' })).toEqual([]);
    expect(actions({ status: 'superseded' })).toEqual([]);
    expect(actions({ status: 'draft', isLatest: false })).toEqual([]);
  });

  it('disables everything for roles without access', () => {
    expect(byId({ role: 'support' }).submit?.enabled).toBe(false);
    expect(byId({ role: 'analyst', status: 'approved' }).publish?.enabled).toBe(false);
  });

  it('styles statuses with a glyph as well as a label', () => {
    expect(versionStatusStyle('approved')).toMatchObject({ label: 'Approved', glyph: '✓' });
    expect(versionStatusStyle('mystery')).toMatchObject({ label: 'mystery' });
  });
});
