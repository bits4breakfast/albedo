import { afterAll, describe, expect, it } from 'vitest';
import { cacheStats, highlightToTokens, setTokenBudgetForTests } from './highlight';

const file = Array.from({ length: 60 }, (_, i) => `const value${i}: number = compute(${i}, "text ${i}");`).join('\n');

afterAll(() => setTokenBudgetForTests(250_000));

describe('the token cache', () => {
  it('stays inside its token budget however many versions pass through', async () => {
    setTokenBudgetForTests(3_000);
    for (let i = 0; i < 20; i++) await highlightToTokens(`${file}\n// version ${i}`, 'typescript');
    const { entries, tokens } = cacheStats();
    expect(tokens).toBeLessThanOrEqual(3_000);
    expect(entries).toBeGreaterThan(0);
    expect(entries).toBeLessThan(20);
  });

  it('shares one style object between tokens of the same style', async () => {
    const lines = await highlightToTokens('const a = 1;\nconst b = 2;\n', 'typescript');
    const keyword = lines.slice(0, 2).map((l) => l.find((t) => t.content.includes('const'))!.style);
    expect(keyword[0]).toBe(keyword[1]);
    expect(Object.isFrozen(keyword[0])).toBe(true);
  });
});
