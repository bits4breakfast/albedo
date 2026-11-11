/**
 * The preview's document (#348): the CSP and Albedo's scripts go first, a
 * leading doctype stays first, and the only message taken back is numbers.
 */
import { describe, expect, it } from 'vitest';
import { GEOMETRY_TAG, PREVIEW_CSP, PREVIEW_SANDBOX, parseGeometry, previewSrcdoc } from './frameDoc';

describe('previewSrcdoc', () => {
  it('puts the no-network policy before the page', () => {
    const doc = previewSrcdoc('<p>hi</p>', 'light');
    expect(doc.startsWith(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`)).toBe(true);
    expect(doc.endsWith('<p>hi</p>')).toBe(true);
  });

  it('allows no network of any kind', () => {
    const directives = new Map(
      PREVIEW_CSP.split(';').map((d) => {
        const [name, ...v] = d.trim().split(/\s+/);
        return [name, v.join(' ')] as const;
      }),
    );
    expect(directives.get('default-src')).toBe("'none'");
    // Inline only: no host, no scheme that reaches out, nothing for fetch or connect.
    for (const [name, value] of directives) {
      expect(value, name).not.toMatch(/https?:|\*|'self'|ipc:|tauri:|asset:/);
    }
    expect(directives.has('connect-src')).toBe(false); // falls back to default-src 'none'
    expect(directives.get('img-src')).toBe('data:');
    expect(directives.get('form-action')).toBe("'none'");
  });

  it('keeps a leading doctype first, so the page stays in standards mode', () => {
    const html = '<!DOCTYPE html>\n<html><head><title>x</title></head><body>y</body></html>';
    const doc = previewSrcdoc(html, 'dark');
    expect(doc.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(doc.endsWith('\n<html><head><title>x</title></head><body>y</body></html>')).toBe(true);
    const commented = previewSrcdoc('<!-- made by a session -->\n<!doctype html><p>z</p>', 'light');
    expect(commented.startsWith('<!-- made by a session -->\n<!doctype html><meta')).toBe(true);
  });

  it('answers prefers-color-scheme with the scheme picked', () => {
    expect(previewSrcdoc('<p>', 'dark')).toContain('var dark=true;');
    expect(previewSrcdoc('<p>', 'light')).toContain('var dark=false;');
    expect(previewSrcdoc('<p>', 'dark')).toContain('<meta name="color-scheme" content="dark">');
  });
});

describe('parseGeometry', () => {
  it('takes only the tagged message, and only finite numbers in range', () => {
    const ok = { tag: GEOMETRY_TAG, x: 0, y: 120, w: 800, h: 2400, vw: 800, vh: 320 };
    expect(parseGeometry(ok)).toEqual({ x: 0, y: 120, w: 800, h: 2400, vw: 800, vh: 320 });
    expect(parseGeometry({ ...ok, tag: 'other' })).toBeNull();
    expect(parseGeometry({ ...ok, y: '120' })).toBeNull();
    expect(parseGeometry({ ...ok, h: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseGeometry({ ...ok, x: -5 })).toBeNull();
    expect(parseGeometry('albedo-preview-geometry')).toBeNull();
    expect(parseGeometry(null)).toBeNull();
  });
});

describe('the sandbox', () => {
  it('lets scripts run and grants nothing else', () => {
    expect(PREVIEW_SANDBOX).toBe('allow-scripts');
    expect(PREVIEW_SANDBOX).not.toContain('allow-same-origin');
  });
});
