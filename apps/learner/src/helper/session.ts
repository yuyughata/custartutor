/**
 * The state of a helper session: where the helper is in the lesson, which sections they have read to the child,
 * and which have been narrated. A pure reducer, so the rules are tested without a screen.
 *
 * LOCAL UI STATE ONLY. Nothing here is sent to the server and there is no helper event type: the fact that a
 * helper was present is not recorded anywhere (the wire contract is untouched). Answers still go through the
 * normal lesson session, and only the graded mastery check can grant mastery.
 */

export type HelperPhase = 'prepare' | 'section' | 'result';

export interface HelperState {
  phase: HelperPhase;
  /** Section ids in lesson order. */
  ids: readonly string[];
  /** Index into `ids` of the section on screen (meaningful in the `section` phase). */
  index: number;
  /** Sections the helper marked "I read it". */
  read: readonly string[];
  /** Sections opened at least once; their question views stay mounted so a half-done answer is not lost. */
  visited: readonly string[];
  /** Sections already narrated automatically: narration happens once per section. */
  narrated: readonly string[];
  /** Read each section aloud as it opens (pre-readers only, and only after the helper started the session). */
  autoplay: boolean;
}

export type HelperAction =
  | { type: 'start' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'goto'; index: number }
  /** "I read it": marks the section and moves on (the last section stays). */
  | { type: 'markRead' }
  | { type: 'setAutoplay'; on: boolean }
  | { type: 'narrated'; sectionId: string }
  | { type: 'showResult' }
  /** After "Not yet": back to the mastery check. */
  | { type: 'retry'; index: number };

export function initialHelperState(ids: readonly string[], autoplay: boolean): HelperState {
  return {
    phase: 'prepare',
    ids,
    index: 0,
    read: [],
    visited: [],
    narrated: [],
    autoplay,
  };
}

function clamp(index: number, count: number): number {
  return Math.min(Math.max(0, index), Math.max(0, count - 1));
}

function add(list: readonly string[], id: string | undefined): readonly string[] {
  return id === undefined || list.includes(id) ? list : [...list, id];
}

function open(state: HelperState, index: number): HelperState {
  const next = clamp(index, state.ids.length);
  return { ...state, phase: 'section', index: next, visited: add(state.visited, state.ids[next]) };
}

export function helperReducer(state: HelperState, action: HelperAction): HelperState {
  switch (action.type) {
    case 'start':
      return state.phase === 'prepare' && state.ids.length > 0 ? open(state, 0) : state;
    case 'next':
      return state.phase === 'section' ? open(state, state.index + 1) : state;
    case 'previous':
      return state.phase === 'section' ? open(state, state.index - 1) : state;
    case 'goto':
      return state.phase === 'section' ? open(state, action.index) : state;
    case 'markRead': {
      if (state.phase !== 'section') return state;
      const marked = { ...state, read: add(state.read, state.ids[state.index]) };
      return open(marked, state.index + 1);
    }
    case 'setAutoplay':
      return { ...state, autoplay: action.on };
    case 'narrated':
      return { ...state, narrated: add(state.narrated, action.sectionId) };
    case 'showResult':
      return state.phase === 'section' ? { ...state, phase: 'result' } : state;
    case 'retry':
      return state.phase === 'result' ? open(state, action.index) : state;
  }
}

// ---- selectors ----------------------------------------------------------------------------------

export function currentSectionId(state: HelperState): string | null {
  return state.phase === 'section' ? (state.ids[state.index] ?? null) : null;
}

export function isFirstSection(state: HelperState): boolean {
  return state.index <= 0;
}

export function isLastSection(state: HelperState): boolean {
  return state.index >= state.ids.length - 1;
}

/** "Section 3 of 14". */
export function progressLabel(state: HelperState): string {
  return `Section ${Math.min(state.index + 1, state.ids.length)} of ${state.ids.length}`;
}

export function isRead(state: HelperState, sectionId: string): boolean {
  return state.read.includes(sectionId);
}

/**
 * The section to narrate now, or null. Narration runs only when ALL of these hold: the helper started the session
 * (phase `section`, never on the get-ready page), auto-play is on, the child cannot read yet, and this section has
 * not been narrated before. The screen then calls `narrated` so it never repeats.
 */
export function sectionToNarrate(state: HelperState, readingMode: string): string | null {
  if (state.phase !== 'section' || !state.autoplay || readingMode !== 'pre_reader') return null;
  const id = state.ids[state.index];
  return id !== undefined && !state.narrated.includes(id) ? id : null;
}

/**
 * Whether to offer "I'm finished: check my progress". Only on a mastery-check section, and enabled once every
 * gradable question has an answer (the lesson session decides `ready`). It only SUBMITS the check; the score and the
 * pass are computed by the same deterministic grader as everywhere else.
 */
export function checkButton(args: { onMasterySection: boolean; ready: boolean }): {
  visible: boolean;
  enabled: boolean;
} {
  return { visible: args.onMasterySection, enabled: args.onMasterySection && args.ready };
}
