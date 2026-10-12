import { useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import {
  BLANK_PATTERN,
  gradeQuestion,
  type GradeResult,
  type Question,
  type QuestionResponse,
} from '@custar/content-schema';
import {
  layerColors,
  minTouchTarget,
  palette,
  radii,
  space,
  textColors,
} from '@custar/design-tokens';
import { answerSummary } from './answers';
import { Illustration } from './IllustrationPlaceholder';
import { RichText } from './RichText';

export interface QuestionViewProps {
  question: Question;
  /** Shown before the prompt, for example 1 or "3a". */
  number?: number | string;
  resolveAsset?: (assetId: string) => string | undefined;
  /** Called after the child presses Check. Only deterministic grading may grant mastery. */
  onResult?: (result: GradeResult, response: QuestionResponse, question: Question) => void;
  /** Grown-ups and admins can reveal the answer without answering. */
  canRevealAnswer?: boolean;
  /**
   * Big tap targets with a shape on each choice, for a child who cannot read yet and taps (or has a helper
   * tap) the picture-style buttons. Default false: nothing changes for readers.
   */
  largeTargets?: boolean;
  /** Extra content shown under the prompt, for example a read-aloud button. */
  extras?: ReactNode;
}

const teal = layerColors.CORE;

/** Shapes that tell the choices apart without reading ("tap the star"). Alternating teal and amber. */
const MARKERS = ['●', '■', '▲', '★', '◆', '♥'] as const;

function markerFor(index: number): string {
  return MARKERS[index % MARKERS.length] ?? '●';
}

function Choice({
  label,
  selected,
  onPress,
  disabled,
  large = false,
  marker,
  grow = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  large?: boolean;
  /** A shape shown before the label (large targets only). */
  marker?: string;
  /** Share a row with its neighbours instead of hugging its text (large targets in wrapped rows). */
  grow?: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: disabled ?? false }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: large ? 76 : minTouchTarget,
        paddingHorizontal: large ? space[5] : space[4],
        paddingVertical: space[2],
        borderRadius: large ? radii.xl : radii.lg,
        borderWidth: large ? 3 : 2,
        borderColor: selected ? teal.bar : palette.placeholderBorder,
        backgroundColor: selected ? teal.tint : palette.white,
        justifyContent: 'center',
        maxWidth: '100%',
        ...(large ? { flexDirection: 'row' as const, alignItems: 'center' as const } : {}),
        ...(large && grow ? { flexGrow: 1, flexBasis: '45%' as const } : {}),
      }}
    >
      {large && marker ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            fontSize: 30,
            lineHeight: 36,
            marginRight: space[3],
            color: marker === '★' || marker === '◆' ? layerColors.ENRICH.bar : teal.bar,
          }}
        >
          {marker}
        </Text>
      ) : null}
      <Text
        style={{
          flexShrink: 1,
          fontSize: large ? 24 : 18,
          lineHeight: large ? 32 : 26,
          color: textColors.body,
          fontWeight: selected ? '700' : '400',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function initialResponse(question: Question): QuestionResponse {
  switch (question.kind) {
    case 'mcq':
      return { kind: 'mcq', selected_index: -1 };
    case 'fill_blank':
      return { kind: 'fill_blank', answers: question.answer.blanks.map(() => '') };
    case 'match':
      return { kind: 'match', pairs: [] };
    case 'circle':
      return { kind: 'circle', selected: [] };
    case 'sort':
      return { kind: 'sort', placements: {} };
    case 'tap_image':
      return { kind: 'tap_image', hotspot_ids: [] };
    case 'speak':
      return { kind: 'speak', transcript: '' };
    case 'draw':
    case 'free_text':
    case 'spoken':
      return { kind: question.kind, value: '' };
  }
}

/** Right-hand items of a match question in a fixed, answer-independent order (no random reshuffles). */
function matchRights(question: Extract<Question, { kind: 'match' }>): string[] {
  const all = [...question.answer.pairs.map((pair) => pair.right), ...(question.distractors ?? [])];
  return [...all].sort((a, b) => a.localeCompare(b));
}

function Feedback({ result, question }: { result: GradeResult; question: Question }): ReactNode {
  const ungraded = result.result === 'ungraded';
  const color =
    result.result === 'correct'
      ? palette.success
      : result.result === 'partial'
        ? palette.warning
        : ungraded
          ? palette.coreDark
          : palette.danger;
  const message =
    result.result === 'correct'
      ? 'Well done!'
      : result.result === 'partial'
        ? 'Almost there. Look again.'
        : ungraded
          ? 'Saved. Your tutor or grown-up will look at this with you.'
          : 'Not yet. Try again.';
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ borderLeftWidth: 5, borderLeftColor: color, paddingLeft: space[3], gap: space[1] }}
    >
      <Text style={{ color, fontSize: 18, fontWeight: '700' }}>{message}</Text>
      {result.result !== 'correct' && !ungraded && question.hint ? (
        <Text style={{ color: textColors.secondary, fontSize: 16 }}>Hint: {question.hint}</Text>
      ) : null}
      {result.result === 'correct' && question.explanation ? (
        <Text style={{ color: textColors.secondary, fontSize: 16 }}>{question.explanation}</Text>
      ) : null}
    </View>
  );
}

/**
 * One interactive question. Deterministic kinds are graded locally with `gradeQuestion`; open-ended kinds
 * (draw, free_text, spoken) are saved and left to the tutor or a grown-up.
 */
export function QuestionView({
  question,
  number,
  resolveAsset,
  onResult,
  canRevealAnswer = false,
  largeTargets = false,
  extras,
}: QuestionViewProps): ReactNode {
  const [response, setResponse] = useState<QuestionResponse>(() => initialResponse(question));
  const [result, setResult] = useState<GradeResult | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [selectedLeft, setSelectedLeft] = useState<string | null>(null);

  const update = (next: QuestionResponse): void => {
    setResponse(next);
    setResult(null);
  };

  const check = (): void => {
    const graded = gradeQuestion(question, response);
    setResult(graded);
    onResult?.(graded, response, question);
  };

  const body = ((): ReactNode => {
    switch (question.kind) {
      case 'mcq': {
        const current = response.kind === 'mcq' ? response.selected_index : -1;
        return (
          <View style={{ gap: space[2] }}>
            {question.options.map((option, index) => (
              <Choice
                key={index}
                label={option}
                large={largeTargets}
                marker={markerFor(index)}
                selected={current === index}
                onPress={() => update({ kind: 'mcq', selected_index: index })}
              />
            ))}
          </View>
        );
      }

      case 'fill_blank': {
        const answers = response.kind === 'fill_blank' ? response.answers : [];
        const rawParts = question.prompt.split(BLANK_PATTERN);
        // Punctuation right after a blank ("... in the ____.") stays glued to the input so it never
        // wraps onto a line of its own.
        const trailing = rawParts.map((part, index) =>
          index === 0 ? '' : (part.match(/^[.,;:!?)”’'"-]+/)?.[0] ?? ''),
        );
        const parts = rawParts.map((part, index) => part.slice(trailing[index]?.length ?? 0));
        return (
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] }}
          >
            {parts.map((part, index) => (
              <View
                key={index}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}
              >
                {part.trim() ? <RichText>{part.trim()}</RichText> : null}
                {index < parts.length - 1 ? (
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
                    <TextInput
                      accessibilityLabel={`Answer ${index + 1}`}
                      value={answers[index] ?? ''}
                      onChangeText={(text) => {
                        const next = [...answers];
                        next[index] = text;
                        update({ kind: 'fill_blank', answers: next });
                      }}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        width: largeTargets ? 220 : 150,
                        minHeight: largeTargets ? 68 : minTouchTarget,
                        borderBottomWidth: 3,
                        borderBottomColor: teal.bar,
                        backgroundColor: palette.placeholderBg,
                        paddingHorizontal: space[3],
                        fontSize: largeTargets ? 26 : 20,
                        color: textColors.body,
                      }}
                    />
                    {trailing[index + 1] ? (
                      <RichText style={{ marginLeft: 2 }}>{trailing[index + 1] ?? ''}</RichText>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        );
      }

      case 'match': {
        const pairs = response.kind === 'match' ? response.pairs : [];
        const rights = matchRights(question);
        const rightOf = (left: string): string | undefined =>
          pairs.find((pair) => pair.left === left)?.right;
        return (
          <View style={{ gap: space[3] }}>
            <Text style={{ color: textColors.secondary, fontSize: 16 }}>
              Tap a word on the left, then tap its match on the right.
            </Text>
            <View style={{ flexDirection: 'row', gap: space[4] }}>
              <View style={{ flex: 1, gap: space[2] }}>
                {question.answer.pairs.map((pair) => (
                  <Choice
                    key={pair.left}
                    label={rightOf(pair.left) ? `${pair.left} → ${rightOf(pair.left)}` : pair.left}
                    large={largeTargets}
                    selected={selectedLeft === pair.left || rightOf(pair.left) !== undefined}
                    onPress={() => setSelectedLeft(pair.left)}
                  />
                ))}
              </View>
              <View style={{ flex: 1, gap: space[2] }}>
                {rights.map((right) => (
                  <Choice
                    key={right}
                    label={right}
                    large={largeTargets}
                    selected={pairs.some((pair) => pair.right === right)}
                    onPress={() => {
                      if (selectedLeft === null) return;
                      const next = pairs.filter(
                        (pair) => pair.left !== selectedLeft && pair.right !== right,
                      );
                      next.push({ left: selectedLeft, right });
                      update({ kind: 'match', pairs: next });
                      setSelectedLeft(null);
                    }}
                  />
                ))}
              </View>
            </View>
          </View>
        );
      }

      case 'circle': {
        const selected = response.kind === 'circle' ? response.selected : [];
        return (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {question.options.map((option, index) => (
              <Choice
                key={option}
                label={option}
                large={largeTargets}
                grow
                marker={markerFor(index)}
                selected={selected.includes(option)}
                onPress={() =>
                  update({
                    kind: 'circle',
                    selected: selected.includes(option)
                      ? selected.filter((value) => value !== option)
                      : [...selected, option],
                  })
                }
              />
            ))}
          </View>
        );
      }

      case 'sort': {
        const placements = response.kind === 'sort' ? response.placements : {};
        return (
          <View style={{ gap: space[3] }}>
            {question.items.map((item) => (
              <View key={item} style={{ gap: space[2] }}>
                <RichText style={{ fontWeight: '700' }}>{item}</RichText>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                  {question.categories.map((category, index) => (
                    <Choice
                      key={category}
                      label={category}
                      large={largeTargets}
                      grow
                      marker={markerFor(index)}
                      selected={placements[item] === category}
                      onPress={() =>
                        update({ kind: 'sort', placements: { ...placements, [item]: category } })
                      }
                    />
                  ))}
                </View>
              </View>
            ))}
          </View>
        );
      }

      case 'tap_image': {
        const chosen = response.kind === 'tap_image' ? response.hotspot_ids : [];
        const uri = question.asset_id ? resolveAsset?.(question.asset_id) : undefined;
        return (
          <View style={{ gap: space[3] }}>
            <Illustration
              brief={question.brief ?? question.alt}
              alt={question.alt}
              {...(uri ? { uri } : {})}
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {question.answer.hotspots.map((hotspot, index) => (
                <Choice
                  key={hotspot.id}
                  label={hotspot.label}
                  large={largeTargets}
                  grow
                  marker={markerFor(index)}
                  selected={chosen.includes(hotspot.id)}
                  onPress={() =>
                    update({
                      kind: 'tap_image',
                      hotspot_ids: chosen.includes(hotspot.id)
                        ? chosen.filter((id) => id !== hotspot.id)
                        : [...chosen, hotspot.id],
                    })
                  }
                />
              ))}
            </View>
          </View>
        );
      }

      case 'speak':
        return (
          <View style={{ gap: space[2] }}>
            <Text style={{ color: textColors.secondary, fontSize: 16 }}>
              Voice answers are coming soon. For now, type what you would say.
            </Text>
            <TextInput
              accessibilityLabel="Type what you would say"
              value={response.kind === 'speak' ? response.transcript : ''}
              onChangeText={(text) => update({ kind: 'speak', transcript: text })}
              style={inputStyle}
            />
          </View>
        );

      case 'draw':
        return (
          <View style={{ gap: space[2] }}>
            <Text style={{ color: textColors.secondary, fontSize: 16 }}>
              Draw this in your notebook, then check it yourself.
            </Text>
            {(question.self_check ?? []).map((item) => (
              <Text key={item} style={{ fontSize: 18, color: textColors.body }}>
                ☐ {item}
              </Text>
            ))}
          </View>
        );

      case 'free_text':
      case 'spoken':
        return (
          <TextInput
            accessibilityLabel="Your answer"
            multiline
            value={
              typeof (response as { value?: unknown }).value === 'string'
                ? (response as { value: string }).value
                : ''
            }
            onChangeText={(text) => update({ kind: question.kind, value: text })}
            style={[inputStyle, { minHeight: 80, textAlignVertical: 'top' }]}
          />
        );
    }
  })();

  return (
    <View style={{ gap: space[3] }}>
      {question.kind !== 'fill_blank' ? (
        <View style={{ flexDirection: 'row', gap: space[2] }}>
          {number !== undefined ? (
            <Text style={{ fontSize: 18, fontWeight: '700', color: teal.bar }}>{number}.</Text>
          ) : null}
          <View style={{ flex: 1 }}>
            <RichText style={{ fontWeight: '700' }}>{question.prompt}</RichText>
          </View>
        </View>
      ) : number !== undefined ? (
        <Text style={{ fontSize: 18, fontWeight: '700', color: teal.bar }}>{number}.</Text>
      ) : null}
      {extras ?? null}
      {body}
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center', flexWrap: 'wrap' }}>
        <Pressable
          accessibilityRole="button"
          onPress={check}
          style={{
            minHeight: largeTargets ? 64 : minTouchTarget,
            paddingHorizontal: largeTargets ? space[8] : space[6],
            borderRadius: radii.pill,
            backgroundColor: teal.bar,
            justifyContent: 'center',
          }}
        >
          <Text
            style={{ color: palette.white, fontSize: largeTargets ? 22 : 18, fontWeight: '700' }}
          >
            {question.kind === 'draw' || question.kind === 'free_text' || question.kind === 'spoken'
              ? 'Save'
              : 'Check'}
          </Text>
        </Pressable>
        {canRevealAnswer ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setRevealed((value) => !value)}
            style={{
              minHeight: minTouchTarget,
              paddingHorizontal: space[3],
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: teal.text, fontSize: 16, fontWeight: '600' }}>
              {revealed ? 'Hide answer' : 'Show answer'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {revealed ? (
        <Text style={{ fontSize: 16, color: textColors.secondary }}>
          Answer: {answerSummary(question) ?? '(open answer)'}
        </Text>
      ) : null}
      {result ? <Feedback result={result} question={question} /> : null}
    </View>
  );
}

const inputStyle = {
  minHeight: minTouchTarget,
  borderWidth: 2,
  borderColor: palette.placeholderBorder,
  borderRadius: radii.md,
  paddingHorizontal: space[3],
  paddingVertical: space[2],
  fontSize: 18,
  color: textColors.body,
  backgroundColor: palette.white,
} as const;
