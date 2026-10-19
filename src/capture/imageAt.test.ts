import { describe, expect, it } from 'vitest';
import { imageAt, SEQ_STRIDE } from './adapter';

const line = (blocks: unknown[]) => JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } });

describe('imageAt', () => {
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };

  it('recovers the image for the block index the seq encodes', () => {
    const raw = line([{ type: 'text', text: 'look' }, png]);
    expect(imageAt(raw, 12 * SEQ_STRIDE + 1)).toEqual({ src: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png' });
    expect(imageAt(raw, 12 * SEQ_STRIDE + 0)).toBeNull(); // the text block
  });

  it('refuses URL sources, unknown types and junk', () => {
    expect(imageAt(line([{ type: 'image', source: { type: 'url', url: 'https://x' } }]), 0)).toBeNull();
    expect(imageAt(line([{ type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' } }]), 0)).toBeNull();
    expect(imageAt('not json', 0)).toBeNull();
  });
});
