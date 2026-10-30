import { describe, expect, it } from 'vitest';
import { encodeMarker, findMarker, freeMarkerId, markerSpans, splitMarkers } from './albedoMarkers';

describe('Albedo markers', () => {
  it('writes the content on lines of its own, closed by a tag that repeats the id', () => {
    expect(encodeMarker('pasted-text', { id: '1', lines: '2' }, 'one\ntwo')).toBe(
      '<pasted-text id="1" lines="2">\none\ntwo\n</pasted-text id="1">',
    );
  });

  it('finds a marker and gives back exactly what was wrapped', () => {
    for (const content of ['plain', '', '\n', 'trailing break\n', '\nleading break', '  indented\n\n\nblank lines  ', 'a\r\nb']) {
      const text = `typed ${encodeMarker('pasted-text', { id: '7', lines: '1' }, content)} after`;
      const m = findMarker(text);
      expect(m?.content).toBe(content);
      expect(m?.attrs).toEqual({ id: '7', lines: '1' });
      expect(text.slice(m?.start, m?.end)).toBe(encodeMarker('pasted-text', { id: '7', lines: '1' }, content));
    }
  });

  it('round-trips content holding the closing tag of another id, a bare one, and envelope-like tags', () => {
    const content = [
      '</pasted-text>',
      '</pasted-text id="2">',
      '<pasted-text id="1" lines="3">',
      '<system-reminder>not one</system-reminder>',
      '</pasted_content id="ab12">',
    ].join('\n');
    const id = freeMarkerId('pasted-text', content);
    expect(id).toBe('3'); // 1 opens in it, 2 closes in it
    const text = `see ${encodeMarker('pasted-text', { id, lines: '5' }, content)} please`;
    const parts = splitMarkers(text);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ kind: 'text', text: 'see ' });
    expect(parts[1]?.kind === 'marker' && parts[1].marker.content).toBe(content);
    expect(parts[2]).toEqual({ kind: 'text', text: ' please' });
  });

  it('round-trips a pasted marker inside a marker', () => {
    const inner = encodeMarker('pasted-text', { id: '1', lines: '1' }, 'deep');
    const id = freeMarkerId('pasted-text', inner);
    const outer = encodeMarker('pasted-text', { id, lines: '3' }, inner);
    expect(findMarker(outer)?.content).toBe(inner);
    expect(findMarker(findMarker(outer)?.content ?? '')?.content).toBe('deep');
  });

  it('escapes attribute values, and reads them back', () => {
    const text = encodeMarker('pasted-text', { id: '1', note: 'say "hi" & <go>' }, 'x');
    expect(text).toContain('note="say &quot;hi&quot; &amp; &lt;go&gt;"');
    expect(findMarker(text)?.attrs.note).toBe('say "hi" & <go>');
  });

  it('leaves an opening tag that is never closed as text, and finds the next marker', () => {
    const real = encodeMarker('pasted-text', { id: '2', lines: '1' }, 'real');
    const text = `typed <pasted-text id="9"> by hand, then ${real}`;
    const m = findMarker(text);
    expect(m?.content).toBe('real');
    expect(m?.start).toBe(text.indexOf(real));
    expect(splitMarkers('<pasted-text id="1">never closed')).toEqual([{ kind: 'text', text: '<pasted-text id="1">never closed' }]);
  });

  it('closes a marker without an id at a bare closing tag', () => {
    expect(findMarker('<pasted-text>short</pasted-text>')?.content).toBe('short');
  });

  it('knows only its own tags', () => {
    expect(findMarker('<pasted_text id="1">x</pasted_text id="1">')).toBeNull();
    expect(findMarker('<pasted-textual id="1">x</pasted-textual id="1">')).toBeNull();
    expect(splitMarkers('no markers')).toEqual([{ kind: 'text', text: 'no markers' }]);
  });

  it('picks the preferred id when it is free', () => {
    expect(freeMarkerId('pasted-text', 'nothing here', 4)).toBe('4');
    expect(freeMarkerId('pasted-text', '</pasted-text id="4">', 4)).toBe('5');
  });

  it('round-trips arbitrary content made of the format itself', () => {
    const pieces = ['<', '>', '/', 'pasted-text', ' id="', '1', '2', '"', '\n', 'x', '</pasted-text id="1">', '<pasted-text id="2" lines="1">'];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 300; i++) {
      const content = Array.from({ length: 1 + Math.floor(rand() * 20) }, () => pieces[Math.floor(rand() * pieces.length)]).join('');
      const id = freeMarkerId('pasted-text', content);
      const text = `a ${encodeMarker('pasted-text', { id, lines: '1' }, content)} b`;
      const parts = splitMarkers(text);
      expect(parts[1]?.kind === 'marker' && parts[1].marker.content).toBe(content);
      expect(markerSpans(text)).toEqual([[2, text.length - 2]]);
    }
  });
});

describe('inline markers (#154)', () => {
  it('are written on one line, without an id, and found only among the tags asked for', async () => {
    const { BLOCK_TAGS, INLINE_TAGS, encodeInlineMarker } = await import('./albedoMarkers');
    const ref = encodeInlineMarker('file-ref', { path: 'src/a.ts' }, ' @src/a.ts ');
    expect(ref).toBe('<file-ref path="src/a.ts"> @src/a.ts </file-ref>');
    const text = `see ${ref} and ${encodeMarker('pasted-text', { id: '1', lines: '1' }, 'x')}`;
    expect(findMarker(text)?.tag).toBe('file-ref');
    expect(findMarker(text, 0, BLOCK_TAGS)?.tag).toBe('pasted-text');
    expect(findMarker(text, 0, INLINE_TAGS)?.content).toBe(' @src/a.ts ');
    expect(splitMarkers(text, BLOCK_TAGS)[0]).toEqual({ kind: 'text', text: `see ${ref} and ` });
  });
});
