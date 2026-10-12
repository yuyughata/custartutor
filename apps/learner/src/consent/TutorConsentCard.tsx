import { useCallback, useEffect, useReducer } from 'react';
import { Text, View } from 'react-native';
import { TutorApiError } from '@custar/tutor-core/client';
import { palette, radii, space, textColors, typeScale } from '@custar/design-tokens';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, Card, ErrorText } from '../ui';
import { Checkbox } from './Checkbox';
import {
  canTurnOff,
  canTurnOn,
  consentIsOn,
  consentIsStale,
  consentReducer,
  failureMessage,
  initialConsentState,
  wordingMismatch,
} from './consentMachine';
import {
  DRAFT_BANNER_BODY,
  DRAFT_BANNER_TITLE,
  splitPlaceholders,
  tutorConsentText,
} from './tutorConsentText';

/** A paragraph with its [bracketed] placeholders marked so nobody reads them as settled facts. */
function ConsentParagraph({ heading, body }: { heading: string; body: string }) {
  return (
    <Text style={{ ...typeScale.body, color: textColors.body }}>
      <Text style={{ fontWeight: '700' }}>{heading} </Text>
      {splitPlaceholders(body).map((part, index) =>
        part.placeholder ? (
          <Text
            key={index}
            style={{
              backgroundColor: palette.enrichTint,
              color: palette.enrichDark,
              fontWeight: '700',
            }}
          >
            {part.text}
          </Text>
        ) : (
          <Text key={index}>{part.text}</Text>
        ),
      )}
    </Text>
  );
}

/**
 * "AI tutor for this child": the state, the consent wording (always shown in full, limits included), the
 * required checkbox and the Turn on / Turn off buttons.
 */
export function TutorConsentCard({
  childId,
  alias,
  ensureElevated,
  onLapsed,
  onChanged,
}: {
  childId: string;
  alias: string;
  /** True when a live elevation is in force; otherwise it opens the PIN gate and returns false. */
  ensureElevated: () => boolean;
  /** The server said the elevation has lapsed. */
  onLapsed: () => void;
  /** The consent changed (so the conversations list can refresh). */
  onChanged: () => void;
}) {
  const { runtime } = useRuntime();
  const [state, dispatch] = useReducer(consentReducer, initialConsentState);
  const text = tutorConsentText(alias);
  const on = consentIsOn(state.consent);
  const stale = consentIsStale(state.consent);

  const load = useCallback(async () => {
    dispatch({ type: 'load' });
    try {
      dispatch({ type: 'loaded', consent: await runtime.tutor.consent(childId) });
    } catch (error) {
      dispatch({
        type: 'loadFailed',
        code: error instanceof TutorApiError ? error.code : 'internal',
      });
    }
  }, [runtime, childId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(action: 'grant' | 'withdraw') {
    // Granting needs a live elevation; withdrawing never does.
    if (action === 'grant' && !ensureElevated()) {
      dispatch({ type: 'saveFailed', code: 'elevation_required' });
      return;
    }
    dispatch({ type: 'saveStart', action });
    try {
      await runtime.tutor.setConsent(childId, action);
      dispatch({ type: 'saved', action });
      onChanged();
      await load();
    } catch (error) {
      const code = error instanceof TutorApiError ? error.code : 'internal';
      if (code === 'elevation_required') onLapsed();
      dispatch({ type: 'saveFailed', code });
    }
  }

  return (
    <View style={{ gap: space[4] }}>
      <Card tone={on ? 'core' : 'plain'}>
        {state.load === 'loading' ? <Body muted>Checking…</Body> : null}
        {state.load === 'failed' ? (
          <ErrorText>
            {state.loadFailure === 'offline'
              ? 'These settings need the internet. Please connect and open this page again.'
              : failureMessage(state.loadFailure ?? 'internal')}
          </ErrorText>
        ) : null}
        {state.load === 'ready' ? (
          <Body role="bodyLarge">
            {on
              ? `The AI tutor is ON for ${alias}.`
              : stale
                ? `The AI tutor was turned on for ${alias} with older wording. Please read the text below and accept again, or turn it off.`
                : `The AI tutor is OFF for ${alias}. Lessons and the offline tutor still work.`}
          </Body>
        ) : null}
        {state.message ? (
          state.message.tone === 'problem' ? (
            <ErrorText>{state.message.text}</ErrorText>
          ) : (
            <Body>{state.message.text}</Body>
          )
        ) : null}
        {state.load === 'ready' && wordingMismatch(state.consent) ? (
          <ErrorText>
            This version of the app does not have the latest wording, so the tutor cannot be turned
            on from here. Please update the app.
          </ErrorText>
        ) : null}
        {canTurnOff(state) ? (
          <Button
            label="Turn off the AI tutor"
            variant="secondary"
            busy={state.saving === 'withdraw'}
            onPress={() => save('withdraw')}
          />
        ) : null}
      </Card>

      {text.isDraft ? (
        <View
          accessibilityRole="alert"
          style={{
            backgroundColor: palette.enrichTint,
            borderWidth: 3,
            borderColor: palette.enrich,
            borderRadius: radii.lg,
            padding: space[4],
            gap: space[1],
          }}
        >
          <Text style={{ ...typeScale.bodyLarge, fontWeight: '700', color: palette.enrichDark }}>
            {DRAFT_BANNER_TITLE}
          </Text>
          <Text style={{ ...typeScale.body, color: palette.enrichDark }}>{DRAFT_BANNER_BODY}</Text>
        </View>
      ) : null}

      <Card>
        <Text
          accessibilityRole="header"
          style={{ ...typeScale.sectionHeading, color: textColors.heading }}
        >
          {text.title}
        </Text>
        {text.sections.map((section) => (
          <ConsentParagraph key={section.id} heading={section.heading} body={section.body} />
        ))}
        {!on ? (
          <View style={{ gap: space[3], paddingTop: space[2] }}>
            <Checkbox
              checked={state.agreed}
              onToggle={() => dispatch({ type: 'toggleAgree' })}
              label={text.agreement}
              disabled={state.saving !== null}
            />
            <Button
              label="Turn on the AI tutor"
              onPress={() => save('grant')}
              disabled={!canTurnOn(state)}
              busy={state.saving === 'grant'}
            />
            {!state.agreed ? (
              <Body muted>Tick the box to say you agree. The tutor stays off until you do.</Body>
            ) : null}
          </View>
        ) : null}
      </Card>
    </View>
  );
}
