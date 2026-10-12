// The stable-id rule, applied to what a person does by hand. Learners' progress, item analysis and the tutor refer
// to section ids and question ids, so an id that appears in ANY published snapshot of this unit can never be
// deleted (not just the version this draft is based on): the editor disables the delete button and says why, and the
// check below, built on content-schema's `lintVersionIds`, refuses to save a working copy that lost one anyway
// (for example restored from an old autosave). An id that was never published may be deleted freely.
//
// Tutor node ids, hotspot ids and practice-variant ids are also meant to be stable (content-schema README) but
// `lintVersionIds` does not check them; dropping a published one is a WARNING here, not a block.
import {
  lintVersionIds,
  parseUnitLenient,
  type LintReport,
  type UnitContent,
} from '@custar/content-schema';
import type { PublishedSnapshot } from '../api/types';

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface PublishedIds {
  /** Section id -> the version numbers of the published snapshots that have it. */
  sections: Map<string, number[]>;
  questions: Map<string, number[]>;
  nodes: Map<string, number[]>;
  hotspots: Map<string, number[]>;
  variants: Map<string, number[]>;
}

function add(map: Map<string, number[]>, id: unknown, version: number): void {
  if (typeof id !== 'string') return;
  const list = map.get(id) ?? [];
  if (!list.includes(version)) list.push(version);
  map.set(id, list);
}

export function publishedIdsOf(snapshots: readonly PublishedSnapshot[]): PublishedIds {
  const out: PublishedIds = {
    sections: new Map(),
    questions: new Map(),
    nodes: new Map(),
    hotspots: new Map(),
    variants: new Map(),
  };
  for (const snapshot of snapshots) {
    const content = snapshot.content;
    if (!isRec(content)) continue;
    const version = snapshot.version_no;
    const scripts: unknown[] = [content.tutor_script];
    if (Array.isArray(content.sections)) {
      for (const section of content.sections) {
        if (!isRec(section)) continue;
        add(out.sections, section.id, version);
        scripts.push(section.tutor_script);
      }
    }
    if (isRec(content.questions)) {
      for (const [key, question] of Object.entries(content.questions)) {
        add(out.questions, key, version);
        const hotspots = isRec(question) && isRec(question.answer) ? question.answer.hotspots : undefined;
        if (Array.isArray(hotspots)) hotspots.forEach((h) => isRec(h) && add(out.hotspots, h.id, version));
      }
    }
    for (const script of scripts) {
      if (isRec(script) && Array.isArray(script.nodes)) {
        script.nodes.forEach((n) => isRec(n) && add(out.nodes, n.id, version));
      }
    }
    const variants = isRec(content.workbook) ? content.workbook.practice_variants : undefined;
    if (Array.isArray(variants)) variants.forEach((v) => isRec(v) && add(out.variants, v.id, version));
  }
  return out;
}

/** Every id any published snapshot ever had: a new item never reuses one. */
export function allPublishedIds(ids: PublishedIds): Set<string> {
  return new Set([
    ...ids.sections.keys(),
    ...ids.questions.keys(),
    ...ids.nodes.keys(),
    ...ids.hotspots.keys(),
    ...ids.variants.keys(),
  ]);
}

export interface Protection {
  protected: boolean;
  versions: number[];
  /** Plain words for the disabled delete button; null when the id may be deleted. */
  reason: string | null;
}

function versionsText(versions: readonly number[]): string {
  const sorted = [...versions].sort((a, b) => a - b);
  return sorted.length === 1 ? `version ${sorted[0]}` : `versions ${sorted.join(', ')}`;
}

export function protection(
  kind: 'section' | 'question',
  id: string,
  ids: PublishedIds | null,
): Protection {
  const versions = (kind === 'section' ? ids?.sections : ids?.questions)?.get(id) ?? [];
  if (versions.length === 0) return { protected: false, versions: [], reason: null };
  return {
    protected: true,
    versions,
    reason: `This ${kind} was published in ${versionsText(versions)}. Children's progress and the item analysis refer to its id, so it cannot be deleted. Rewrite its text instead.`,
  };
}

export interface IdIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** Where lint put it, for example `['sections', 'places_in_home']`. */
  path: (string | number)[];
}

function toUnit(raw: unknown): UnitContent {
  try {
    return parseUnitLenient(raw);
  } catch {
    return raw as UnitContent;
  }
}

function lintReportIssues(report: LintReport, version: number): IdIssue[] {
  return report.errors.map((issue) => ({
    severity: 'error' as const,
    code: issue.code,
    message: `${issue.message.replace(/\.$/, '')} (it is in published version ${version}).`,
    path: issue.path ? issue.path.split('.') : [],
  }));
}

/**
 * Compares the working copy with EVERY published snapshot of the unit with `lintVersionIds` and reports each section or
 * question id that went missing. One issue per id, naming all the versions that had it.
 */
export function publishedIdIssues(
  working: unknown,
  snapshots: readonly PublishedSnapshot[],
): IdIssue[] {
  const next = working as UnitContent;
  const merged = new Map<string, IdIssue & { versions: number[] }>();
  for (const snapshot of snapshots) {
    const previous = toUnit(snapshot.content);
    for (const issue of lintReportIssues(lintVersionIds(previous, next), snapshot.version_no)) {
      const key = `${issue.code}|${issue.path.join('.')}`;
      const seen = merged.get(key);
      if (seen) seen.versions.push(snapshot.version_no);
      else merged.set(key, { ...issue, versions: [snapshot.version_no] });
    }
  }
  return [...merged.values()].map(({ versions, ...issue }) => ({
    ...issue,
    message: issue.message.replace(/\(it is in published version \d+\)\.$/, `(published in ${versionsText(versions)}).`),
  }));
}

/** Tutor node, hotspot and practice-variant ids that a published snapshot had and the working copy has not. */
export function droppedSoftIds(working: unknown, ids: PublishedIds): IdIssue[] {
  const now = publishedIdsOf([
    { id: 'working', version_no: 0, is_current: false, published_at: '', content: working as never },
  ]);
  const out: IdIssue[] = [];
  const kinds: [keyof PublishedIds, string, string][] = [
    ['nodes', 'tutor_node_id_dropped', 'Tutor line'],
    ['hotspots', 'hotspot_id_dropped', 'Picture area'],
    ['variants', 'variant_id_dropped', 'Practice set'],
  ];
  for (const [kind, code, label] of kinds) {
    for (const [id, versions] of ids[kind]) {
      if (!now[kind].has(id)) {
        out.push({
          severity: 'warning',
          code,
          message: `${label} "${id}" was published in ${versionsText(versions)} and is gone from this draft. Ids should stay stable; check that nothing refers to it.`,
          path: [],
        });
      }
    }
  }
  return out;
}
