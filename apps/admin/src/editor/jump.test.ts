import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { describeLocation, jumpPlan, keys, tabForKind, tabsFor } from './jump';

const unit = goldenUnit2 as unknown;

describe('jumpPlan', () => {
  it('opens the section and block that hold a field', () => {
    const id = (unit as { sections: { id: string }[] }).sections[1]?.id ?? '';
    const plan = jumpPlan(unit, ['sections', 1, 'blocks', 2, 'text']);
    expect(plan.tab).toBe('sections');
    expect(plan.open).toEqual([keys.section(id), keys.block(id, 2)]);
  });

  it('opens a section and its tutor script and node', () => {
    const withScript = (unit as { sections: { id: string; tutor_script?: { nodes: { id: string }[] } }[] }).sections.findIndex(
      (s) => s.tutor_script,
    );
    expect(withScript).toBeGreaterThanOrEqual(0);
    const section = (unit as { sections: { id: string; tutor_script: { nodes: { id: string }[] } }[] }).sections[withScript]!;
    const plan = jumpPlan(unit, ['sections', withScript, 'tutor_script', 'nodes', 0, 'say']);
    expect(plan.open).toEqual([
      keys.section(section.id),
      keys.script(`sec:${section.id}`),
      keys.node(`sec:${section.id}`, section.tutor_script.nodes[0]!.id),
    ]);
  });

  it('sends question paths to the questions tab and opens the question', () => {
    expect(jumpPlan(unit, ['questions', 'q_name', 'answer'])).toEqual({
      tab: 'questions',
      open: [keys.question('q_name')],
    });
  });

  it('sends the other parts of a lesson to their tabs', () => {
    expect(jumpPlan(unit, ['session_plan', 0, 'minutes']).tab).toBe('plan');
    expect(jumpPlan(unit, ['session_plan', 0, 'minutes']).open).toEqual([keys.period(0)]);
    expect(jumpPlan(unit, ['workbook', 'tiers', 0]).tab).toBe('workbook');
    expect(jumpPlan(unit, ['teacher_manual', 'script', 2, 'say'])).toEqual({
      tab: 'manual',
      open: [keys.manualRow(2)],
    });
    expect(jumpPlan(unit, ['teacher_manual', 'helper_script', 1, 'steps'])).toEqual({
      tab: 'manual',
      open: [keys.helperRow(1)],
    });
    expect(jumpPlan(unit, ['header', 'title']).tab).toBe('overview');
  });

  it('sends project parts to the project tab and unknown paths to the overview', () => {
    expect(jumpPlan(unit, ['steps', 0, 'text']).tab).toBe('project');
    expect(jumpPlan(unit, ['rubric', 1, 'criterion'])).toEqual({ tab: 'project', open: [keys.rubric(1)] });
    expect(jumpPlan(unit, [])).toEqual({ tab: 'overview', open: [] });
    expect(jumpPlan(unit, ['scoring', 'pass_mark']).tab).toBe('overview');
  });

  it('falls back to the overview when the unit kind has no such tab', () => {
    expect(tabsFor('assessment')).not.toContain('plan');
    expect(tabForKind('assessment', jumpPlan(unit, ['session_plan', 0]))).toBe('overview');
    expect(tabForKind('lesson', jumpPlan(unit, ['session_plan', 0]))).toBe('plan');
  });
});

describe('describeLocation', () => {
  it('says where a problem is in words', () => {
    const heading = (unit as { sections: { heading: string }[] }).sections[1]?.heading ?? '';
    expect(describeLocation(unit, ['sections', 1, 'blocks', 2, 'text'])).toBe(`Section 2 (${heading.length > 32 ? `${heading.slice(0, 31).trimEnd()}…` : heading}), block 3`);
    expect(describeLocation(unit, ['questions', 'q_name', 'answer'])).toBe('Question q_name');
    expect(describeLocation(unit, ['session_plan', 0])).toBe('Session plan, period 1');
    expect(describeLocation(unit, ['teacher_manual', 'helper_script', 1])).toBe("Teacher's manual, helper script row 2");
    expect(describeLocation(unit, ['header', 'title'])).toBe('Overview, header');
    expect(describeLocation(unit, [])).toBe('The unit');
    expect(describeLocation(unit, ['sections', 99, 'blocks', 0])).toBe('Section 100, block 1');
  });
});
