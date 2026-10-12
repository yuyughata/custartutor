// "New scheme from a document": pick subject, level and term, give a source (PDF, Word, text file or pasted
// text), watch the extraction job live, then check and edit the draft before anything is saved.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SchemeIngestResult, type SchemeSource } from '@custar/authoring-core';
import { LevelCode } from '@custar/content-schema';
import { SchemeDraftEditor } from '../components/SchemeDraftEditor';
import { JobPanel } from '../components/JobPanel';
import { useAction } from '../hooks/useAction';
import { useCatalog, type Catalog } from '../hooks/useCatalog';
import { useJob } from '../hooks/useJob';
import { usePageTitle } from '../hooks/usePageTitle';
import {
  classifyDocument,
  previewText,
  sizeProblem,
  textSource,
  unsupportedMessage,
} from '../lib/documents';
import { newKey } from '../lib/ids';
import { whyNot } from '../lib/roles';
import { decodeText, pickSchemeDocument, type PickedDocument } from '../platform/documents';
import { docxToText } from '../platform/docxToText';
import { useApi, useRuntime, useSession } from '../runtime/RuntimeProvider';
import { useLeaveGuard } from '../runtime/UnsavedGuard';
import { AppLink } from '../ui/AppLink';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card, Row, Section } from '../ui/Card';
import { TextField } from '../ui/Fields';
import { PageHeader } from '../ui/PageHeader';
import { Select } from '../ui/Select';
import { Async } from '../ui/States';
import { P, Small } from '../ui/Text';
import { colors, space } from '../ui/theme';
import { DEMO_MODEL_NAME } from '../demo/modelName';

type SourceMode = 'file' | 'paste';

interface PickedSource {
  document: PickedDocument;
  /** Text read from the file (DOCX converted in the browser, or a plain-text file). Absent for a PDF. */
  text?: string;
  problem?: string;
}

function SourcePicker({
  mode,
  onMode,
  picked,
  onPicked,
  pasted,
  onPasted,
  disabled,
}: {
  mode: SourceMode;
  onMode: (mode: SourceMode) => void;
  picked: PickedSource | null;
  onPicked: (picked: PickedSource | null) => void;
  pasted: string;
  onPasted: (text: string) => void;
  disabled: boolean;
}): ReactNode {
  const choose = useAction(async () => {
    const document = await pickSchemeDocument();
    if (!document) return;
    if (document.kind === 'unsupported') {
      onPicked({ document, problem: unsupportedMessage(document.name) });
      return;
    }
    const tooBig = sizeProblem(document.kind, document.size);
    if (tooBig) {
      onPicked({ document, problem: tooBig });
      return;
    }
    if (document.kind === 'pdf') {
      onPicked({ document });
      return;
    }
    const data = await document.read();
    try {
      const text = document.kind === 'docx' ? await docxToText(data) : decodeText(data);
      onPicked({ document, text });
    } catch (cause) {
      onPicked({
        document,
        problem:
          cause instanceof Error && document.kind === 'docx'
            ? 'That Word file could not be read. Open it, copy the scheme table and paste it instead.'
            : 'That file could not be read.',
      });
    }
  });

  return (
    <View style={{ gap: space[3] }}>
      <Select
        label="Source"
        value={mode}
        options={[
          { value: 'paste', label: 'Paste text' },
          { value: 'file', label: 'Choose a file (PDF, Word or text)' },
        ]}
        onChange={(value) => onMode(value === 'file' ? 'file' : 'paste')}
        disabled={disabled}
      />
      {mode === 'paste' ? (
        <TextField
          label="Scheme of work text"
          hint="Paste the weeks, topics and subtopics for ONE term. The model treats this as data to read, never as instructions."
          value={pasted}
          onChangeText={onPasted}
          lines={10}
          editable={!disabled}
          mono
        />
      ) : (
        <View style={{ gap: space[2] }}>
          <Row>
            <Button
              label={picked ? 'Choose a different file' : 'Choose a file'}
              variant="secondary"
              onPress={() => void choose.run()}
              busy={choose.busy}
              disabled={disabled}
            />
            {picked ? <P>{picked.document.name}</P> : null}
          </Row>
          {choose.error ? (
            <Banner tone="danger" title="Could not read the file">
              <P>{choose.error.message}</P>
            </Banner>
          ) : null}
          {picked?.problem ? (
            <Banner tone="warning" title="That file cannot be used">
              <P>{picked.problem}</P>
            </Banner>
          ) : null}
          {picked && !picked.problem && picked.document.kind === 'pdf' ? (
            <Small>
              This PDF will be stored in the private upload bucket and read by the model page by
              page (text and images).
            </Small>
          ) : null}
          {picked && !picked.problem && picked.text !== undefined ? (
            <Card tone="muted">
              <Small>
                {picked.document.kind === 'docx'
                  ? 'Converted to text in your browser; the Word file itself is not uploaded.'
                  : 'Read from the file.'}{' '}
                {picked.text.length.toLocaleString('en-GB')} characters. Start of the text:
              </Small>
              <P>{previewText(picked.text)}</P>
            </Card>
          ) : null}
        </View>
      )}
    </View>
  );
}

function ResultView({
  job,
  catalog,
  fallbackSubjectId,
}: {
  job: { result: unknown };
  catalog: Catalog;
  fallbackSubjectId: string;
}): ReactNode {
  const parsed = SchemeIngestResult.safeParse(job.result);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [approvedId, setApprovedId] = useState<string | null>(null);
  if (!parsed.success) {
    return (
      <Banner tone="danger" title="The result could not be read">
        <P>
          The job finished, but its result is not a scheme draft. Start again, and tell the
          developers if it keeps happening.
        </P>
      </Banner>
    );
  }
  const { scheme, flags, source_note: sourceNote } = parsed.data;
  const subject = catalog.subjectBySlug(scheme.subject_slug);
  const subjectId = subject?.id ?? fallbackSubjectId;
  return (
    <View style={{ gap: space[4] }}>
      <Banner tone="info" title="Check this draft before it is saved" testID="scheme-draft-banner">
        <P>
          Nothing has been saved yet. Edit the table below to match the source, then choose “Save as
          draft”. A reviewer or super admin approves it afterwards.
        </P>
      </Banner>
      <SchemeDraftEditor
        subjectId={subjectId}
        subjectName={catalog.subjectName(subjectId)}
        levelCode={scheme.level_code}
        levelName={catalog.levelName(scheme.level_code)}
        term={scheme.term}
        initialWeeks={scheme.weeks}
        initialSourceNote={sourceNote}
        flags={flags}
        schemeId={null}
        onSaved={setSavedId}
        onApproved={setApprovedId}
      />
      {savedId ? (
        <Card tone="core">
          <P>
            The draft is saved.{' '}
            <AppLink href={{ pathname: '/schemes/[schemeId]', params: { schemeId: savedId } }}>
              Open the saved scheme
            </AppLink>
            {approvedId ? (
              <>
                {' · '}
                <AppLink
                  href={{
                    pathname: '/schemes/[schemeId]/chapters',
                    params: { schemeId: approvedId },
                  }}
                >
                  Plan chapters
                </AppLink>
              </>
            ) : null}
          </P>
        </Card>
      ) : null}
    </View>
  );
}

export default function NewSchemeScreen(): ReactNode {
  usePageTitle('New scheme');
  const api = useApi();
  const { runtime } = useRuntime();
  const { role } = useSession();
  const router = useRouter();
  const guard = useLeaveGuard();
  const params = useLocalSearchParams<{ job?: string }>();
  const catalog = useCatalog();

  const [subjectId, setSubjectId] = useState('');
  const [levelCode, setLevelCode] = useState<string>('P1');
  const [term, setTerm] = useState('1');
  const [mode, setMode] = useState<SourceMode>('paste');
  const [picked, setPicked] = useState<PickedSource | null>(null);
  const [pasted, setPasted] = useState('');
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const key = useRef(newKey());

  const job = useJob(api.jobs, runtime.pollMs, {
    onCreated: (created) => router.setParams({ job: created.id }),
  });
  const denied = whyNot(role, 'job.start');

  // A message about the form goes away as soon as the form changes.
  useEffect(() => {
    setFormProblem(null);
  }, [subjectId, levelCode, term, mode, picked, pasted]);

  // Coming back to a job (from the URL or the Jobs list) continues it.
  const resume = job.resume;
  const jobParam = params.job;
  useEffect(() => {
    if (jobParam) void resume(jobParam);
  }, [jobParam, resume]);

  const start = useAction(async () => {
    setFormProblem(null);
    const level = LevelCode.safeParse(levelCode);
    if (!subjectId || !level.success) {
      setFormProblem('Choose a subject and a level.');
      return;
    }
    let source: SchemeSource;
    if (mode === 'paste') {
      const built = textSource(pasted, 'pasted-text.txt');
      if (!built.source) return setFormProblem(built.problem ?? 'There is no text to read.');
      source = built.source;
    } else {
      if (!picked || picked.problem)
        return setFormProblem(picked?.problem ?? 'Choose a file first.');
      if (classifyDocument(picked.document.name, picked.document.mimeType) === 'pdf') {
        const data = await picked.document.read();
        const { path } = await api.schemes.uploadPdf({
          name: picked.document.name,
          mimeType: 'application/pdf',
          size: picked.document.size,
          data,
        });
        source = { type: 'pdf', path, filename: picked.document.name };
      } else {
        const built = textSource(picked.text ?? '', picked.document.name);
        if (!built.source) return setFormProblem(built.problem ?? 'There is no text to read.');
        source = built.source;
      }
    }
    const idempotencyKey = key.current;
    key.current = newKey();
    await job.start(
      'scheme_ingest',
      { subject_id: subjectId, level_code: level.data, term: Number(term) as 1 | 2 | 3, source },
      idempotencyKey,
    );
  });

  const startOver = (): void => {
    guard.confirmLeave(() => {
      job.reset();
      router.setParams({ job: undefined });
    });
  };

  const modelNote = runtime.mode === 'demo' ? `Stand-in model: ${DEMO_MODEL_NAME}` : undefined;
  const busy = start.busy || job.driving;

  return (
    <View style={{ gap: space[4] }}>
      <PageHeader
        title="New scheme from a document"
        crumbs={[{ label: 'Schemes', href: '/schemes' }, { label: 'New scheme' }]}
        subtitle="Claude reads the document and drafts the weeks. You check and edit the draft, save it, and a reviewer approves it."
      />

      {denied ? (
        <Banner tone="warning" title="You can look but not start">
          <P>{denied}</P>
        </Banner>
      ) : null}

      {runtime.mode === 'demo' && !job.job ? (
        <Banner tone="warning" title="Demo: the stand-in model does not read your document">
          <P>
            It returns prepared sample content for the subject, level and term you choose. Use Basic
            Science, Primary 1 and Term 2 or 3 to see a full sample scheme.
          </P>
        </Banner>
      ) : null}

      {!job.job && !jobParam ? (
        <Section title="1. What is the document?">
          <Row align="flex-start" gap={space[4]}>
            <View style={{ minWidth: 240, flexGrow: 1 }}>
              <Async state={catalog}>
                {(loaded) => (
                  <Select
                    label="Subject"
                    value={subjectId}
                    placeholder="Choose a subject"
                    options={loaded.subjects.map((subject) => ({
                      value: subject.id,
                      label: subject.name,
                    }))}
                    onChange={setSubjectId}
                    disabled={busy}
                  />
                )}
              </Async>
            </View>
            <View style={{ minWidth: 160 }}>
              <Select
                label="Level"
                value={levelCode}
                options={LevelCode.options.map((code) => ({
                  value: code,
                  label: `Primary ${code.slice(1)}`,
                }))}
                onChange={setLevelCode}
                disabled={busy}
              />
            </View>
            <View style={{ minWidth: 140 }}>
              <Select
                label="Term"
                value={term}
                options={['1', '2', '3'].map((value) => ({ value, label: `Term ${value}` }))}
                onChange={setTerm}
                disabled={busy}
              />
            </View>
          </Row>
          <SourcePicker
            mode={mode}
            onMode={setMode}
            picked={picked}
            onPicked={setPicked}
            pasted={pasted}
            onPasted={setPasted}
            disabled={busy}
          />
          {formProblem ? (
            <Banner tone="danger" title="Check the form" testID="form-problem">
              <P>{formProblem}</P>
            </Banner>
          ) : null}
          {start.error ? (
            <Banner tone="danger" title="The job could not be started" testID="start-error">
              <P>{start.error.message}</P>
            </Banner>
          ) : null}
          <Row>
            <Button
              label="Read the document"
              onPress={() => void start.run()}
              busy={busy}
              disabled={Boolean(denied)}
              reason={denied}
            />
          </Row>
        </Section>
      ) : null}

      {job.job ? (
        <>
          <JobPanel
            job={job.job}
            driving={job.driving}
            error={job.error}
            onCancel={() => void job.cancel()}
            onResume={() => void job.resume(job.job?.id ?? '')}
            canCancel={!denied}
            modelNote={modelNote}
          />
          {job.job.status === 'succeeded' ? (
            <Async state={catalog}>
              {(loaded) => (
                <ResultView
                  job={job.job ?? { result: null }}
                  catalog={loaded}
                  fallbackSubjectId={subjectId}
                />
              )}
            </Async>
          ) : null}
          {job.job.status === 'failed' || job.job.status === 'cancelled' ? (
            <Row>
              <Button label="Start again" variant="secondary" onPress={startOver} />
            </Row>
          ) : null}
          {job.job.status === 'succeeded' ? (
            <Row>
              <Button
                label="Discard this draft and start again"
                variant="ghost"
                small
                onPress={startOver}
              />
            </Row>
          ) : null}
        </>
      ) : jobParam && job.error ? (
        <Banner tone="danger" title="That job could not be opened" testID="job-open-error">
          <P>{job.error.message}</P>
          <AppLink href="/jobs">See all jobs</AppLink>
        </Banner>
      ) : jobParam ? (
        <P style={{ color: colors.subtle }}>Opening the job…</P>
      ) : null}
    </View>
  );
}
