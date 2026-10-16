import { describe, expect, it } from 'vitest';
import { parseModelCatalog, windowFor } from './modelCatalog';

const text = JSON.stringify({
  catalog: {
    config: {
      models: [
        { id: 'claude-opus-5-5', runtime: { max_input_tokens: 1_000_000 } },
        { id: 'claude-haiku-4-5-20251001', runtime: { max_input_tokens: 200_000 } },
        { id: 'no-runtime' },
      ],
    },
  },
});

describe('model catalog', () => {
  it('reads max_input_tokens per model and skips entries without one', () => {
    const m = parseModelCatalog(text);
    expect(m.get('claude-opus-5-5')).toBe(1_000_000);
    expect(m.get('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(m.has('no-runtime')).toBe(false);
  });

  it('returns an empty map for junk rather than throwing', () => {
    expect(parseModelCatalog('not json').size).toBe(0);
    expect(parseModelCatalog('{}').size).toBe(0);
  });

  it('looks up through a [1m] suffix and returns null when unknown', () => {
    const m = parseModelCatalog(text);
    expect(windowFor('claude-opus-5-5[1m]', m)).toBe(1_000_000);
    expect(windowFor('claude-unknown', m)).toBeNull();
    expect(windowFor(null, m)).toBeNull();
  });
});
