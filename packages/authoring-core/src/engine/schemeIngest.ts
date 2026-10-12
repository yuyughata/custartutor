// scheme_ingest: `extract` (one model call: Claude reads the PDF natively, or the text, and transcribes the weeks)
// then `check` (no model call: deterministic checks that produce flags for the admin). The scheme text is data to
// be transcribed exactly. Nothing here rewrites or improves NERDC wording.
import {
  Scheme,
  type WeekKind,
  formatZodIssues,
} from '@custar/content-schema';
import {
  StepError,
  type Flag,
  type Json,
  type JobState,
  type SchemeIngestInput,
  type SchemeIngestResult,
  type StepDeps,
  type StepOutcome,
} from '../contract';
import { ingestMessages } from '../prompts/steps';
import { buildSystem } from '../prompts/system';
import { SchemeExtractOutput } from '../prompts/schemas';
import { bytesToBase64 } from './base64';
import { callModel } from './call';
import { clean, cleanAll, toJson } from './util';

export const INGEST_STEPS = ['extract', 'check'] as const;

const MAX_PDF_BYTES = 30 * 1024 * 1024;

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

// ---------------------------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------------------------

export async function runExtract(
  input: SchemeIngestInput,
  deps: StepDeps,
): Promise<StepOutcome<'scheme_ingest'>> {
  let pdf: { base64: string } | null = null;
  if (input.source.type === 'pdf') {
    let loaded: { bytes: Uint8Array; mime: string };
    try {
      loaded = await deps.loadUpload(input.source.path);
    } catch (error) {
      throw new StepError(
        'extract',
        'internal',
        `Could not read the uploaded file: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    }
    if (loaded.bytes.length === 0) {
      throw new StepError('extract', 'invalid_input', 'The uploaded file is empty.');
    }
    if (loaded.bytes.length > MAX_PDF_BYTES) {
      throw new StepError('extract', 'invalid_input', 'The uploaded PDF is larger than 30 MB.');
    }
    if (!isPdf(loaded.bytes)) {
      throw new StepError('extract', 'invalid_input', 'The uploaded file is not a PDF (use a text source for other formats).');
    }
    pdf = { base64: bytesToBase64(loaded.bytes) };
  }

  const { value, usage } = await callModel(deps, {
    step: 'extract',
    family: 'scheme_ingest:extract',
    label: 'scheme_ingest:extract',
    schemaName: 'scheme_extract',
    schema: SchemeExtractOutput,
    system: buildSystem('ingest', []),
    messages: ingestMessages(input, pdf),
    check: (reply) =>
      reply.weeks.flatMap((week, index) =>
        Number.isInteger(week.week_no) ? [] : [`weeks[${index}].week_no must be a whole number (got ${String(week.week_no)})`],
      ),
  });

  const normalised = {
    document_says: {
      subject: clean(value.document_says.subject),
      class_level: clean(value.document_says.class_level),
      term: clean(value.document_says.term),
    },
    weeks: value.weeks.map((week) => ({
      week_no: week.week_no,
      kind: week.kind,
      topic: clean(week.topic),
      subtopics: cleanAll(week.subtopics),
    })),
    notes: cleanAll(value.notes),
  };
  return { output: toJson(normalised), usage };
}

// ---------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------

/** Lowercase, NFC, one kind of dash and quote, no bullets, collapsed whitespace: for "was this copied verbatim?". */
export function comparable(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•·▪●​﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The kind a topic's wording suggests, or null when it reads like an ordinary teaching topic. */
export function expectedKind(topic: string): WeekKind | null {
  const t = topic.trim();
  if (/mid[-\s]?term/i.test(t) && /(exam|test|assess)/i.test(t)) return 'mid_term_exam';
  if (/mid[-\s]?term/i.test(t) && /(break|holiday|rest)/i.test(t)) return 'break';
  if (/^\s*revision\b/i.test(t)) return 'revision';
  if (/^\s*(end[-\s]of[-\s]term\s+)?exam(?:ination)?s?\b/i.test(t)) return 'exam';
  if (/closing|vacation/i.test(t)) return 'closing';
  if (/\b(break|holiday)\b/i.test(t)) return 'break';
  return null;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function levelNumber(text: string): number | null {
  const digit = /(?:primary|basic|p)\s*([1-6])\b/i.exec(text);
  if (digit) return Number(digit[1]);
  const word = /(?:primary|basic)\s*(one|two|three|four|five|six)\b/i.exec(text);
  return word ? (NUMBER_WORDS[word[1]!.toLowerCase()] ?? null) : null;
}

function termNumber(text: string): number | null {
  const t = text.toLowerCase();
  if (/\b(first|1st)\b|term\s*(1|one)\b/.test(t)) return 1;
  if (/\b(second|2nd)\b|term\s*(2|two)\b/.test(t)) return 2;
  if (/\b(third|3rd)\b|term\s*(3|three)\b/.test(t)) return 3;
  return null;
}

function stepError(step: string, message: string): StepError {
  return new StepError(step, 'internal', message, { retryable: false });
}

export function runCheck(input: SchemeIngestInput, state: JobState): StepOutcome<'scheme_ingest'> {
  const parsed = SchemeExtractOutput.safeParse(state.outputs['extract']);
  if (!parsed.success) throw stepError('check', 'The extract step has no usable output yet.');
  const extract = parsed.data;
  const flags: Flag[] = [];
  const flag = (code: string, severity: 'note' | 'concern', message: string, week_no?: number) =>
    flags.push({ code, severity, message, ...(week_no !== undefined ? { week_no } : {}) });

  // rows that can be kept
  const rows = extract.weeks.filter((week) => {
    if (!Number.isInteger(week.week_no) || week.week_no < 1 || week.week_no > 20) {
      flag(
        'week_out_of_range',
        'concern',
        `A row numbered ${String(week.week_no)} ("${week.topic}") is outside weeks 1 to 20 and was left out. Add it by hand if it is real.`,
      );
      return false;
    }
    return true;
  });

  if (rows.length === 0) {
    flag(
      'no_weeks',
      'concern',
      `No weeks were found for ${input.subject_name}, class ${input.level_code}, term ${input.term}. Check that the document is the right one.`,
    );
  }

  // duplicates and gaps
  const seen = new Set<number>();
  for (const week of rows) {
    if (seen.has(week.week_no)) {
      flag('duplicate_week', 'concern', `Week ${week.week_no} appears more than once ("${week.topic}"). Keep one and delete or renumber the other.`, week.week_no);
    }
    seen.add(week.week_no);
  }
  const max = rows.reduce((m, week) => Math.max(m, week.week_no), 0);
  for (let n = 1; n <= max; n += 1) {
    if (!seen.has(n)) flag('missing_week', 'concern', `Week ${n} is missing from the extraction. Add it, or confirm the scheme really skips it.`, n);
  }

  // empty topics, week kinds
  for (const week of rows) {
    if (week.topic === '') flag('empty_topic', 'concern', `Week ${week.week_no} has no topic.`, week.week_no);
    const suggested = expectedKind(week.topic);
    if (suggested !== null && suggested !== week.kind) {
      flag('week_kind', 'concern', `Week ${week.week_no} "${week.topic}" reads like a ${suggested} week but was classified as ${week.kind}. Only teaching weeks become units.`, week.week_no);
    } else if (suggested === null && week.kind !== 'teaching' && week.topic !== '') {
      flag('week_kind', 'concern', `Week ${week.week_no} "${week.topic}" was classified as ${week.kind} but reads like a teaching topic.`, week.week_no);
    }
    if (week.kind === 'teaching' && week.subtopics.length === 0 && week.topic !== '') {
      flag('no_subtopics', 'note', `Week ${week.week_no} has no subtopics (breakdown). The unit objective will rest on the topic alone.`, week.week_no);
    }
  }

  // teaching weeks sanity
  const teaching = rows.filter((week) => week.kind === 'teaching').length;
  if (rows.length > 0) {
    if (teaching < 4 || teaching > 13) {
      flag('teaching_week_count', 'concern', `${teaching} teaching week(s) found; a term normally has 8 to 10. Check the extraction.`);
    } else if (teaching < 6 || teaching > 11) {
      flag('teaching_week_count', 'note', `${teaching} teaching weeks found; a term normally has 8 to 10.`);
    }
  }

  // verbatim check against the source text (a PDF cannot be checked here)
  if (input.source.type === 'text') {
    const haystack = comparable(input.source.text);
    for (const week of rows) {
      const missing = [week.topic, ...week.subtopics].filter((line) => line !== '' && !haystack.includes(comparable(line)));
      if (missing.length > 0) {
        flag(
          'not_verbatim',
          'note',
          `Week ${week.week_no}: ${missing.length === 1 ? 'this line was' : `${missing.length} lines were`} not found word for word in the source text: ${missing.map((line) => `"${line.slice(0, 80)}"`).join('; ')}. NERDC wording must be copied exactly.`,
          week.week_no,
        );
      }
    }
  }

  // the document's own heading against what was selected
  const says = extract.document_says;
  const docLevel = levelNumber(says.class_level) ?? levelNumber(says.subject);
  const wantLevel = Number(input.level_code.slice(1));
  if (docLevel !== null && docLevel !== wantLevel) {
    flag('document_mismatch', 'concern', `The document's heading says class "${says.class_level || says.subject}" but ${input.level_code} was selected.`);
  }
  const docTerm = termNumber(says.term);
  if (docTerm !== null && docTerm !== input.term) {
    flag('document_mismatch', 'concern', `The document's heading says "${says.term}" but term ${input.term} was selected.`);
  }
  if (says.subject !== '') {
    const words = comparable(input.subject_name).split(' ').filter((word) => word.length >= 4);
    const heading = comparable(says.subject);
    if (words.length > 0 && !words.some((word) => heading.includes(word))) {
      flag('document_mismatch', 'note', `The document's heading says subject "${says.subject}" but ${input.subject_name} was selected.`);
    }
  }

  for (const note of extract.notes) flag('reader_note', 'note', `The reader noted: ${note}`);

  // the strict schema, for anything the checks above did not already name
  const weeks = [...rows].sort((a, b) => a.week_no - b.week_no).map((week) => ({
    week_no: week.week_no,
    kind: week.kind,
    topic: week.topic,
    subtopics: week.subtopics,
  }));
  const candidate = { subject_slug: input.subject_slug, level_code: input.level_code, term: input.term, weeks };
  const strict = Scheme.safeParse(candidate);
  if (!strict.success) {
    const named = new Set(flags.map((f) => f.code));
    for (const issue of formatZodIssues(strict.error)) {
      const known =
        (/duplicate week_no/.test(issue.message) && named.has('duplicate_week')) ||
        (/must not be blank/.test(issue.message) && named.has('empty_topic')) ||
        (/at least 1/i.test(issue.message) && named.has('no_weeks'));
      if (!known) flag('scheme_invalid', 'concern', `${issue.path === '' ? '' : `${issue.path}: `}${issue.message}`);
    }
  }

  const how = input.source.type === 'pdf' ? 'PDF read natively by Claude' : 'text';
  const result: SchemeIngestResult = {
    scheme: candidate as SchemeIngestResult['scheme'],
    flags,
    source_note: `Extracted from "${input.source.filename}" (${how}) for ${input.subject_name}, ${input.level_code}, term ${input.term}. Check every week against the original document before approving.`,
  };
  const output: Json = toJson({ weeks: weeks.length, flags: flags.length });
  return { output, usage: [], result };
}
