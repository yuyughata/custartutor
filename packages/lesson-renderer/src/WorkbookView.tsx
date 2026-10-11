import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { GradeResult, LessonUnit, Question, QuestionResponse } from '@custar/content-schema';
import { layerColors, minTouchTarget, radii, space, textColors } from '@custar/design-tokens';
import { answerSummary } from './answers';
import { QuestionView } from './QuestionView';
import { RichText } from './RichText';
import { isGrownUpMode, type ViewMode } from './labels';

export interface WorkbookViewProps {
  unit: LessonUnit;
  mode: ViewMode;
  resolveAsset?: (assetId: string) => string | undefined;
  onQuestionResult?: (result: GradeResult, response: QuestionResponse, question: Question) => void;
}

const teal = layerColors.CORE;

function TierHeading({ children }: { children: string }): ReactNode {
  return (
    <Text
      accessibilityRole="header"
      style={{ color: textColors.heading, fontSize: 24, lineHeight: 32, fontWeight: '700' }}
    >
      {children}
    </Text>
  );
}

/** The matching workbook: tiered practice, a 60-second drill, Take It Home, and answers for self-check. */
export function WorkbookView({
  unit,
  mode,
  resolveAsset,
  onQuestionResult,
}: WorkbookViewProps): ReactNode {
  const { workbook, questions } = unit;
  const [showAnswers, setShowAnswers] = useState(isGrownUpMode(mode));
  const answerable = (ids: string[]): Question[] =>
    ids.flatMap((id) => {
      const question = questions[id];
      return question ? [question] : [];
    });
  const shared = {
    canRevealAnswer: isGrownUpMode(mode),
    ...(resolveAsset ? { resolveAsset } : {}),
    ...(onQuestionResult ? { onResult: onQuestionResult } : {}),
  };

  let counter = 0;
  const allIds: string[] = [];

  return (
    <View style={{ gap: space[6] }}>
      {workbook.intro ? (
        <RichText color={textColors.secondary}>{`**How this works:** ${workbook.intro}`}</RichText>
      ) : null}

      {workbook.tiers.map((tier) => (
        <View key={tier.tier} style={{ gap: space[4] }}>
          <TierHeading>{`Tier ${tier.tier} — ${tier.title}`}</TierHeading>
          {answerable(tier.question_ids).map((question) => {
            counter += 1;
            allIds.push(question.id);
            return (
              <QuestionView key={question.id} question={question} number={counter} {...shared} />
            );
          })}
        </View>
      ))}

      <View style={{ gap: space[4] }}>
        <TierHeading>{`Quick-Answer Drill (${workbook.quick_answer_drill.seconds} seconds)`}</TierHeading>
        <Text style={{ fontSize: 16, color: textColors.secondary }}>
          Ask a friend to time you. Answer out loud, fast!
        </Text>
        {answerable(workbook.quick_answer_drill.question_ids).map((question, index) => {
          allIds.push(question.id);
          return (
            <QuestionView key={question.id} question={question} number={index + 1} {...shared} />
          );
        })}
      </View>

      <View style={{ gap: space[3] }}>
        <TierHeading>Take It Home</TierHeading>
        <View
          style={{
            backgroundColor: teal.tint,
            borderLeftWidth: 5,
            borderLeftColor: teal.bar,
            padding: space[4],
            gap: space[3],
          }}
        >
          <RichText>{workbook.take_it_home}</RichText>
        </View>
        {questions[workbook.application_task_id] ? (
          <QuestionView
            question={questions[workbook.application_task_id] as Question}
            {...shared}
          />
        ) : null}
      </View>

      <View style={{ gap: space[3] }}>
        <TierHeading>Answers (for self-check)</TierHeading>
        {showAnswers ? (
          <View style={{ gap: space[2] }}>
            {workbook.answers_note ? <RichText>{workbook.answers_note}</RichText> : null}
            {[...new Set(allIds)].map((id, index) => {
              const question = questions[id];
              const summary = question ? answerSummary(question) : null;
              return summary ? (
                <RichText key={id}>{`**${index + 1}.** ${summary}`}</RichText>
              ) : null;
            })}
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowAnswers(true)}
            style={{
              minHeight: minTouchTarget,
              alignSelf: 'flex-start',
              paddingHorizontal: space[6],
              borderRadius: radii.pill,
              borderWidth: 2,
              borderColor: teal.bar,
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: teal.text, fontSize: 18, fontWeight: '700' }}>Show answers</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
