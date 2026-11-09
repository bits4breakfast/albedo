/**
 * @vitest-environment jsdom
 *
 * Mermaid itself (#289), not a stand-in: a directive in the diagram's text
 * cannot change what Albedo set. Parsing needs no layout, so jsdom will do.
 */
import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { mermaidConfig } from './mermaid';

const tokens: Record<string, string> = { '--font-ui': 'system-ui' };
const token = (name: string) => tokens[name] ?? '#808080';
type Config = Record<string, unknown>;

function start(): Config {
  mermaid.initialize(mermaidConfig('light', token) as Parameters<typeof mermaid.initialize>[0]);
  return mermaid.mermaidAPI.getConfig() as Config;
}
async function withDirective(directive: object): Promise<Config> {
  await mermaid.parse(`%%{init: ${JSON.stringify(directive)}}%%\nflowchart LR\n  A --> B`);
  return mermaid.mermaidAPI.getConfig() as Config;
}

describe('a directive in the diagram (#289)', () => {
  it('cannot change what Albedo keeps for itself', async () => {
    const before = start();
    const after = await withDirective({
      securityLevel: 'loose',
      layout: before.layout === 'dagre' ? 'elk' : 'dagre',
      arrowMarkerAbsolute: !before.arrowMarkerAbsolute,
      look: 'neo',
      htmlLabels: true,
      themeCSS: '.node rect { fill: red; }',
      themeVariables: { primaryColor: '#ff0000', dropShadow: 'drop-shadow(1px 2px 2px gray)' },
      fontSize: 30,
      deterministicIds: true,
      sequence: { messageFontSize: 30 },
    });
    for (const key of ['securityLevel', 'layout', 'arrowMarkerAbsolute', 'look', 'htmlLabels', 'themeCSS', 'fontSize', 'deterministicIds']) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(after.themeVariables).toEqual(before.themeVariables);
    expect((after.sequence as Config).messageFontSize).toBe(14);
    // A diagram's own section (mermaid 12 defaults `state` to the neo look)
    // loses to the root look Albedo sets: checked drawn, in a real engine,
    // with a directive and with front matter asking for neo (PR #294).
  });

  it('does apply what is not on the list, so the test above is not passing by accident', async () => {
    start();
    expect((await withDirective({ wrap: true })).wrap).toBe(true);
  });

  it('starts from the classic look with no drop shadow, 14px everywhere', () => {
    const c = start();
    expect(c.look).toBe('classic');
    expect((c.themeVariables as Config).dropShadow).toBe('none');
    expect(c.fontSize).toBe(14);
    expect(c.sequence).toMatchObject({ actorFontSize: 14, messageFontSize: 14, noteFontSize: 14 });
  });
});
