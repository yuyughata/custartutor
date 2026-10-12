// Colours, type and spacing for the admin app, built from @custar/design-tokens. The admin is denser than the
// learner app (15 px body text, tables), but it keeps the same CORE teal and ENRICH amber and the same ink.
import { layerColors, palette, radii, space } from '@custar/design-tokens';
import type { StatusTone } from '../lib/workflow';

export { radii, space };

/** A quiet text colour that still passes 4.5:1 on white and on the light page background (derived, not sampled). */
const subtle = '#4f5c5b';

export const colors = {
  page: palette.placeholderBg,
  surface: palette.white,
  border: palette.placeholderBorder,
  borderStrong: '#9fb1ad',
  text: palette.ink,
  textSoft: palette.inkSoft,
  subtle,
  primary: layerColors.CORE.bar,
  primaryDark: layerColors.CORE.text,
  primaryTint: layerColors.CORE.tint,
  amber: layerColors.ENRICH.bar,
  amberText: layerColors.ENRICH.text,
  amberTint: layerColors.ENRICH.tint,
  danger: palette.danger,
  dangerTint: '#fcecea',
  success: palette.success,
  successTint: '#e5f3ec',
  warning: palette.warning,
  white: palette.white,
  sidebar: palette.coreDark,
  sidebarText: '#e7f1ef',
  sidebarActive: '#0f6e63',
} as const;

export const type = {
  h1: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.primaryDark },
  h2: { fontSize: 20, lineHeight: 28, fontWeight: '700', color: colors.primaryDark },
  h3: { fontSize: 16, lineHeight: 24, fontWeight: '700', color: colors.text },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400', color: colors.text },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400', color: colors.subtle },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: colors.textSoft },
} as const;

export interface ToneColors {
  background: string;
  border: string;
  text: string;
}

/** Status colours. Every use is paired with a glyph and a word, so colour is never the only signal. */
export const tones: Record<StatusTone, ToneColors> = {
  neutral: { background: colors.page, border: colors.borderStrong, text: colors.textSoft },
  info: { background: colors.primaryTint, border: colors.primary, text: colors.primaryDark },
  success: { background: colors.successTint, border: colors.success, text: '#14633a' },
  warning: { background: colors.amberTint, border: colors.amber, text: colors.amberText },
  danger: { background: colors.dangerTint, border: colors.danger, text: '#8f1d17' },
};

/** Narrower than this and the sidebar becomes a top bar. */
export const SIDEBAR_BREAKPOINT = 900;
export const SIDEBAR_WIDTH = 232;
export const CONTENT_MAX_WIDTH = 1120;
export const MIN_TARGET = 40;
