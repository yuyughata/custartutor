import { describe, expect, it } from 'vitest';
import { TutorScript } from './tutor-script';

describe('TutorScript', () => {
  it('parses nodes and fills in the empty reply lists', () => {
    const script = TutorScript.parse({
      nodes: [
        { id: 'n_one', say: 'Hello!' },
        {
          id: 'n_two',
          say: 'Where do we cook?',
          expect: { accepted: ['kitchen'] },
          on_correct: ['Yes!'],
          on_incorrect: ['Not quite.'],
          hint: ['It has a stove.'],
          next: 'n_one',
        },
      ],
    });
    expect(script.nodes[0]).toEqual({
      id: 'n_one',
      say: 'Hello!',
      on_correct: [],
      on_incorrect: [],
      hint: [],
    });
    expect(script.nodes[1]?.next).toBe('n_one');
  });

  it('expects exactly one of question_id or accepted', () => {
    const node = (expect: unknown) => ({ nodes: [{ id: 'n_one', say: 'Hi', expect }] });
    expect(TutorScript.safeParse(node({ question_id: 'q_one' })).success).toBe(true);
    expect(TutorScript.safeParse(node({ accepted: ['a'] })).success).toBe(true);
    expect(TutorScript.safeParse(node({})).success).toBe(false);
    expect(TutorScript.safeParse(node({ question_id: 'q_one', accepted: ['a'] })).success).toBe(
      false,
    );
    expect(TutorScript.safeParse(node({ accepted: [] })).success).toBe(false);
  });

  it('rejects duplicate node ids and a next that points nowhere', () => {
    expect(
      TutorScript.safeParse({
        nodes: [
          { id: 'n_one', say: 'a' },
          { id: 'n_one', say: 'b' },
        ],
      }).success,
    ).toBe(false);
    expect(
      TutorScript.safeParse({ nodes: [{ id: 'n_one', say: 'a', next: 'n_gone' }] }).success,
    ).toBe(false);
  });

  it('rejects an empty script and blank lines', () => {
    expect(TutorScript.safeParse({ nodes: [] }).success).toBe(false);
    expect(TutorScript.safeParse({ nodes: [{ id: 'n_one', say: ' ' }] }).success).toBe(false);
  });
});
