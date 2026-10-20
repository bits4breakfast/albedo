import { describe, expect, it } from 'vitest';
import { imageFromClipboard, pastedImageName, pastedImagePath, withInsertedPath, isEphemeralPath } from './pasteImage';

const item = (kind: string, type: string, file: File | null = null) => ({ kind, type, getAsFile: () => file });

describe('imageFromClipboard', () => {
  const png = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });

  it('finds an image file among the items', () => {
    expect(imageFromClipboard([item('string', 'text/plain'), item('file', 'image/png', png)])).toBe(png);
  });

  it('is null for a text paste, so it behaves as before', () => {
    expect(imageFromClipboard([item('string', 'text/plain'), item('string', 'text/html')])).toBeNull();
    expect(imageFromClipboard([])).toBeNull();
    expect(imageFromClipboard(null)).toBeNull();
  });

  it('ignores image string flavours and non-image files', () => {
    expect(imageFromClipboard([item('string', 'image/png'), item('file', 'application/pdf', png)])).toBeNull();
  });

  it('skips an item whose file is unavailable', () => {
    expect(imageFromClipboard([item('file', 'image/png', null), item('file', 'image/jpeg', png)])).toBe(png);
  });
});

describe('pastedImageName', () => {
  const at = new Date(2026, 9, 7, 3, 4, 5, 42);

  it('is a sortable local timestamp with the right extension', () => {
    expect(pastedImageName('image/png', at)).toBe('20261007-030405-042.png');
    expect(pastedImageName('image/jpeg', at)).toBe('20261007-030405-042.jpg');
    expect(pastedImageName('image/tiff', at)).toBe('20261007-030405-042.tiff');
  });

  it('falls back to png for an odd type, and needs no shell escaping', () => {
    const name = pastedImageName('image/', at);
    expect(name).toBe('20261007-030405-042.png');
    expect(name).toMatch(/^[\w.-]+$/);
  });
});

describe('pastedImagePath', () => {
  it('lands under ~/.albedo/paste', () => {
    expect(pastedImagePath('/Users/m/', 'x.png')).toEqual({
      dir: '/Users/m/.albedo/paste',
      path: '/Users/m/.albedo/paste/x.png',
    });
  });
});

describe('withInsertedPath', () => {
  it('spaces the path like a drop does', () => {
    expect(withInsertedPath('', '/a.png')).toBe('/a.png ');
    expect(withInsertedPath('look at', '/a.png')).toBe('look at /a.png ');
    expect(withInsertedPath('look at ', '/a.png')).toBe('look at /a.png ');
  });
});

describe('isEphemeralPath', () => {
  it('knows the screenshot thumbnail\'s drag source is about to vanish', () => {
    expect(isEphemeralPath('/var/folders/ld/982h/T/TemporaryItems/NSIRD_screencaptureui_x/Screenshot 1.png')).toBe(true);
    expect(isEphemeralPath('/private/var/folders/ld/T/a.png')).toBe(true);
    expect(isEphemeralPath('/Users/m/Desktop/Screenshot 1.png')).toBe(false);
  });
});
