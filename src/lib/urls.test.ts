import { describe, expect, it } from 'vitest';
import { hostOf, safeHttpUrl, splitUrls } from './urls';

describe('safeHttpUrl', () => {
  it('accepts http and https only', () => {
    expect(safeHttpUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHttpUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ssh://x', 'tauri://localhost', 'example.com', '']) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
  it('names the host', () => {
    expect(hostOf('https://linear.app/x/issue/ACME-1')).toBe('linear.app');
    expect(hostOf('javascript:x')).toBeNull();
  });
});

describe('splitUrls', () => {
  const urls = (t: string) => splitUrls(t).flatMap((p) => (typeof p === 'string' ? [] : [p.url]));

  it('returns plain text untouched', () => {
    expect(splitUrls('no links here')).toEqual(['no links here']);
  });
  it('finds a URL and keeps the text around it', () => {
    expect(splitUrls('see https://a.dev/x now')).toEqual(['see ', { url: 'https://a.dev/x' }, ' now']);
  });
  it('drops sentence punctuation from the end', () => {
    expect(urls('Open https://a.dev/x.')).toEqual(['https://a.dev/x']);
    expect(urls('(https://a.dev/x), then https://b.dev?q=1!')).toEqual(['https://a.dev/x', 'https://b.dev?q=1']);
  });
  it('keeps a balanced closing paren, drops an unbalanced one', () => {
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(urls('(see https://a.dev/x)')).toEqual(['https://a.dev/x']);
  });
  it('finds several, and never links other schemes', () => {
    expect(urls('https://a.dev and http://b.dev/y')).toEqual(['https://a.dev', 'http://b.dev/y']);
    expect(urls('javascript:alert(1) file:///etc/passwd')).toEqual([]);
  });
});
