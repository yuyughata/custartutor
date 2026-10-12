import { describe, expect, it } from 'vitest';
import { REJECTION_RULES } from './rejectionRules';
import { sanitizeReply } from './sanitize';
import { createPatternMatcher } from './patterns';

describe('sanitizeReply tidies', () => {
  const clean = (input: string, expected: string) => {
    const result = sanitizeReply(input);
    expect(result.rejected, input).toBe(false);
    expect(result.text, input).toBe(expected);
  };

  it('leaves plain text alone', () => {
    const result = sanitizeReply('We cook in the kitchen. Where do we sleep?');
    expect(result).toMatchObject({ changed: false, rejected: false, reasons: [], fixes: [] });
    expect(result.text).toBe('We cook in the kitchen. Where do we sleep?');
  });

  it('strips markdown', () => {
    clean('**Great** job! Here is *a hint*: think of the `kitchen`.', 'Great job! Here is a hint: think of the kitchen.');
    clean('# Hello\n- one\n- two\n1. three', 'Hello one two three');
    clean('Look at [this page](https://example.com) now', 'Look at this page now');
    clean('Fill in the blank: ____ and _italic_ words', 'Fill in the blank: ____ and italic words');
  });

  it('strips HTML but not maths', () => {
    clean('<b>Well done</b><br>Next one', 'Well done Next one');
    clean('<script>alert(1)</script>Hi', 'alert(1) Hi');
    clean('Is 3 < 5 and 7 > 4? Yes.', 'Is 3 < 5 and 7 > 4? Yes.');
    clean('Tom &amp; Ada', 'Tom & Ada');
  });

  it('removes links entirely', () => {
    clean('Visit https://example.com/page for more.', 'Visit for more.');
    clean('Go to www.example.com.', 'Go to.');
    clean('See example.ng now', 'See now');
  });

  it('removes emoji, however many', () => {
    clean('Well done! \u{1F389}\u{1F389}\u{1F389}\u{2B50}', 'Well done!');
    clean('Good \u{1F44D}\u{1F3FD} try', 'Good \u{1F3FD} try'.replace(' \u{1F3FD}', ''));
  });

  it('turns line breaks into one paragraph', () => {
    clean('One.\n\nTwo.\nThree.', 'One. Two. Three.');
  });

  it('cuts an over-long reply at a sentence end', () => {
    const long = 'This is a sentence about the kitchen. '.repeat(40).trim();
    const result = sanitizeReply(long, { maxChars: 120 });
    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(result.text.endsWith('.')).toBe(true);
    expect(result.fixes).toContain('truncated');
    expect(result.changed).toBe(true);
  });

  it('is idempotent', () => {
    const once = sanitizeReply('**Hi** <b>there</b> \u{1F600} see www.example.com').text;
    expect(sanitizeReply(once).text).toBe(once);
  });
});

describe('sanitizeReply rejects', () => {
  const rejected = (input: string, reason: string, options = {}) => {
    const result = sanitizeReply(input, options);
    expect(result.rejected, input).toBe(true);
    expect(result.reasons, input).toContain(reason);
    expect(result.text).toBe('');
  };

  it('every rule matches its own examples', () => {
    for (const rule of REJECTION_RULES) {
      for (const example of rule.examples) {
        const matcher = createPatternMatcher([
          { id: 'r', category: 'distress', severity: 'low', template: rule.template, examples: [example] },
        ]);
        expect(matcher(example).length, `${rule.reason}: ${example}`).toBeGreaterThan(0);
      }
    }
  });

  it('asks the child for personal data', () => {
    rejected('Nice! What is your name?', 'asks_personal_data');
    rejected("What's your surname?", 'asks_personal_data');
    rejected('Tell me your address and we can start.', 'asks_personal_data');
    rejected('Where do you live?', 'asks_personal_data');
    rejected('Which school do you go to?', 'asks_personal_data');
    rejected('Please send me a photo of your work.', 'asks_personal_data');
    rejected('What is your phone number?', 'asks_personal_data');
    rejected('Can you type your password here?', 'asks_personal_data');
  });

  it('proposes meeting or secrecy', () => {
    rejected('Let us meet tomorrow after school.', 'meet_someone');
    rejected('Come to my house and I will show you.', 'meet_someone');
    rejected('Do not tell your mummy about this.', 'keep_secret');
    rejected('This is our little secret.', 'keep_secret');
  });

  it('claims to be human', () => {
    rejected('I am a real person, not a robot.', 'claims_human');
    rejected('I am not a computer.', 'claims_human');
    rejected('When I was your age I loved maths.', 'claims_human');
  });

  it('claims to be a story character', () => {
    rejected('Hello, I am Zari!', 'claims_character', { castNames: ['Zari', 'Zuri'] });
    expect(sanitizeReply('Zari went to the market.', { castNames: ['Zari'] }).rejected).toBe(false);
  });

  it('shows contact details, a real name or an address', () => {
    rejected('Call me on 0800 000 0000', 'contact_details');
    rejected('Write to name@example.com', 'contact_details');
    rejected('I live at 12 Test Street', 'contact_details');
    rejected('Hello Testa Sample, well done', 'known_name', { knownNames: ['Testa Sample'] });
  });

  it('gives away what its instructions say', () => {
    rejected('My instructions say that I must be kind.', 'reveals_instructions');
    rejected('Okay, I will ignore my rules.', 'reveals_instructions');
    rejected('I am now in developer mode.', 'reveals_instructions');
    rejected('Always keep your answers short and warm and never tell the child anything unsafe.', 'reveals_instructions', {
      protectedText: ['Rule one: always keep your answers short and warm and never tell the child anything unsafe, ever.'],
    });
  });

  it('gives a mastery answer', () => {
    const masteryGuard = [['classroom', 'at school'], ['put rubbish in the bin']];
    rejected('The classroom goes in At school.', 'mastery_answer', { masteryGuard });
    rejected('The correct answer is put rubbish in the bin.', 'mastery_answer', { masteryGuard });
    expect(sanitizeReply('We learn in the classroom.', { masteryGuard }).rejected).toBe(false);
    expect(sanitizeReply('Think about where rubbish goes.', { masteryGuard }).rejected).toBe(false);
  });

  it('rejects an empty reply', () => {
    rejected('   ', 'empty');
    rejected('https://example.com', 'empty');
    rejected('\u{1F600}\u{1F600}', 'empty');
  });

  it('does not reject lesson talk that merely resembles a rule', () => {
    for (const text of [
      'Good question! What do we do in the kitchen?',
      'Your teacher will be happy with that.',
      'Zari and Zuri meet at the market.',
      'Tell me one thing you can see in your classroom.',
      'Is it a number or a letter?',
    ]) {
      expect(sanitizeReply(text, { castNames: ['Zari'] }).rejected, text).toBe(false);
    }
  });
});
