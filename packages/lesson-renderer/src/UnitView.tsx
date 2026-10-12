import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import {
  questionsOf,
  sectionsOf,
  type GradeResult,
  type Question,
  type QuestionResponse,
  type Section,
  type UnitContent,
} from '@custar/content-schema';
import { layerColors, minTouchTarget, palette, space, textColors } from '@custar/design-tokens';
import { ProjectView } from './ProjectView';
import { RichText } from './RichText';
import { SectionView } from './SectionView';
import { TeacherManualView } from './TeacherManualView';
import { WorkbookView } from './WorkbookView';
import { isGrownUpMode, levelName, stageLine, subjectName, type ViewMode } from './labels';

export interface UnitViewProps {
  unit: UnitContent;
  /** `student` hides layer badges, the teacher's manual and answers by default. */
  mode?: ViewMode;
  resolveAsset?: (assetId: string) => string | undefined;
  /** Fired after each Check press. Only deterministic results may grant mastery. */
  onQuestionResult?: (result: GradeResult, response: QuestionResponse, question: Question) => void;
  initialTab?: UnitTab;
  /** Lay the page out at most this wide (centred on tablets and web). */
  maxWidth?: number;
  /** Shown right under each section bar, for example a read-aloud button. Default: nothing. */
  renderSectionExtras?: (section: Section) => ReactNode;
  /** Shown under each question's prompt, for example a read-aloud button. Default: nothing. */
  renderQuestionExtras?: (question: Question) => ReactNode;
  /** Big picture-style tap targets for a child who cannot read yet. Default false. */
  largeTargets?: boolean;
}

export type UnitTab = 'textbook' | 'workbook' | 'manual';

const KIND_LABEL: Record<UnitContent['kind'], string> = {
  lesson: "The Child's Textbook",
  mini_project: 'Mini Project',
  term_project: 'End-of-Term Project',
  revision: 'Revision',
  assessment: 'Assessment',
};

const teal = layerColors.CORE;

function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: UnitTab; label: string }[];
  active: UnitTab;
  onChange: (tab: UnitTab) => void;
}): ReactNode {
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: palette.placeholderBorder,
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(tab.id)}
            style={{
              minHeight: minTouchTarget,
              paddingHorizontal: space[4],
              justifyContent: 'center',
              borderBottomWidth: 4,
              borderBottomColor: selected ? teal.bar : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: 18,
                fontWeight: selected ? '700' : '500',
                color: selected ? teal.text : textColors.muted,
              }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Renders a unit of any kind: the NERDC objective is shown first and prominently, then the sections.
 * Lessons get Textbook / Workbook (and, for grown-ups, Teacher's manual) tabs.
 */
export function UnitView({
  unit,
  mode = 'student',
  resolveAsset,
  onQuestionResult,
  initialTab = 'textbook',
  maxWidth = 760,
  renderSectionExtras,
  renderQuestionExtras,
  largeTargets = false,
}: UnitViewProps): ReactNode {
  const [tab, setTab] = useState<UnitTab>(initialTab);
  const { header } = unit;
  const grownUp = isGrownUpMode(mode);

  const kicker =
    `${subjectName(header.subject_slug)} · ${levelName(header.level_code)}`.toUpperCase();
  const subtitle = [
    `Term ${header.term}`,
    header.chapter ? `Chapter ${header.chapter.number}: ${header.chapter.title}` : null,
    header.week_no ? `Week ${header.week_no}` : null,
    KIND_LABEL[unit.kind],
  ]
    .filter(Boolean)
    .join(' · ');

  const tabs: { id: UnitTab; label: string }[] = [
    { id: 'textbook', label: 'Textbook' },
    { id: 'workbook', label: 'Workbook' },
    ...(grownUp ? [{ id: 'manual' as const, label: "Teacher's manual" }] : []),
  ];

  const sectionProps = {
    questions: questionsOf(unit),
    mode,
    ...(resolveAsset ? { resolveAsset } : {}),
    ...(onQuestionResult ? { onQuestionResult } : {}),
    ...(renderSectionExtras ? { renderSectionExtras } : {}),
    ...(renderQuestionExtras ? { renderQuestionExtras } : {}),
    largeTargets,
  };

  const content = ((): ReactNode => {
    if (unit.kind === 'mini_project' || unit.kind === 'term_project') {
      return <ProjectView unit={unit} mode={mode} />;
    }
    if (unit.kind === 'lesson') {
      if (tab === 'workbook') {
        return (
          <WorkbookView
            unit={unit}
            mode={mode}
            largeTargets={largeTargets}
            {...(renderQuestionExtras ? { renderQuestionExtras } : {})}
            {...(resolveAsset ? { resolveAsset } : {})}
            {...(onQuestionResult ? { onQuestionResult } : {})}
          />
        );
      }
      if (tab === 'manual' && grownUp) return <TeacherManualView unit={unit} />;
    }
    return (
      <View style={{ gap: space[6] }}>
        {sectionsOf(unit).map((section) => (
          <SectionView key={section.id} section={section} {...sectionProps} />
        ))}
        {unit.kind === 'revision' || unit.kind === 'assessment' ? (
          <RichText color={textColors.secondary}>
            {`Total marks: ${unit.scoring.total_marks} · Pass mark: ${unit.scoring.pass_mark}`}
          </RichText>
        ) : null}
      </View>
    );
  })();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.white }}
      contentContainerStyle={{
        alignItems: 'center',
        paddingVertical: space[6],
        paddingHorizontal: space[4],
      }}
    >
      <View style={{ width: '100%', maxWidth, gap: space[5] }}>
        <View style={{ gap: space[1] }}>
          <Text
            style={{
              color: teal.bar,
              fontSize: 14,
              lineHeight: 20,
              fontWeight: '700',
              letterSpacing: 0.8,
            }}
          >
            {kicker}
          </Text>
          <Text
            accessibilityRole="header"
            style={{ color: textColors.heading, fontSize: 34, lineHeight: 42, fontWeight: '700' }}
          >
            {`Unit ${header.unit_no ?? ''}${header.unit_no ? ' — ' : ''}${header.title}`}
          </Text>
          <Text
            style={{ color: textColors.muted, fontSize: 15, lineHeight: 22, fontStyle: 'italic' }}
          >
            {subtitle}
          </Text>
          <View
            style={{ height: 3, backgroundColor: layerColors.ENRICH.bar, marginTop: space[2] }}
          />
        </View>

        <View
          style={{
            backgroundColor: teal.tint,
            borderLeftWidth: 6,
            borderLeftColor: teal.bar,
            padding: space[4],
            gap: space[2],
          }}
        >
          <RichText
            color={textColors.secondary}
          >{`**Objective (NERDC):** ${header.objective}`}</RichText>
          <RichText color={textColors.secondary}>
            {`**Stage:** ${stageLine(header.stage, header.stage_to)}`}
          </RichText>
        </View>

        {unit.kind === 'lesson' ? <Tabs tabs={tabs} active={tab} onChange={setTab} /> : null}

        {content}
      </View>
    </ScrollView>
  );
}
