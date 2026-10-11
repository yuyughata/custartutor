import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { GradeResult, Question, QuestionResponse, Section } from '@custar/content-schema';
import { space } from '@custar/design-tokens';
import { BlockView } from './BlockView';
import { QuestionView } from './QuestionView';
import { SectionBar } from './SectionBar';
import { isGrownUpMode, type ViewMode } from './labels';

export interface SectionViewProps {
  section: Section;
  questions: Record<string, Question>;
  mode: ViewMode;
  resolveAsset?: (assetId: string) => string | undefined;
  onQuestionResult?: (result: GradeResult, response: QuestionResponse, question: Question) => void;
}

/** One lesson section: its coloured bar, then its blocks (questions are interactive). */
export function SectionView({
  section,
  questions,
  mode,
  resolveAsset,
  onQuestionResult,
}: SectionViewProps): ReactNode {
  let questionNumber = 0;
  return (
    <View style={{ gap: space[3] }}>
      <SectionBar heading={section.heading} layer={section.layer} showBadge={isGrownUpMode(mode)} />
      <View style={{ gap: space[3] }}>
        {section.blocks.map((block, index) => {
          if (block.type === 'question') questionNumber += 1;
          const number = questionNumber;
          return (
            <BlockView
              key={index}
              block={block}
              layer={section.layer}
              showUnknown={mode === 'admin'}
              {...(resolveAsset ? { resolveAsset } : {})}
              renderQuestion={(questionId) => {
                const question = questions[questionId];
                return question ? (
                  <QuestionView
                    question={question}
                    number={number}
                    canRevealAnswer={isGrownUpMode(mode)}
                    {...(resolveAsset ? { resolveAsset } : {})}
                    {...(onQuestionResult ? { onResult: onQuestionResult } : {})}
                  />
                ) : null;
              }}
            />
          );
        })}
      </View>
    </View>
  );
}
