// Turns a lint or review path such as `sections[3].blocks[1]`, `questions.q_name.answer` or `workbook.tiers`
// into a place in the preview: which tab to show and which section heading to scroll to.

export type PreviewTab = 'textbook' | 'workbook' | 'manual';

export interface JumpTarget {
  tab: PreviewTab;
  /** The section's heading text, used to find it on the page. */
  heading?: string;
  sectionId?: string;
  /** For the button: "Section 4: Practice time", "Workbook", "Teacher's manual". */
  label: string;
}

export type PathSegment = string | number;

/** `sections[3].blocks[1]` -> ['sections', 3, 'blocks', 1]; `questions["q-1"].answer` is handled too. */
export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g;
  for (const match of path.matchAll(pattern)) {
    if (match[1] !== undefined) segments.push(match[1]);
    else if (match[2] !== undefined) segments.push(Number(match[2]));
    else if (match[3] !== undefined) segments.push(match[3].replace(/\\(.)/g, '$1'));
  }
  return segments;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sectionsOf(unit: unknown): Rec[] {
  return isRec(unit) && Array.isArray(unit.sections) ? unit.sections.filter(isRec) : [];
}

function sectionTarget(section: Rec, index: number): JumpTarget {
  const heading = typeof section.heading === 'string' ? section.heading : undefined;
  const sectionId = typeof section.id === 'string' ? section.id : undefined;
  return {
    tab: 'textbook',
    ...(heading ? { heading } : {}),
    ...(sectionId ? { sectionId } : {}),
    label: `Section ${index + 1}${heading ? `: ${heading}` : ''}`,
  };
}

export function jumpTarget(path: string | undefined, unit: unknown): JumpTarget | null {
  if (!path) return null;
  const segments = parsePath(path);
  const head = segments[0];
  const sections = sectionsOf(unit);

  if (head === 'sections') {
    const next = segments[1];
    if (typeof next === 'number') {
      const section = sections[next];
      return section ? sectionTarget(section, next) : { tab: 'textbook', label: 'Textbook' };
    }
    if (typeof next === 'string') {
      const index = sections.findIndex((section) => section.id === next);
      const section = sections[index];
      if (section) return sectionTarget(section, index);
    }
    return { tab: 'textbook', label: 'Textbook' };
  }

  if (head === 'questions') {
    const id = segments[1];
    if (typeof id === 'string') {
      const index = sections.findIndex(
        (section) =>
          Array.isArray(section.blocks) &&
          section.blocks.some((block) => isRec(block) && block.type === 'question' && block.question_id === id),
      );
      const section = sections[index];
      if (section) return sectionTarget(section, index);
    }
    return { tab: 'workbook', label: 'Workbook' };
  }

  if (head === 'workbook') return { tab: 'workbook', label: 'Workbook' };

  if (head === 'teacher_manual' || head === 'session_plan') {
    const list = isRec(unit) && isRec(unit.teacher_manual) ? unit.teacher_manual : null;
    const key = segments[1];
    const at = segments[2];
    if (head === 'teacher_manual' && (key === 'script' || key === 'helper_script') && typeof at === 'number') {
      const entry = list && Array.isArray(list[key]) ? (list[key] as unknown[])[at] : undefined;
      const sectionId = isRec(entry) && typeof entry.section_id === 'string' ? entry.section_id : undefined;
      return {
        tab: 'manual',
        ...(sectionId ? { sectionId } : {}),
        label: "Teacher's manual",
      };
    }
    return { tab: 'manual', label: head === 'session_plan' ? "Teacher's manual (session plan)" : "Teacher's manual" };
  }

  if (head === 'header') return { tab: 'textbook', label: 'Unit header' };
  return null;
}
