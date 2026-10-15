// The unit header (title, objective, stage, theme, where it sits in the scheme) and, for revision and assessment
// units, the scoring. The objective is the NERDC objective from the scheme of work and is shown first and plainly:
// enrichment adds depth and never replaces it.
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { UnitKind } from '@custar/content-schema';
import { Small } from '../../ui/Text';
import { space } from '../../ui/theme';
import type { HeaderContext } from '../headerStamp';
import { removeAt, setAt } from '../path';
import { useActions, useEnv, useIssuesAt } from './context';
import { AddButton, IssueLines, Note, Num, Pick, Row, SubHeading, Txt } from './Fields';

type Rec = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const STAGES = [
  { value: 'absorb', label: 'Absorb (nursery to lower primary)' },
  { value: 'connect', label: 'Connect (primary)' },
  { value: 'express', label: 'Express (upper primary)' },
];

export function OverviewEditor({
  header,
  kind,
  context,
  scoring,
}: {
  header: Rec;
  kind: UnitKind;
  context: HeaderContext | null;
  scoring: Rec | undefined;
}): ReactNode {
  const actions = useActions();
  const env = useEnv();
  const rootIssues = useIssuesAt([]);
  const headerIssues = useIssuesAt(['header']);
  const theme =
    typeof header.theme === 'object' && header.theme !== null ? (header.theme as Rec) : undefined;
  const chapter = (
    typeof header.chapter === 'object' && header.chapter !== null ? header.chapter : undefined
  ) as Rec | undefined;
  return (
    <View style={{ gap: space[3] }}>
      <IssueLines issues={rootIssues} />
      <IssueLines issues={headerIssues} />
      <SubHeading>What this unit teaches</SubHeading>
      <Txt path={['header', 'title']} label="Title" value={str(header.title)} />
      <Txt
        path={['header', 'objective']}
        label="Objective (NERDC, verbatim from the scheme of work)"
        value={str(header.objective)}
        multiline
        rows={3}
        counts
        hint="Keep the scheme's own words. Enrichment adds depth to it and never replaces it."
      />
      <Row>
        <View style={{ minWidth: 240, flexGrow: 1, maxWidth: 360 }}>
          <Pick
            path={['header', 'stage']}
            label="Stage"
            value={str(header.stage)}
            options={STAGES}
          />
        </View>
        <View style={{ minWidth: 240, flexGrow: 1, maxWidth: 360 }}>
          <Pick
            path={['header', 'stage_to']}
            label="Stage it reaches (optional)"
            value={str(header.stage_to)}
            options={[{ value: '', label: 'Stays in one stage' }, ...STAGES]}
            hint="Only when the unit straddles two stages. The higher one."
          />
        </View>
      </Row>

      <SubHeading>Where it sits in the scheme</SubHeading>
      <Note>
        {str(header.subject_slug)} · {str(header.level_code)} · Term {String(header.term ?? '?')}
        {chapter ? ` · Chapter ${String(chapter.number ?? '?')}: ${str(chapter.title)}` : ''}
        {header.unit_no !== undefined ? ` · Unit ${String(header.unit_no)}` : ''}
        {header.week_no !== undefined ? ` · Week ${String(header.week_no)}` : ''}
        {'. '}
        The scheme and the chapter planner decide these. When you save, the unit's current number,
        chapter and week are written into this header.
        {context
          ? ` Right now it is chapter ${context.chapter.number}, unit ${context.unit_no}${context.week_no ? `, week ${context.week_no}` : ''}.`
          : ''}
      </Note>
      {env.weekEditable ? (
        <Num
          path={['header', 'week_no']}
          label="Scheme week (1 to 15)"
          value={typeof header.week_no === 'number' ? header.week_no : null}
          hint="This unit has no week in the scheme, so you set it."
        />
      ) : null}

      <SubHeading>Theme (optional)</SubHeading>
      {theme ? (
        <>
          <Row>
            <View style={{ minWidth: 220, flexGrow: 1 }}>
              <Txt
                path={['header', 'theme', 'slug']}
                label="Theme slug"
                value={str(theme.slug)}
                mono
                hint="Lowercase, hyphenated, for example market-day."
              />
            </View>
            <View style={{ minWidth: 220, flexGrow: 1 }}>
              <Txt
                path={['header', 'theme', 'title']}
                label="Theme title"
                value={str(theme.title)}
              />
            </View>
          </Row>
          <Txt
            path={['header', 'theme', 'lens']}
            label="This subject's lens on the theme"
            value={str(theme.lens)}
            hint='For example "Value", "Observation" or "Language".'
          />
          <AddButton
            label="Remove the theme"
            onPress={() => actions.commit((u) => removeAt(u, ['header', 'theme']))}
          />
        </>
      ) : (
        <>
          <Small>This unit is not tied to a cross-subject theme.</Small>
          <AddButton
            label="Add a theme"
            onPress={() =>
              actions.commit((u) =>
                setAt(u, ['header', 'theme'], { slug: '', title: '', lens: '' }),
              )
            }
          />
        </>
      )}

      {kind === 'revision' || kind === 'assessment' ? (
        <>
          <SubHeading>Scoring</SubHeading>
          <Row>
            <Num
              path={['scoring', 'total_marks']}
              label="Total marks"
              value={typeof scoring?.total_marks === 'number' ? scoring.total_marks : null}
            />
            <Num
              path={['scoring', 'pass_mark']}
              label="Pass mark"
              value={typeof scoring?.pass_mark === 'number' ? scoring.pass_mark : null}
              hint="Not more than the total."
            />
          </Row>
        </>
      ) : null}
    </View>
  );
}
