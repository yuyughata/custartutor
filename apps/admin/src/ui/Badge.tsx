import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { jobStatusStyle } from '../lib/jobText';
import { versionStatusStyle, type StatusTone } from '../lib/workflow';
import { space, tones } from './theme';

/** A pill with a glyph and a word: status is never carried by colour alone. */
export function Badge({
  label,
  glyph,
  tone = 'neutral',
  testID,
}: {
  label: string;
  glyph?: string;
  tone?: StatusTone;
  testID?: string;
}): ReactNode {
  const palette = tones[tone];
  return (
    <View
      {...(testID ? { testID } : {})}
      accessible
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[1],
        alignSelf: 'flex-start',
        paddingHorizontal: space[2],
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
      }}
    >
      {glyph ? (
        <Text aria-hidden style={{ color: palette.text, fontSize: 12, fontWeight: '700' }}>
          {glyph}
        </Text>
      ) : null}
      <Text style={{ color: palette.text, fontSize: 12, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

export function VersionStatusBadge({ status }: { status: string }): ReactNode {
  const style = versionStatusStyle(status);
  return <Badge label={style.label} glyph={style.glyph} tone={style.tone} />;
}

export function JobStatusBadge({ status }: { status: string }): ReactNode {
  const style = jobStatusStyle(status);
  return <Badge label={style.label} glyph={style.glyph} tone={style.tone} />;
}

const SCHEME_STYLE: Record<string, { label: string; glyph: string; tone: StatusTone }> = {
  draft: { label: 'Draft', glyph: '✎', tone: 'warning' },
  approved: { label: 'Approved', glyph: '✓', tone: 'success' },
  archived: { label: 'Archived', glyph: '■', tone: 'neutral' },
};

export function SchemeStatusBadge({ status }: { status: string }): ReactNode {
  const style = SCHEME_STYLE[status] ?? { label: status, glyph: '?', tone: 'neutral' as const };
  return <Badge label={style.label} glyph={style.glyph} tone={style.tone} />;
}

const CONTENT_STYLE: Record<string, { label: string; glyph: string; tone: StatusTone }> = {
  draft: { label: 'Draft', glyph: '✎', tone: 'neutral' },
  published: { label: 'Published', glyph: '●', tone: 'success' },
  archived: { label: 'Archived', glyph: '■', tone: 'neutral' },
};

export function ContentStatusBadge({ status }: { status: string }): ReactNode {
  const style = CONTENT_STYLE[status] ?? { label: status, glyph: '?', tone: 'neutral' as const };
  return <Badge label={style.label} glyph={style.glyph} tone={style.tone} />;
}
