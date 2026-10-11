/**
 * Design tokens for CUSTAR Tutor. Pure data: no React or React Native imports, so it can be used by
 * the learner app, the admin app, the lesson renderer and print/PDF generation alike.
 *
 * The palette was sampled from the golden unit template
 * (docs/reference/P1_BasicScience_T1_Unit2_Template.pdf, rendered at 100 dpi and read pixel by pixel):
 *   #0f6e63  CORE section bars, kicker text, bullets, callout accent stripe
 *   #c6791e  ENRICH section bars and the rule under the unit title
 *   #0a4a43  unit title and workbook tier headings (dark teal)
 *   #1f2a2a  body text
 *   #8a9794  muted grey text (subtitle line, illustration captions)
 *   #e7f1ef  light teal callout background ("Not yet?" / "Take It Home" boxes)
 *   #f4f8f7  illustration placeholder fill and table stripes
 *   #c9d6d3  dashed illustration border and table rules
 * Values marked "derived" below are NOT in the template; they were computed from the sampled colours
 * to meet accessibility needs (small text contrast) and should be reviewed by a designer.
 */

export const palette = {
  /** CORE section bar, kicker text, bullets. Sampled. */
  core: '#0f6e63',
  /** Unit title and tier headings. Sampled. */
  coreDark: '#0a4a43',
  /** ENRICH section bar and title rule. Sampled. */
  enrich: '#c6791e',
  /** Darker amber for small ENRICH text on white (6:1 contrast). Derived, not in the template. */
  enrichDark: '#8f5412',
  /** Very light amber background for ENRICH callouts. Derived, not in the template. */
  enrichTint: '#fbf1e4',
  /** Body text. Sampled. */
  ink: '#1f2a2a',
  /** Secondary body text (objective box). Sampled. */
  inkSoft: '#303a3a',
  /** Muted grey: subtitle line, illustration captions. Sampled. */
  muted: '#8a9794',
  /** Footer text and very quiet labels. Sampled. */
  mutedSoft: '#abb4b2',
  /** Light teal callout background. Sampled. */
  calloutBg: '#e7f1ef',
  /** Illustration placeholder fill and table stripes. Sampled. */
  placeholderBg: '#f4f8f7',
  /** Dashed illustration placeholder border and table rules. Sampled. */
  placeholderBorder: '#c9d6d3',
  white: '#ffffff',
  /** Feedback colours for graded exercises. Derived, not in the template. */
  success: '#1b7f4b',
  warning: '#b45309',
  danger: '#b3261e',
} as const;

export type PaletteKey = keyof typeof palette;

export type LayerKey = 'CORE' | 'ENRICH' | 'CORE+';

export interface LayerColor {
  /** Section bar background. */
  bar: string;
  /** Text on the section bar. */
  onBar: string;
  /** Accent for stripes and bullets. */
  accent: string;
  /** Light background for callouts in this layer. */
  tint: string;
  /** Text colour for small headings in this layer on a white background. */
  text: string;
  /** Badge text shown next to the heading in the grown-ups view. */
  badge: string;
}

/** Semantic mapping from a section layer to its colours. Think Deeper (CORE+) shares the CORE bar. */
export const layerColors: Record<LayerKey, LayerColor> = {
  CORE: {
    bar: palette.core,
    onBar: palette.white,
    accent: palette.core,
    tint: palette.calloutBg,
    text: palette.coreDark,
    badge: 'CORE',
  },
  ENRICH: {
    bar: palette.enrich,
    onBar: palette.white,
    accent: palette.enrich,
    tint: palette.enrichTint,
    text: palette.enrichDark,
    badge: 'ENRICH',
  },
  'CORE+': {
    bar: palette.core,
    onBar: palette.white,
    accent: palette.coreDark,
    tint: palette.calloutBg,
    text: palette.coreDark,
    badge: 'CORE+',
  },
};

export type CalloutTone = 'info' | 'tip' | 'not_yet';

/** Callout colours by tone (left stripe plus background). */
export const calloutColors: Record<CalloutTone, { stripe: string; background: string }> = {
  info: { stripe: palette.core, background: palette.calloutBg },
  tip: { stripe: palette.enrich, background: palette.enrichTint },
  not_yet: { stripe: palette.core, background: palette.calloutBg },
};

/** Colours for the dashed illustration placeholder. */
export const illustrationPlaceholder = {
  background: palette.placeholderBg,
  border: palette.placeholderBorder,
  caption: palette.muted,
} as const;

/** Colours for text roles. */
export const textColors = {
  body: palette.ink,
  secondary: palette.inkSoft,
  muted: palette.muted,
  heading: palette.coreDark,
  onCore: palette.white,
  onEnrich: palette.white,
} as const;

/** Font sizes in logical pixels. Child-friendly: body text is never smaller than 18. */
export const fontSize = {
  caption: 14,
  label: 16,
  body: 18,
  bodyLarge: 20,
  lead: 22,
  h3: 24,
  h2: 28,
  h1: 34,
  display: 44,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export interface TextStyleToken {
  fontSize: number;
  lineHeight: number;
  fontWeight: (typeof fontWeight)[keyof typeof fontWeight];
}

/** Line heights are absolute pixels (React Native has no unitless line-height). */
export const typeScale = {
  caption: { fontSize: fontSize.caption, lineHeight: 20, fontWeight: fontWeight.regular },
  label: { fontSize: fontSize.label, lineHeight: 22, fontWeight: fontWeight.semibold },
  body: { fontSize: fontSize.body, lineHeight: 28, fontWeight: fontWeight.regular },
  bodyLarge: { fontSize: fontSize.bodyLarge, lineHeight: 30, fontWeight: fontWeight.regular },
  lead: { fontSize: fontSize.lead, lineHeight: 32, fontWeight: fontWeight.medium },
  sectionHeading: { fontSize: fontSize.h3, lineHeight: 32, fontWeight: fontWeight.bold },
  title: { fontSize: fontSize.h2, lineHeight: 36, fontWeight: fontWeight.bold },
  unitTitle: { fontSize: fontSize.h1, lineHeight: 42, fontWeight: fontWeight.bold },
  display: { fontSize: fontSize.display, lineHeight: 52, fontWeight: fontWeight.bold },
} as const satisfies Record<string, TextStyleToken>;

export type TextRole = keyof typeof typeScale;

/**
 * Font family names. The app must bundle a font that renders Yoruba, Igbo and Hausa tone marks and
 * under-dots (for example Noto Sans); `fallback` is only a safety net.
 */
export const fontFamily = {
  body: 'Noto Sans',
  heading: 'Noto Sans',
  fallback: 'sans-serif',
} as const;

/** Spacing on a 4pt grid. Keys are grid multiples, values are logical pixels. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export type SpaceKey = keyof typeof space;

export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 20,
  pill: 999,
} as const;

/** Smallest interactive target, in logical pixels (children's fingers; WCAG recommends 44, we use 48). */
export const minTouchTarget = 48;

export type StageKey = 'absorb' | 'connect' | 'express';

export interface StageLabel {
  /** Short name shown in the stage line, for example "Absorb". */
  label: string;
  /** Light-weight description of what the child does at this stage. */
  mode: string;
}

/** Light-weight stage labels (brief section 9). The template prints "Stage: Absorb -> Connect (name, notice, recall; light compare)". */
export const stageLabels: Record<StageKey, StageLabel> = {
  absorb: { label: 'Absorb', mode: 'name, notice, recall' },
  connect: { label: 'Connect', mode: 'compare, sort, reason' },
  express: { label: 'Express', mode: 'explain, apply, argue' },
};

export const tokens = {
  palette,
  layerColors,
  calloutColors,
  illustrationPlaceholder,
  textColors,
  fontSize,
  fontWeight,
  typeScale,
  fontFamily,
  space,
  radii,
  minTouchTarget,
  stageLabels,
} as const;
