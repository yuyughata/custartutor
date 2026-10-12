// What every field of the editor needs, without passing it down by hand: the stable actions (change something,
// ask before deleting, open a card, jump to a field), the environment of the unit being edited (read-only or not,
// which ids were ever published) and the issues of the latest validation, indexed by the field they belong to.
// The actions never change identity, and the issue lists keep their identity when their content is the same, so a
// keystroke re-renders the field being typed in and not the whole unit.
import { createContext, useContext, type ReactNode } from 'react';
import type { Stage, UnitKind } from '@custar/content-schema';
import type { HeaderContext } from '../headerStamp';
import type { Unit } from '../ops';
import { pathKey, type Path } from '../path';
import type { PublishedIds } from '../stableIds';
import type { EditorIssue } from '../validate';

export interface DeleteRequest {
  title: string;
  /** What else will change, in plain words. */
  notes?: string[];
  confirmLabel: string;
  onConfirm: () => void;
}

export interface EditorActions {
  /** Applies a change to the working copy. Edits with the same `key` in quick succession are one undo step. */
  commit(update: (unit: Unit) => Unit, key?: string | null): void;
  setField(path: Path, value: unknown): void;
  /** Ask first: opens the confirmation dialog. */
  confirmDelete(request: DeleteRequest): void;
  /** Open the cards on the way to a path and move the focus to its field. */
  jump(path: Path): void;
  isOpen(key: string, defaultOpen: boolean): boolean;
  toggle(key: string, defaultOpen: boolean): void;
  open(key: string): void;
}

export interface EditorEnv {
  readOnly: boolean;
  kind: UnitKind;
  stage: Stage;
  /** Every id that any published snapshot ever had: new ids never reuse one. */
  publishedTaken: ReadonlySet<string>;
  published: PublishedIds | null;
  header: HeaderContext | null;
  /** The unit has no scheme week, so the header's week is the author's to set. */
  weekEditable: boolean;
}

export const ActionsContext = createContext<EditorActions | null>(null);
export const EnvContext = createContext<EditorEnv | null>(null);
export const IssuesContext = createContext<ReadonlyMap<string, EditorIssue[]>>(new Map());

export function useActions(): EditorActions {
  const value = useContext(ActionsContext);
  if (!value) throw new Error('useActions needs the editor');
  return value;
}

export function useEnv(): EditorEnv {
  const value = useContext(EnvContext);
  if (!value) throw new Error('useEnv needs the editor');
  return value;
}

const NONE: EditorIssue[] = [];

export function useIssuesAt(path: Path): EditorIssue[] {
  const map = useContext(IssuesContext);
  return map.get(pathKey(path)) ?? NONE;
}

/** Groups issues by the field they are shown beside, reusing the previous lists when nothing about them changed. */
export function indexIssues(
  issues: readonly EditorIssue[],
  previous: ReadonlyMap<string, EditorIssue[]>,
): Map<string, EditorIssue[]> {
  const grouped = new Map<string, EditorIssue[]>();
  for (const issue of issues) {
    const key = pathKey(issue.owner);
    const list = grouped.get(key);
    if (list) list.push(issue);
    else grouped.set(key, [issue]);
  }
  for (const [key, list] of grouped) {
    list.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
    const before = previous.get(key);
    if (
      before &&
      before.length === list.length &&
      before.every((issue, i) => issue.key === list[i]?.key && issue.message === list[i]?.message)
    ) {
      grouped.set(key, before);
    }
  }
  return grouped;
}

export function EditorProviders({
  actions,
  env,
  issues,
  children,
}: {
  actions: EditorActions;
  env: EditorEnv;
  issues: ReadonlyMap<string, EditorIssue[]>;
  children: ReactNode;
}): ReactNode {
  return (
    <ActionsContext.Provider value={actions}>
      <EnvContext.Provider value={env}>
        <IssuesContext.Provider value={issues}>{children}</IssuesContext.Provider>
      </EnvContext.Provider>
    </ActionsContext.Provider>
  );
}
