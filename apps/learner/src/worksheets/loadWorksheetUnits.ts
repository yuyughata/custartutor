import type { LessonUnit } from '@custar/content-schema';
import type { Home } from '../data/queries';
import { listWorksheets, type WorksheetListing } from './buildWorksheetHtml';

export interface WorksheetUnit {
  unitId: string;
  subject: string;
  title: string;
  unitNo: number;
  lesson: LessonUnit;
  listing: WorksheetListing;
}

export interface WorksheetUnitProblem {
  unitId: string;
  title: string;
  message: string;
}

export interface WorksheetUnits {
  units: WorksheetUnit[];
  problems: WorksheetUnitProblem[];
}

/**
 * The child's DOWNLOADED lessons that have a workbook (every lesson does; projects, revision and assessments do not),
 * read from the learner pack on the phone: no network, no grown-up pack. A lesson whose pack cannot be read is listed in
 * `problems` instead of hiding the others.
 */
export async function loadWorksheetUnits(
  home: Home,
  loadLesson: (unitId: string) => Promise<{ unit: LessonUnit }>,
): Promise<WorksheetUnits> {
  const units: WorksheetUnit[] = [];
  const problems: WorksheetUnitProblem[] = [];
  for (const group of home.groups) {
    for (const item of group.units) {
      const downloaded = item.pack !== null && item.pack.availability !== 'not_downloaded';
      if (item.unit.kind !== 'lesson' || !downloaded) continue;
      try {
        const { unit } = await loadLesson(item.unit.id);
        if (!unit.workbook) continue;
        units.push({
          unitId: item.unit.id,
          subject: group.subject.name,
          title: item.unit.title,
          unitNo: item.unit.unit_no,
          lesson: unit,
          listing: listWorksheets(unit),
        });
      } catch (error) {
        problems.push({
          unitId: item.unit.id,
          title: item.unit.title,
          message:
            error instanceof Error ? error.message : 'This lesson could not be read on this phone.',
        });
      }
    }
  }
  return { units, problems };
}
