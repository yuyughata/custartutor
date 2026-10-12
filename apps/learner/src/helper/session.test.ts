import { describe, expect, it } from 'vitest';
import {
  checkButton,
  currentSectionId,
  helperReducer,
  initialHelperState,
  isFirstSection,
  isLastSection,
  isRead,
  progressLabel,
  sectionToNarrate,
  type HelperAction,
  type HelperState,
} from './session';

const ids = ['story', 'places', 'practice', 'check'];

function run(state: HelperState, ...actions: HelperAction[]): HelperState {
  return actions.reduce(helperReducer, state);
}

describe('helper session state', () => {
  it('starts on the get-ready page, not on a section', () => {
    const state = initialHelperState(ids, true);
    expect(state.phase).toBe('prepare');
    expect(currentSectionId(state)).toBeNull();
  });

  it('start opens the first section and marks it visited', () => {
    const state = run(initialHelperState(ids, false), { type: 'start' });
    expect(state.phase).toBe('section');
    expect(currentSectionId(state)).toBe('story');
    expect(state.visited).toEqual(['story']);
    expect(progressLabel(state)).toBe('Section 1 of 4');
  });

  it('cannot start twice or start an empty lesson', () => {
    const started = run(initialHelperState(ids, false), { type: 'start' }, { type: 'next' });
    expect(helperReducer(started, { type: 'start' })).toBe(started);
    const empty = initialHelperState([], false);
    expect(helperReducer(empty, { type: 'start' })).toBe(empty);
  });

  it('moves next and previous without leaving the lesson', () => {
    let state = run(initialHelperState(ids, false), { type: 'start' });
    expect(isFirstSection(state)).toBe(true);
    state = run(state, { type: 'previous' });
    expect(currentSectionId(state)).toBe('story'); // clamped at the start
    state = run(state, { type: 'next' }, { type: 'next' });
    expect(currentSectionId(state)).toBe('practice');
    state = run(state, { type: 'next' }, { type: 'next' }, { type: 'next' });
    expect(currentSectionId(state)).toBe('check'); // clamped at the end
    expect(isLastSection(state)).toBe(true);
    state = run(state, { type: 'previous' });
    expect(currentSectionId(state)).toBe('practice');
    expect(state.visited).toEqual(['story', 'places', 'practice', 'check']);
  });

  it('goto jumps to a section and clamps out-of-range indexes', () => {
    let state = run(initialHelperState(ids, false), { type: 'start' }, { type: 'goto', index: 2 });
    expect(currentSectionId(state)).toBe('practice');
    state = run(state, { type: 'goto', index: 99 });
    expect(currentSectionId(state)).toBe('check');
    state = run(state, { type: 'goto', index: -5 });
    expect(currentSectionId(state)).toBe('story');
  });

  it('"I read it" marks the section and moves on; on the last section it only marks', () => {
    let state = run(initialHelperState(ids, false), { type: 'start' }, { type: 'markRead' });
    expect(isRead(state, 'story')).toBe(true);
    expect(currentSectionId(state)).toBe('places');
    state = run(state, { type: 'goto', index: 3 }, { type: 'markRead' });
    expect(isRead(state, 'check')).toBe(true);
    expect(currentSectionId(state)).toBe('check');
    // marking twice does not duplicate
    state = run(state, { type: 'markRead' });
    expect(state.read.filter((id) => id === 'check')).toHaveLength(1);
  });

  it('navigation does nothing before the session starts or after the result is shown', () => {
    const prepare = initialHelperState(ids, false);
    for (const action of [{ type: 'next' }, { type: 'previous' }, { type: 'markRead' }] as const) {
      expect(helperReducer(prepare, action)).toBe(prepare);
    }
    const result = run(prepare, { type: 'start' }, { type: 'showResult' });
    expect(result.phase).toBe('result');
    expect(helperReducer(result, { type: 'next' })).toBe(result);
    expect(helperReducer(prepare, { type: 'showResult' })).toBe(prepare);
  });

  it('retry returns from the result to the mastery check', () => {
    const result = run(
      initialHelperState(ids, false),
      { type: 'start' },
      { type: 'goto', index: 3 },
      { type: 'showResult' },
    );
    const again = helperReducer(result, { type: 'retry', index: 3 });
    expect(again.phase).toBe('section');
    expect(currentSectionId(again)).toBe('check');
    expect(helperReducer(again, { type: 'retry', index: 0 })).toBe(again); // only from the result
  });

  describe('narration (auto-play) for pre-readers', () => {
    it('never narrates on the get-ready page: the helper must start the session first', () => {
      const state = initialHelperState(ids, true);
      expect(sectionToNarrate(state, 'pre_reader')).toBeNull();
    });

    it('narrates the first section after the session starts, once', () => {
      let state = run(initialHelperState(ids, true), { type: 'start' });
      expect(sectionToNarrate(state, 'pre_reader')).toBe('story');
      state = run(state, { type: 'narrated', sectionId: 'story' });
      expect(sectionToNarrate(state, 'pre_reader')).toBeNull();
      state = run(state, { type: 'next' });
      expect(sectionToNarrate(state, 'pre_reader')).toBe('places');
      // going back to a narrated section does not narrate it again
      state = run(state, { type: 'narrated', sectionId: 'places' }, { type: 'previous' });
      expect(sectionToNarrate(state, 'pre_reader')).toBeNull();
    });

    it('does not narrate for a child who reads, or when auto-play is off', () => {
      const on = run(initialHelperState(ids, true), { type: 'start' });
      expect(sectionToNarrate(on, 'reader')).toBeNull();
      const off = run(initialHelperState(ids, false), { type: 'start' });
      expect(sectionToNarrate(off, 'pre_reader')).toBeNull();
      expect(
        sectionToNarrate(helperReducer(off, { type: 'setAutoplay', on: true }), 'pre_reader'),
      ).toBe('story');
    });

    it('stops narrating when the result is shown', () => {
      const state = run(initialHelperState(ids, true), { type: 'start' }, { type: 'showResult' });
      expect(sectionToNarrate(state, 'pre_reader')).toBeNull();
    });
  });

  describe('the check button', () => {
    it('shows only on a mastery section and is enabled only when every question has an answer', () => {
      expect(checkButton({ onMasterySection: false, ready: true })).toEqual({
        visible: false,
        enabled: false,
      });
      expect(checkButton({ onMasterySection: true, ready: false })).toEqual({
        visible: true,
        enabled: false,
      });
      expect(checkButton({ onMasterySection: true, ready: true })).toEqual({
        visible: true,
        enabled: true,
      });
    });
  });
});
