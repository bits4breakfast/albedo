import { describe, expect, it } from 'vitest';
import { highlightToTokens } from './highlight';

describe('highlightToTokens colours tokens', () => {
  it('gives a PHP keyword a colour in both themes', async () => {
    const lines = await highlightToTokens('<?php\nclass X { public function f(): void {} }\n', 'php');
    const kw = lines[1]?.find((t) => t.content === 'class');
    expect(kw).toBeDefined();
    // Not the empty style every token had while variants were looked up by theme id.
    expect(Object.keys(kw?.style ?? {}).length).toBeGreaterThan(0);
  });
});
