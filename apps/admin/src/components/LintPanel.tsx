// Lint (deterministic rules) and the AI review (advisory) for one version. Errors are red and block submitting
// and publishing; warnings are amber and advisory. Every item with a path can jump to its place in the preview.
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { Flag } from '@custar/authoring-core';
import type { LintIssue, LintView } from '../lib/lint';
import { jumpTarget, type JumpTarget } from '../lib/lintPaths';
import { flagCodeLabel } from '../lib/flags';
import { Badge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Section } from '../ui/Card';
import { P, Small } from '../ui/Text';
import { colors, radii, space, tones } from '../ui/theme';
import { FlagList } from './FlagList';

function IssueRow({
  issue,
  tone,
  unit,
  onJump,
}: {
  issue: LintIssue;
  tone: 'danger' | 'warning';
  unit: unknown;
  onJump: (target: JumpTarget) => void;
}): ReactNode {
  const palette = tones[tone];
  const target = jumpTarget(issue.path, unit);
  return (
    <View
      style={{
        gap: space[1],
        padding: space[3],
        borderRadius: radii.md,
        borderWidth: 1,
        borderLeftWidth: 5,
        borderColor: palette.border,
        backgroundColor: palette.background,
      }}
    >
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge
          label={tone === 'danger' ? 'Error' : 'Warning'}
          glyph={tone === 'danger' ? '✕' : '⚠'}
          tone={tone}
        />
        <Text style={{ fontWeight: '700', fontSize: 13, color: palette.text }}>
          {flagCodeLabel(issue.code)}
        </Text>
      </View>
      <P style={{ color: colors.text }}>{issue.message}</P>
      {issue.path ? (
        <View
          style={{ flexDirection: 'row', gap: space[3], alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Small>{issue.path}</Small>
          {target ? (
            <Text
              accessibilityRole="button"
              accessibilityLabel={`Jump to ${target.label}`}
              onPress={() => onJump(target)}
              style={{
                color: colors.primary,
                fontWeight: '700',
                fontSize: 13,
                textDecorationLine: 'underline',
              }}
            >
              Jump to {target.label}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function LintPanel({
  lint,
  unit,
  onJump,
}: {
  lint: LintView;
  unit: unknown;
  onJump: (target: JumpTarget) => void;
}): ReactNode {
  const asFlag = (note: LintView['review'][number]): Flag => ({
    code: note.code,
    severity: note.severity,
    message: note.message,
    ...(note.path ? { path: note.path } : {}),
  });
  return (
    <View style={{ gap: space[4] }}>
      <Section
        title="Lint"
        testID="lint-panel"
        action={
          <Badge
            label={
              lint.blocking
                ? `${lint.errors.length} error${lint.errors.length === 1 ? '' : 's'} block publishing`
                : 'No errors'
            }
            glyph={lint.blocking ? '✕' : '✓'}
            tone={lint.blocking ? 'danger' : 'success'}
          />
        }
      >
        <Small>
          Rules the unit must pass before it can be submitted, approved or published.
          {lint.hasStoredReport
            ? ' Combines the report saved with this draft and a fresh check in your browser.'
            : ' Checked in your browser.'}
        </Small>
        {lint.errors.length === 0 && lint.warnings.length === 0 ? (
          <Banner tone="success" title="No errors or warnings" />
        ) : null}
        {lint.errors.map((issue, index) => (
          <IssueRow
            key={`e-${issue.code}-${issue.path ?? index}-${index}`}
            issue={issue}
            tone="danger"
            unit={unit}
            onJump={onJump}
          />
        ))}
        {lint.warnings.length > 0 ? (
          <Small>
            {lint.warnings.length} warning{lint.warnings.length === 1 ? '' : 's'} (advisory, they do
            not block)
          </Small>
        ) : null}
        {lint.warnings.map((issue, index) => (
          <IssueRow
            key={`w-${issue.code}-${issue.path ?? index}-${index}`}
            issue={issue}
            tone="warning"
            unit={unit}
            onJump={onJump}
          />
        ))}
      </Section>

      <Section title="AI review (advisory)" testID="review-panel" tone="muted">
        <Banner tone="info" title="Claude’s review is advice, not approval">
          <P>
            These notes never block anything and never approve anything. A person reads them and
            decides.
          </P>
        </Banner>
        {lint.summary ? (
          <View style={{ gap: space[1] }}>
            <Small>Summary from the drafting job</Small>
            <P>{lint.summary}</P>
          </View>
        ) : null}
        <FlagList
          flags={lint.review.map(asFlag)}
          emptyText="The review left no notes for this version."
          onJump={(flag) => {
            const target = jumpTarget(flag.path, unit);
            if (target) onJump(target);
          }}
        />
      </Section>
    </View>
  );
}
