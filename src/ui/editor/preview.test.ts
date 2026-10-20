import { describe, expect, it } from 'vitest';
import { formatBytes, imageTypeForPath } from './preview';

describe('imageTypeForPath', () => {
  it('knows the raster formats, in any case', () => {
    expect(imageTypeForPath('docs/screenshots/waiting-on-you.png')).toBe('image/png');
    expect(imageTypeForPath('a/PHOTO.JPG')).toBe('image/jpeg');
    expect(imageTypeForPath('icon.ico')).toBe('image/x-icon');
  });

  it('leaves SVG and everything else as text', () => {
    expect(imageTypeForPath('logo.svg')).toBeNull();
    expect(imageTypeForPath('README.md')).toBeNull();
    expect(imageTypeForPath('Makefile')).toBeNull();
    expect(imageTypeForPath('dir.png/file')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('reads at every scale', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
  });
});
