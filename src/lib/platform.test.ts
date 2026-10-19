import { describe, expect, it } from 'vitest';
import { detectPlatform, urlOpener } from './platform';

describe('detectPlatform', () => {
  it('reads WKWebView as macOS', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(detectPlatform(ua)).toBe('macos');
  });

  it('reads WebKitGTK as Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15';
    expect(detectPlatform(ua)).toBe('linux');
  });

  it('falls back to other, which opens URLs the portable way', () => {
    expect(detectPlatform('')).toBe('other');
    expect(urlOpener('other')).toBe('xdg-open');
  });
});

describe('urlOpener', () => {
  it('uses open on macOS and xdg-open on Linux', () => {
    expect(urlOpener('macos')).toBe('open');
    expect(urlOpener('linux')).toBe('xdg-open');
  });
});
