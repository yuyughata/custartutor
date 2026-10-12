import { useMemo } from 'react';
import type { AdminApi, Level, Subject } from '../api/types';
import { useApi } from '../runtime/RuntimeProvider';
import { useLoad, type LoadState } from './useLoad';

export interface Catalog {
  subjects: Subject[];
  levels: Level[];
  subjectName: (id: string | null | undefined) => string;
  subjectBySlug: (slug: string) => Subject | undefined;
  levelName: (code: string | null | undefined) => string;
}

const cache = new WeakMap<AdminApi, Promise<Catalog>>();

async function load(api: AdminApi): Promise<Catalog> {
  const [subjects, levels] = await Promise.all([api.catalog.subjects(), api.catalog.levels()]);
  return {
    subjects,
    levels,
    subjectName: (id) => subjects.find((subject) => subject.id === id)?.name ?? 'Unknown subject',
    subjectBySlug: (slug) => subjects.find((subject) => subject.slug === slug),
    levelName: (code) => levels.find((level) => level.code === code)?.name ?? code ?? '–',
  };
}

/** Subjects and levels almost never change, so each screen shares one load per API instance. */
export function useCatalog(): LoadState<Catalog> {
  const api = useApi();
  const loader = useMemo(
    () => () => {
      let promise = cache.get(api);
      if (!promise) {
        promise = load(api);
        // A failed load must not be remembered.
        promise.catch(() => cache.delete(api));
        cache.set(api, promise);
      }
      return promise;
    },
    [api],
  );
  return useLoad(loader, [api]);
}

export function schemeLabel(
  catalog: Catalog,
  scheme: { subject_id: string; level_code: string; term: number },
): string {
  return `${catalog.subjectName(scheme.subject_id)} · ${catalog.levelName(scheme.level_code)} · Term ${scheme.term}`;
}
