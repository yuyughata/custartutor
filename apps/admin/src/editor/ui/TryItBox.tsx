// "Try it": type or pick an answer and see how the REAL offline grader (the same function the learner app and the tutor
// use) would mark it. Nothing is saved and nothing is sent anywhere; the box only reads the question as it is now.
import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { isDeterministic, type Question } from '@custar/content-schema';
import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { Small } from '../../ui/Text';
import { colors, radii, space } from '../../ui/theme';
import { emptyTry, matchChoicesFor, tryIt, type TryInput } from '../tryIt';
import { TextEditor } from './TextEditor';

function Choice({
  label,
  on,
  onPress,
  name,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  name: string;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={name}
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={{
        minHeight: 36,
        paddingHorizontal: space[3],
        paddingVertical: space[1],
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        borderRadius: radii.md,
        borderWidth: 1.5,
        borderColor: on ? colors.primary : colors.borderStrong,
        backgroundColor: on ? colors.primaryTint : colors.white,
      }}
    >
      <Text aria-hidden style={{ color: on ? colors.primaryDark : colors.subtle }}>
        {on ? '●' : '○'}
      </Text>
      <Text style={{ fontSize: 14, color: colors.text, flexShrink: 1 }}>{label || '(empty)'}</Text>
    </Pressable>
  );
}

export function TryItBox({
  question,
  idPrefix,
}: {
  question: Question;
  idPrefix: string;
}): ReactNode {
  const [input, setInput] = useState<TryInput>(emptyTry());
  const set = (patch: Partial<TryInput>): void => setInput((current) => ({ ...current, ...patch }));
  const outcome = tryIt(question, input);
  const graded = isDeterministic(question);

  let body: ReactNode = null;
  switch (question.kind) {
    case 'mcq':
      body = (
        <View style={{ gap: space[1] }}>
          {question.options.map((option, index) => (
            <Choice
              key={index}
              label={option}
              name={`Try option ${index + 1}`}
              on={input.selectedIndex === index}
              onPress={() => set({ selectedIndex: index })}
            />
          ))}
        </View>
      );
      break;
    case 'fill_blank':
      body = (
        <View style={{ gap: space[2] }}>
          {question.answer.blanks.map((_, index) => (
            <TextEditor
              key={index}
              label={`Try blank ${index + 1}`}
              value={input.answers[index] ?? ''}
              fieldKey={`${idPrefix}.try.blank${index}`}
              onChange={(text) => {
                const answers = question.answer.blanks.map((__, i) => input.answers[i] ?? '');
                answers[index] = text;
                set({ answers });
              }}
            />
          ))}
        </View>
      );
      break;
    case 'match': {
      const choices = matchChoicesFor(question);
      body = (
        <View style={{ gap: space[2] }}>
          {question.answer.pairs.map((pair, index) => (
            <Select
              key={index}
              label={`Try: ${pair.left.trim() === '' ? `left side ${index + 1}` : pair.left} matches`}
              value={input.pairs[pair.left] ?? ''}
              placeholder="Choose…"
              options={choices.map((c) => ({ value: c, label: c }))}
              onChange={(value) => set({ pairs: { ...input.pairs, [pair.left]: value } })}
            />
          ))}
        </View>
      );
      break;
    }
    case 'circle':
      body = (
        <View style={{ gap: space[1] }}>
          {question.options.map((option, index) => {
            const on = input.selected.includes(option);
            return (
              <Choice
                key={index}
                label={option}
                name={`Try circling option ${index + 1}`}
                on={on}
                onPress={() =>
                  set({
                    selected: on
                      ? input.selected.filter((s) => s !== option)
                      : [...input.selected, option],
                  })
                }
              />
            );
          })}
        </View>
      );
      break;
    case 'sort':
      body = (
        <View style={{ gap: space[2] }}>
          {question.items.map((item, index) => (
            <Select
              key={index}
              label={`Try: ${item.trim() === '' ? `item ${index + 1}` : item} goes in`}
              value={input.placements[item] ?? ''}
              placeholder="Choose a group…"
              options={question.categories.map((c) => ({ value: c, label: c }))}
              onChange={(value) => set({ placements: { ...input.placements, [item]: value } })}
            />
          ))}
        </View>
      );
      break;
    case 'tap_image':
      body = (
        <View style={{ gap: space[1] }}>
          {question.answer.hotspots.map((h, index) => {
            const on = input.hotspotIds.includes(h.id);
            return (
              <Choice
                key={h.id + index}
                label={h.label || h.id}
                name={`Try tapping area ${index + 1}`}
                on={on}
                onPress={() =>
                  set({
                    hotspotIds: on
                      ? input.hotspotIds.filter((id) => id !== h.id)
                      : [...input.hotspotIds, h.id],
                  })
                }
              />
            );
          })}
        </View>
      );
      break;
    case 'speak':
      body = (
        <TextEditor
          label="Try a transcript"
          value={input.transcript}
          fieldKey={`${idPrefix}.try.transcript`}
          onChange={(text) => set({ transcript: text })}
        />
      );
      break;
    default:
      body = null;
  }

  return (
    <View
      testID={`tryit-${idPrefix}`}
      style={{
        gap: space[2],
        padding: space[3],
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.amber,
        backgroundColor: colors.amberTint,
      }}
    >
      <Text style={{ fontSize: 15, fontWeight: '800', color: colors.amberText }}>Try it</Text>
      <Small>
        {graded
          ? 'Answer the question as a child would. The result is what the real offline marker says; nothing is saved.'
          : 'This kind of question is not marked offline.'}
      </Small>
      {body}
      <Banner
        tone={
          outcome.kind === 'graded'
            ? outcome.result.result === 'correct'
              ? 'success'
              : outcome.result.result === 'partial'
                ? 'warning'
                : 'danger'
            : 'info'
        }
        title={outcome.headline}
        testID={`tryit-result-${idPrefix}`}
      >
        {outcome.lines.map((line, index) => (
          <Small key={index}>{line}</Small>
        ))}
      </Banner>
      {graded ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Button
            label="Clear my answer"
            small
            variant="secondary"
            onPress={() => setInput(emptyTry())}
          />
        </View>
      ) : null}
    </View>
  );
}
