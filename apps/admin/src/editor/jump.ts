// "Jump to the field": which tab of the editor a problem (or a link in the summary panel) lives on, and which cards
// have to be open for its field to be on the page. Pure, so the mapping is tested; the screen opens the cards, shows
// the tab and moves the focus (platform/focusField).
import type { UnitKind } from '@custar/content-schema';
import { getAt, type Path } from './path';

export type EditorTab = 'overview' | 'project' | 'sections' | 'questions' | 'plan' | 'workbook' | 'manual';

export const TAB_LABELS: Record<EditorTab, string> = {
  overview: 'Overview',
  project: 'The project',
  sections: 'Sections',
  questions: 'Questions',
  plan: 'Session plan',
  workbook: 'Workbook',
  manual: "Teacher's manual",
};

/** The tabs of a unit of this kind, in order. Projects have no session plan, workbook or manual of their own. */
export function tabsFor(kind: UnitKind): EditorTab[] {
  switch (kind) {
    case 'lesson':
      return ['overview', 'sections', 'questions', 'plan', 'workbook', 'manual'];
    case 'mini_project':
    case 'term_project':
      return ['overview', 'project', 'sections', 'questions'];
    default:
      return ['overview', 'sections', 'questions'];
  }
}

// --- the keys of the cards (so jump, the open/closed state and the tests agree) ---------------------------------------
export const keys = {
  section: (id: string): string => `sec:${id}`,
  block: (sectionId: string, index: number): string => `sec:${sectionId}:blk:${index}`,
  script: (scope: string): string => `script:${scope}`,
  node: (scope: string, nodeId: string): string => `node:${scope}:${nodeId}`,
  question: (id: string): string => `q:${id}`,
  period: (index: number): string => `period:${index}`,
  variant: (id: string): string => `variant:${id}`,
  manualRow: (index: number): string => `man:script:${index}`,
  helperRow: (index: number): string => `man:helper:${index}`,
  lens: (index: number): string => `man:lens:${index}`,
  rubric: (index: number): string => `rubric:${index}`,
  group: (name: string): string => `group:${name}`,
};

export interface JumpPlan {
  tab: EditorTab;
  /** Card keys to open, outermost first. */
  open: string[];
}

function stringAt(unit: unknown, path: Path): string {
  const value = getAt(unit, path);
  return typeof value === 'string' ? value : '';
}

export function jumpPlan(unit: unknown, path: Path): JumpPlan {
  const root = path[0];
  switch (root) {
    case 'sections': {
      const index = path[1];
      if (typeof index !== 'number') return { tab: 'sections', open: [] };
      const sectionId = stringAt(unit, ['sections', index, 'id']);
      const open = [keys.section(sectionId)];
      if (path[2] === 'blocks' && typeof path[3] === 'number') open.push(keys.block(sectionId, path[3]));
      if (path[2] === 'tutor_script') {
        const scope = `sec:${sectionId}`;
        open.push(keys.script(scope));
        if (path[3] === 'nodes' && typeof path[4] === 'number') {
          open.push(keys.node(scope, stringAt(unit, ['sections', index, 'tutor_script', 'nodes', path[4], 'id'])));
        }
      }
      return { tab: 'sections', open };
    }
    case 'questions': {
      const id = path[1];
      return { tab: 'questions', open: typeof id === 'string' ? [keys.question(id)] : [] };
    }
    case 'session_plan':
      return { tab: 'plan', open: typeof path[1] === 'number' ? [keys.period(path[1])] : [] };
    case 'workbook': {
      const open: string[] = [];
      if (path[1] === 'practice_variants' && typeof path[2] === 'number') {
        open.push(keys.variant(stringAt(unit, ['workbook', 'practice_variants', path[2], 'id'])));
      }
      return { tab: 'workbook', open };
    }
    case 'teacher_manual': {
      const open: string[] = [];
      const index = path[2];
      if (typeof index === 'number') {
        if (path[1] === 'script') open.push(keys.manualRow(index));
        if (path[1] === 'helper_script') open.push(keys.helperRow(index));
      }
      if (path[1] === 'theme_map' && path[2] === 'lenses' && typeof path[3] === 'number') open.push(keys.lens(path[3]));
      return { tab: 'manual', open };
    }
    case 'tutor_script': {
      const open = [keys.script('project')];
      if (path[1] === 'nodes' && typeof path[2] === 'number') {
        open.push(keys.node('project', stringAt(unit, ['tutor_script', 'nodes', path[2], 'id'])));
      }
      return { tab: 'project', open };
    }
    case 'brief':
    case 'steps':
    case 'materials':
    case 'evidence_options':
    case 'reflection_prompts':
      return { tab: 'project', open: [] };
    case 'rubric':
      return { tab: 'project', open: typeof path[1] === 'number' ? [keys.rubric(path[1])] : [] };
    default:
      return { tab: 'overview', open: [] };
  }
}

/** The tab a path lives on when the unit is of this kind; falls back to the overview if the kind has no such tab. */
export function tabForKind(kind: UnitKind, plan: JumpPlan): EditorTab {
  return tabsFor(kind).includes(plan.tab) ? plan.tab : 'overview';
}

// --- where a problem is, in words -------------------------------------------------------------------------------------

function snippet(text: string, max = 32): string {
  const plain = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** "Section 3 (Practice time), block 2" for a path, so the summary panel says where each problem is. */
export function describeLocation(unit: unknown, path: Path): string {
  const root = path[0];
  switch (root) {
    case undefined:
      return 'The unit';
    case 'header':
      return 'Overview, header';
    case 'scoring':
      return 'Overview, scoring';
    case 'sections': {
      const index = path[1];
      if (typeof index !== 'number') return 'Sections';
      const heading = snippet(stringAt(unit, ['sections', index, 'heading']));
      let out = `Section ${index + 1}${heading ? ` (${heading})` : ''}`;
      if (path[2] === 'blocks' && typeof path[3] === 'number') out += `, block ${path[3] + 1}`;
      if (path[2] === 'tutor_script') {
        out += ', tutor script';
        if (path[3] === 'nodes' && typeof path[4] === 'number') out += `, line ${path[4] + 1}`;
      }
      return out;
    }
    case 'questions': {
      const id = path[1];
      return typeof id === 'string' ? `Question ${id}` : 'Questions';
    }
    case 'session_plan':
      return typeof path[1] === 'number' ? `Session plan, period ${path[1] + 1}` : 'Session plan';
    case 'workbook':
      return 'Workbook';
    case 'teacher_manual': {
      if (path[1] === 'script' && typeof path[2] === 'number') return `Teacher's manual, script row ${path[2] + 1}`;
      if (path[1] === 'helper_script' && typeof path[2] === 'number') return `Teacher's manual, helper script row ${path[2] + 1}`;
      return "Teacher's manual";
    }
    case 'tutor_script':
      return typeof path[2] === 'number' ? `Project tutor script, line ${path[2] + 1}` : 'Project tutor script';
    case 'steps':
      return typeof path[1] === 'number' ? `Project step ${path[1] + 1}` : 'Project steps';
    case 'rubric':
      return typeof path[1] === 'number' ? `Rubric, criterion ${path[1] + 1}` : 'Rubric';
    case 'brief':
    case 'materials':
    case 'evidence_options':
    case 'reflection_prompts':
      return 'The project';
    default:
      return String(root);
  }
}
