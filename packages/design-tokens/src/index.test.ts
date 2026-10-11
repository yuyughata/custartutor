import { describe, expect, it } from 'vitest';
import {
  fontSize,
  layerColors,
  minTouchTarget,
  palette,
  radii,
  space,
  stageLabels,
  typeScale,
} from './index';

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('design tokens', () => {
  it('uses valid 6-digit hex colours throughout the palette', () => {
    for (const value of Object.values(palette)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps the sampled template colours', () => {
    expect(palette.core).toBe('#0f6e63');
    expect(palette.enrich).toBe('#c6791e');
    expect(palette.coreDark).toBe('#0a4a43');
  });

  it('maps every layer to a bar colour, with Think Deeper (CORE+) on the CORE teal', () => {
    expect(Object.keys(layerColors).sort()).toEqual(['CORE', 'CORE+', 'ENRICH']);
    expect(layerColors.CORE.bar).toBe(palette.core);
    expect(layerColors.ENRICH.bar).toBe(palette.enrich);
    expect(layerColors['CORE+'].bar).toBe(palette.core);
    expect(layerColors['CORE+'].badge).toBe('CORE+');
  });

  it('is child friendly: body text is at least 18 and touch targets at least 48', () => {
    expect(fontSize.body).toBeGreaterThanOrEqual(18);
    expect(typeScale.body.fontSize).toBeGreaterThanOrEqual(18);
    expect(minTouchTarget).toBeGreaterThanOrEqual(48);
    for (const style of Object.values(typeScale)) {
      expect(style.lineHeight).toBeGreaterThan(style.fontSize);
    }
  });

  it('keeps spacing on a 4pt grid and radii non-negative', () => {
    for (const value of Object.values(space)) {
      expect(value % 4).toBe(0);
    }
    for (const value of Object.values(radii)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps text readable on the section bars (large bold text needs 3:1, body text 4.5:1)', () => {
    expect(contrast(palette.white, layerColors.CORE.bar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.white, layerColors.ENRICH.bar)).toBeGreaterThanOrEqual(3);
    expect(contrast(layerColors.ENRICH.text, palette.white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.ink, palette.white)).toBeGreaterThanOrEqual(7);
    expect(contrast(palette.ink, palette.calloutBg)).toBeGreaterThanOrEqual(7);
  });

  it('labels all three stages', () => {
    expect(Object.keys(stageLabels)).toEqual(['absorb', 'connect', 'express']);
    expect(stageLabels.absorb.label).toBe('Absorb');
  });
});
