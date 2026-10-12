// The compact schema guide: which block types, question kinds and tutor lines exist, which fields each one
// uses, and which question kinds the app can grade by itself. It describes the AUTHORING format (the flat shapes
// in schemas.ts); the engine maps it to the final unit format. Keep it in step with schemas.ts and mapping.ts.

export const SCHEMA_GUIDE = `## THE AUTHORING FORMAT

You never write ids. Questions and the places that use them are linked by \`ref\`: a short name you choose (letters, digits, underscores, e.g. "match_places"), unique inside one section. A \`question\` block and a tutor line point at a question with \`question_ref\`.

Every field of every object is always present. Fill the fields a type uses; write "" (text), [] (lists) or "none" (tone) for the rest.

### Blocks: { type, text, label, brief, alt, tone, items, headers, rows, question_ref }

| type | fields to fill |
| paragraph | text |
| bullets | items: [{ head, text }]  (head = a short bold lead-in, or "") |
| definition | label = the word, text = its meaning |
| example | label (for example "Example 1 — Places"), text |
| dialogue | items: [{ head = speaker's name, text = what they say }] |
| illustration | brief = what an illustrator should draw (scene, people, objects, setting); alt = one or two plain sentences for a child who cannot see the picture |
| callout | tone = info (a note), tip (a helpful idea) or not_yet (what to do if the child has not got it yet), text |
| activity_steps | items: [{ head = a short LABEL IN CAPITALS, text = what to do }] |
| table | headers: [...], rows: [[...], ...] (every row has one cell per header) |
| question | question_ref = the ref of a question of this section; the question appears here |

Text may contain **bold** spans and nothing else: no other markdown, no HTML, no emoji.

### Questions: { ref, kind, tier, prompt, hint, explanation, skill_tag, options, answers, blanks, numeric, units, pairs, checks, exemplar }

tier: 1 = supported, 2 = now you try, 3 = stretch. hint: one gentle clue, or "". explanation: why the answer is right, in child language, or "". skill_tag: lowercase_with_underscores naming the skill; reuse the same tag for questions that test the same skill.

| kind | graded by the app? | fields to fill |
| mcq | yes | options (2 to 6 distinct choices); answers = [the exact text of the ONE correct option] |
| circle | yes | options (2 to 12 distinct); answers = the exact text of EVERY correct option (at least one, not all) |
| fill_blank | yes | the prompt holds one blank per answer, written as ____ (a run of three or more underscores); blanks = for each blank, every acceptable answer, e.g. [["classroom","the classroom"]]; numeric = true when the blanks are numbers (then list digits and words: ["7","seven"]); units = words or symbols a child may write with a number, e.g. ["₦","naira"] |
| match | yes | pairs: [{ left, right }] (at least 2, lefts distinct) |
| sort | yes | pairs: [{ left = the item, right = its category }]  (at least 2 items and 2 categories) |
| free_text | no: a person or Claude marks it later | checks = what a marker looks for (rubric criteria); exemplar = a model answer |
| draw | no: the child ticks their own work | checks = the things the child ticks off |

Auto-graded answers are compared by rule: case, extra spaces and end punctuation do not matter; one typo is forgiven in longer words; numbers are compared by value ("1/2" = "0.5"; "12" never matches "21"). So list the natural variants a child may give ("kitchen", "the kitchen", "in the kitchen"), and keep every answer unambiguous.

### Tutor lines: { say, accepted, question_ref, on_correct, on_incorrect, hint }

The tutor is a friendly voice that talks the child through a section, offline, from a script. Every line is spoken aloud: short sentences, no bold, no brackets, no emoji.
- A line that only talks: \`say\` and nothing else.
- A line that asks and listens: \`say\` is the question, and EITHER \`accepted\` (the short answers a child might say, lowercase, with natural variants) OR \`question_ref\` (one of this section's questions, which grades the reply). Then give 1 or 2 \`on_correct\` replies, 1 or 2 \`on_incorrect\` replies (kind, and they tell the right answer), and 1 \`hint\` (a clue offered after a miss).
- 2 to 4 lines per section is plenty. Lines follow each other in order.

### The reply of a section step: { blocks, questions, tutor_script }

\`blocks\` is the section body, in order. \`questions\` holds the questions the section OWNS (the ones that appear in it). \`tutor_script\` is the tutor's lines ([] when the section has none).`;
