import { describe, expect, it } from 'vitest';
import { imagesIn } from './adapter';
import { withoutImageMarkers } from '../ui/transcript/envelopes';

const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };

describe('imagesIn', () => {
  it('finds the pictures of a message sent while a turn ran (a queued_command attachment)', () => {
    const line = JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        origin: { kind: 'human' },
        prompt: [{ type: 'text', text: '[Image #3] an example' }, png],
      },
    });
    expect(imagesIn(line).map((i) => i.src)).toEqual(['data:image/png;base64,iVBORw0KGgo=']);
  });

  it('finds them in an ordinary user line, in order, and nothing else', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x' }, png, png] } });
    expect(imagesIn(line)).toHaveLength(2);
    expect(imagesIn('{"type":"user","message":{"content":"plain"}}')).toEqual([]);
    expect(imagesIn('not json')).toEqual([]);
  });
});

describe('withoutImageMarkers', () => {
  it('drops Claude Code\'s [Image #N] markers and the space after them', () => {
    expect(withoutImageMarkers('[Image #4] [Image #5] also why')).toBe('also why');
    expect(withoutImageMarkers('see [Image #2]  this menu')).toBe('see this menu');
    expect(withoutImageMarkers('no markers [Image] here')).toBe('no markers [Image] here');
  });
});
