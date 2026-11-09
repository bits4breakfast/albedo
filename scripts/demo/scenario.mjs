// The demo profile's one fixed arrangement (#193): seven tasks in two made-up
// projects, spread over the task list's groups (src/ui/taskGroups.ts), for
// the README's hero shot and the launch post. One idea at a glance: several
// pieces of work in parallel, and one of them needs you.
//
//   recipe-app  Add dark mode to settings        Needs You (Allow / Deny)
//               Import recipes from a link       Running
//               Search recipes by ingredient     Running
//               Round amounts to kitchen …       Approved: PR open, approved, checks green
//               Show cooking time on recipe …    Done
//   blog        Add an RSS feed                  Ready to Review: unseen finish, on a question
//               Show tags on each post           In Review: PR open, unresolved threads
//
// Idle, My Review and Archived are left out: Idle is the quiet rest, and the
// other two need a Review Guide or an archive the hero has no room for.
//
// `summary` is the one line a session sets through Albedo's MCP server
// (set_task_summary), shown on hover; demo tasks have it from the start.
//
// Everything here is invented. Never put a real project, company, customer,
// issue key or worktree name in it.

import { BLOG, RECIPE_APP } from './repos.mjs';
import { workspace } from './workspace.mjs';

const MIN = 60_000;

/** Files on main after its last commit. */
export function mainFiles(commits) {
  return Object.assign({}, ...commits.map((c) => c.files));
}

const TASKS = [
  {
    key: 'dark-mode',
    project: 'recipe-app',
    title: 'Add dark mode to settings',
    summary: 'Theme setting on the settings page: follow the system, or pick Light or Dark',
    branch: 'add-dark-mode',
    sessionId: '5d0c6f2e-8b1a-4c57-9e1f-2a7b3c9d4e01',
    ago: 52 * MIN,
    seen: true,
    play: (w) =>
      w
        .prompt('How does the settings page save what people choose?')
        .read('src/settings/useSettings.ts')
        .end(
          'Settings live in `localStorage` under `recipe-app.settings`, as one JSON object. `useSettings()` loads them with defaults filled in and writes the whole object back on every change, so a new setting only needs a field in `Settings` and a default in `DEFAULTS`.',
        )
        .live(9 * MIN)
        .prompt(
          'Add dark mode to the settings page. It should follow the system by default, and let people pick Light or Dark.',
        )
        .read('src/styles/theme.css')
        .say(
          'The colours are written straight into each rule. I will move them into CSS variables first, so a dark theme only has to swap the variables.',
        )
        .edit(
          'src/styles/theme.css',
          `body {
  margin: 0;
  font: 17px/1.5 system-ui, sans-serif;
  background: #fffdf8;
  color: #1f1b16;
}`,
          `:root {
  --bg: #fffdf8;
  --surface: #ffffff;
  --text: #1f1b16;
  --muted: #6b6257;
  --border: #e6dfd3;
  --accent: #b4441c;
}

body {
  margin: 0;
  font: 17px/1.5 system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
}`,
        )
        .edit(
          'src/styles/theme.css',
          `  border: 1px solid #e6dfd3;
  border-radius: 12px;
  padding: 16px;
  background: #ffffff;
}

.recipe-meta {
  color: #6b6257;
}

a {
  color: #b4441c;
}`,
          `  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  background: var(--surface);
}

.recipe-meta {
  color: var(--muted);
}

a {
  color: var(--accent);
}`,
        )
        .commit('Move colours into CSS variables')
        .edit(
          'src/styles/theme.css',
          `  --accent: #b4441c;
}
`,
          `  --accent: #b4441c;
}

:root[data-theme='dark'] {
  --bg: #1c1915;
  --surface: #26221d;
  --text: #f2ece3;
  --muted: #b3a897;
  --border: #3a342c;
  --accent: #f08a5d;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg: #1c1915;
    --surface: #26221d;
    --text: #f2ece3;
    --muted: #b3a897;
    --border: #3a342c;
    --accent: #f08a5d;
  }
}
`,
        )
        .edit(
          'src/settings/useSettings.ts',
          `export interface Settings {
  units: 'metric' | 'us';
}

const KEY = 'recipe-app.settings';
const DEFAULTS: Settings = { units: 'metric' };`,
          `export interface Settings {
  units: 'metric' | 'us';
  theme: 'system' | 'light' | 'dark';
}

const KEY = 'recipe-app.settings';
const DEFAULTS: Settings = { units: 'metric', theme: 'system' };`,
        )
        .edit(
          'src/settings/SettingsPage.tsx',
          `          <option value="us">US (cups, oz)</option>
        </select>
      </label>`,
          `          <option value="us">US (cups, oz)</option>
        </select>
      </label>
      <label>
        Theme
        <select value={settings.theme} onChange={(e) => update({ theme: e.target.value as Settings['theme'] })}>
          <option value="system">Same as the system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>`,
        )
        .edit(
          'src/settings/SettingsPage.tsx',
          `import { useSettings } from './useSettings';`,
          `import { useEffect } from 'react';
import { useSettings, type Settings } from './useSettings';`,
        )
        .edit(
          'src/settings/SettingsPage.tsx',
          `  const [settings, update] = useSettings();
  return (`,
          `  const [settings, update] = useSettings();
  useEffect(() => {
    if (settings.theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  return (`,
        )
        .commit('Add a Theme setting: system, light or dark')
        .edit(
          'src/settings/SettingsPage.test.tsx',
          `    expect(JSON.parse(localStorage.getItem('recipe-app.settings')!)).toEqual({ units: 'us' });
  });`,
          `    expect(JSON.parse(localStorage.getItem('recipe-app.settings')!)).toMatchObject({ units: 'us' });
  });

  it('switches the page to dark', () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'dark' } });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });`,
        )
        .say('The settings tests compare the saved object exactly, so they need the new field. Running them now.')
        .ask('npm test -- src/settings', 'Run the settings tests', 'npm test:*', {
          allow: (w) =>
            w
              .result(
                ` ✓ src/settings/SettingsPage.test.tsx (3 tests) 41ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  612ms`,
              )
              .end(
                'Dark mode is in, in two commits on `add-dark-mode`:\n\n- **Move colours into CSS variables**: no visible change, every colour now comes from `:root`.\n- **Add a Theme setting**: Settings › Theme offers *Same as the system*, *Light* and *Dark*; the system choice follows `prefers-color-scheme`.\n\nThe settings tests pass. The test update is not committed yet: shall I add it to the second commit?',
              ),
          deny: (w) =>
            w.result(
              "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
              { isError: true },
            ),
        }),
  },
  {
    key: 'import-link',
    project: 'recipe-app',
    title: 'Import recipes from a link',
    summary: 'Paste a recipe page\'s link and get the recipe, from its schema.org data',
    branch: 'import-from-link',
    sessionId: '8a41e7b3-2f6d-4d0a-b5c8-71e9f03a6b12',
    ago: 30 * MIN,
    seen: true,
    play: (w) =>
      w
        .live(6 * MIN)
        .prompt(
          'Let people add a recipe by pasting a link to a recipe page. Most recipe sites publish schema.org Recipe data, so start with that.',
        )
        .read('src/recipes/types.ts')
        .write(
          'src/recipes/importFromLink.ts',
          `import type { Recipe } from './types';

/** The schema.org Recipe in a page's JSON-LD, as one of ours. Null if none. */
export function recipeFromHtml(html: string, id: string): Recipe | null {
  for (const m of html.matchAll(/<script type="application\\/ld\\+json">([\\s\\S]*?)<\\/script>/g)) {
    const data = [JSON.parse(m[1])].flat().find((d) => d['@type'] === 'Recipe');
    if (!data) continue;
    return {
      id,
      title: data.name,
      servings: parseInt(data.recipeYield, 10) || 2,
      minutes: minutesOf(data.totalTime),
      ingredients: [],
      steps: (data.recipeInstructions ?? []).map((s: { text: string }) => s.text),
    };
  }
  return null;
}

/** ISO 8601 durations as recipe sites write them: PT1H15M. */
function minutesOf(duration: string | undefined): number {
  const m = /PT(?:(\\d+)H)?(?:(\\d+)M)?/.exec(duration ?? '');
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0;
}
`,
        )
        .commit('Read schema.org Recipe data from a page')
        .say('Now a test with a saved page from a typical recipe site.')
        .pending('npm test -- importFromLink', 'Run the import tests'),
  },
  {
    key: 'search',
    project: 'recipe-app',
    title: 'Search recipes by ingredient',
    summary: 'Search matches ingredients as well as titles',
    branch: 'search-by-ingredient',
    sessionId: 'c3b9d214-6e0f-47a8-8d35-9f4a1e2b7c63',
    ago: 22 * MIN,
    seen: true,
    play: (w) =>
      w
        .live(4 * MIN)
        .prompt('Search should also find recipes by what is in them: "leek" should find the leek and potato soup.')
        .read('src/recipes/search.ts')
        .edit(
          'src/recipes/search.ts',
          `/** Recipes whose title contains every word of the query. */
export function searchRecipes(recipes: Recipe[], query: string): Recipe[] {
  const words = query.toLowerCase().split(/\\s+/).filter(Boolean);
  if (words.length === 0) return recipes;
  return recipes.filter((r) => {
    const title = r.title.toLowerCase();
    return words.every((w) => title.includes(w));
  });
}`,
          `/** Recipes where every word of the query is in the title or an ingredient. */
export function searchRecipes(recipes: Recipe[], query: string): Recipe[] {
  const words = query.toLowerCase().split(/\\s+/).filter(Boolean);
  if (words.length === 0) return recipes;
  return recipes.filter((r) => {
    const text = [r.title, ...r.ingredients.map((i) => i.name)].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}`,
        )
        .pending('npx tsc --noEmit', 'Type-check the project'),
  },
  {
    key: 'fractions',
    project: 'recipe-app',
    title: 'Round amounts to kitchen fractions',
    summary: 'Scaled amounts read as ⅓ cup or 1½ tbsp, not 0.33 or 1.5',
    branch: 'kitchen-fractions',
    sessionId: 'f72a05c8-9d3e-4b61-a0f4-3c8e6d1b9a24',
    ago: 75 * MIN,
    // Looked at since it finished: an approved PR is in Approved. Unseen, it
    // would be in Ready to Review, as any new finish is.
    seen: true,
    pr: {
      number: 14,
      title: 'Round scaled amounts to kitchen fractions',
      checks: [
        { name: 'test', state: 'pass' },
        { name: 'lint', state: 'pass' },
        { name: 'build', state: 'pass' },
      ],
      reviews: [{ author: 'alex-morgan', state: 'APPROVED', minutesAgo: 20 }],
      threads: { total: 0, unresolved: 0 },
    },
    play: (w) =>
      w
        .prompt('Scaled amounts like 0.33 cup read badly. Show them as kitchen fractions: ⅓ cup, 1½ tbsp.')
        .read('src/recipes/scale.ts')
        .write(
          'src/recipes/fractions.ts',
          `const FRACTIONS: [number, string][] = [
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [1 / 2, '½'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
];

/** 1.5 -> "1½", 0.33 -> "⅓": the nearest fraction a measuring cup has. */
export function kitchenAmount(amount: number): string {
  const whole = Math.floor(amount);
  const rest = amount - whole;
  const [, glyph] = FRACTIONS.reduce((best, f) => (Math.abs(f[0] - rest) < Math.abs(best[0] - rest) ? f : best));
  if (rest < 1 / 16) return String(whole);
  if (rest > 15 / 16) return String(whole + 1);
  return whole === 0 ? glyph : \`\${whole}\${glyph}\`;
}
`,
        )
        .write(
          'src/recipes/fractions.test.ts',
          `import { expect, it } from 'vitest';
import { kitchenAmount } from './fractions';

it.each([
  [0.33, '⅓'],
  [0.5, '½'],
  [1.5, '1½'],
  [2.74, '2¾'],
  [0.125, '⅛'],
  [3, '3'],
  [1.98, '2'],
])('%s reads as %s', (amount, text) => {
  expect(kitchenAmount(amount)).toBe(text);
});
`,
        )
        .commit('Round scaled amounts to kitchen fractions')
        .run(
          'npm test',
          'Run the tests',
          ` ✓ src/recipes/scale.test.ts (1 test) 3ms
 ✓ src/recipes/fractions.test.ts (7 tests) 4ms

 Test Files  2 passed (2)
      Tests  8 passed (8)`,
        )
        .run(
          'git push -u origin kitchen-fractions',
          'Push the branch',
          "branch 'kitchen-fractions' set up to track 'origin/kitchen-fractions'.",
        )
        .run(
          'gh pr create --fill',
          'Open a pull request',
          'https://github.com/example/recipe-app/pull/14',
        )
        .end(
          'Opened #14. Amounts in cups and spoons now show as the nearest fraction a measuring cup has (⅛ to ¾), and grams and millilitres stay as they were.',
        ),
  },
  {
    key: 'cooking-time',
    project: 'recipe-app',
    title: 'Show cooking time on recipe cards',
    summary: 'Each recipe card shows its total cooking time',
    branch: 'cooking-time',
    sessionId: '1e6b8d90-4a27-4f3c-8b5e-d2c7a9f01e35',
    ago: 3 * 60 * MIN,
    seen: true,
    done: true,
    play: (w) =>
      w
        .prompt('Show how long each recipe takes on its card.')
        .read('src/recipes/RecipeCard.tsx')
        .edit(
          'src/recipes/RecipeCard.tsx',
          `      <p className="recipe-meta">Serves {recipe.servings}</p>`,
          `      <p className="recipe-meta">
        Serves {recipe.servings} · {recipe.minutes} min
      </p>`,
        )
        .commit('Show total cooking time on recipe cards')
        .end('Each card now reads "Serves 4 · 45 min".'),
  },
  {
    key: 'rss',
    project: 'blog',
    title: 'Add an RSS feed',
    summary: 'An RSS feed of the posts at /rss.xml',
    branch: 'rss-feed',
    sessionId: '9f3d1a6c-7b2e-48d5-a1c0-5e8f2b4d6a07',
    ago: 40 * MIN,
    // Finished after it was last open, with a commit on its branch: Ready to Review.
    seen: false,
    play: (w) =>
      w
        .prompt('Add an RSS feed for the posts.')
        .read('src/content/config.ts')
        .edit(
          'package.json',
          `    "astro": "^4.16.18"`,
          `    "@astrojs/rss": "^4.0.9",
    "astro": "^4.16.18"`,
        )
        .write(
          'src/pages/rss.xml.ts',
          `import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context: { site: URL }) {
  const posts = await getCollection('posts');
  return rss({
    title: 'Notes from the kitchen',
    description: 'Recipes, techniques and the occasional disaster.',
    site: context.site,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.summary,
      pubDate: p.data.published,
      link: \`/posts/\${p.slug}/\`,
    })),
  });
}
`,
        )
        .commit('Add an RSS feed at /rss.xml')
        .end(
          'The feed is at `/rss.xml`, with each post\'s title, date and summary.\n\nOne choice before I finish: should the feed carry each post\'s **full text**, or only the **summary**? Full text lets people read in their feed reader; the summary brings them to the site.',
        ),
  },
  {
    key: 'tags',
    project: 'blog',
    title: 'Show tags on each post',
    summary: 'Posts get tags in their front matter, listed under the title',
    branch: 'post-tags',
    sessionId: '2b7e4c19-5a83-4f06-9d2e-6c1f8a3b0d58',
    ago: 4 * 60 * MIN,
    seen: true,
    // Open, with a reviewer's inline comments not resolved yet: In Review.
    pr: {
      number: 9,
      title: 'Show tags on each post',
      checks: [
        { name: 'test', state: 'pass' },
        { name: 'build', state: 'pass' },
      ],
      reviews: [],
      threads: { total: 3, unresolved: 2 },
    },
    play: (w) =>
      w
        .prompt('Posts should have tags. Put them in the front matter and list them under the title.')
        .read('src/content/config.ts')
        .edit(
          'src/content/config.ts',
          `    published: z.date(),
  }),`,
          `    published: z.date(),
    tags: z.array(z.string()).default([]),
  }),`,
        )
        .edit(
          'src/content/posts/knife-skills.md',
          `published: 2026-10-02
---`,
          `published: 2026-10-02
tags: [technique, knives]
---`,
        )
        .edit(
          'src/content/posts/sourdough-starter.md',
          `published: 2026-09-14
---`,
          `published: 2026-09-14
tags: [baking, sourdough]
---`,
        )
        .write(
          'src/components/Tags.astro',
          `---
const { tags } = Astro.props as { tags: string[] };
---
{tags.length > 0 && (
  <ul class="tags">
    {tags.map((t) => <li>{t}</li>)}
  </ul>
)}
`,
        )
        .commit('Tag posts in their front matter and list the tags under the title')
        .run(
          'git push -u origin post-tags',
          'Push the branch',
          "branch 'post-tags' set up to track 'origin/post-tags'.",
        )
        .run('gh pr create --fill', 'Open a pull request', 'https://github.com/example/blog/pull/9')
        .end('Opened #9. Each post lists its tags under the title; a post without tags shows nothing there.'),
  },
];

/**
 * Pull requests asking `sam-rivera` (the demo's signed-in user) for a review,
 * for the task list's Reviewing tab (#287). Times are minutes before the
 * moment gh is asked, so they stay fresh however long the demo runs. The
 * demo cannot preset what you have opened in Albedo (that is the app's web
 * storage), so New Activity comes from a PR you reviewed on GitHub and its
 * author answering after.
 */
/** Each one's \`files\` are its one commit on main, pushed as \`refs/pull/<n>/head\`. */
const REVIEWS = {
  'recipe-app': [
    {
      number: 34,
      title: 'Print-friendly recipe page',
      files: {
        'src/styles/print.css': `@media print {
  .app-header,
  .recipe-actions {
    display: none;
  }
  .recipe-card {
    break-inside: avoid;
    border: none;
  }
}
`,
        'src/recipes/RecipeCard.tsx': `import type { Recipe } from './types';
import '../styles/print.css';

export function RecipeCard({ recipe }: { recipe: Recipe }) {
  return (
    <article className="recipe-card">
      <h2>{recipe.title}</h2>
      <p className="recipe-meta">Serves {recipe.servings}</p>
      <div className="recipe-actions">
        <button type="button" onClick={() => window.print()}>
          Print
        </button>
      </div>
    </article>
  );
}
`,
      },
      author: 'priya-n',
      section: 'reviewed',
      additions: 96,
      deletions: 14,
      commits: 4,
      lastCommitMinutes: 50,
      talk: [
        { author: 'sam-rivera', minutesAgo: 26 * 60 },
        { author: 'priya-n', minutesAgo: 40 },
      ],
    },
    {
      number: 36,
      title: 'Shopping list from a recipe',
      files: {
        'src/shopping/list.ts': `import type { Ingredient } from '../recipes/types';

/** One line per ingredient, amounts of the same unit added together. */
export function shoppingList(items: Ingredient[]): Ingredient[] {
  const byKey = new Map<string, Ingredient>();
  for (const i of items) {
    const key = \`\${i.name}|\${i.unit}\`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, amount: prev.amount + i.amount } : { ...i });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}
`,
        'src/shopping/list.test.ts': `import { describe, expect, it } from 'vitest';
import { shoppingList } from './list';

describe('shoppingList', () => {
  it('adds up the same ingredient in the same unit', () => {
    const flour = { name: 'flour', amount: 250, unit: 'g' as const };
    expect(shoppingList([flour, flour])).toEqual([{ ...flour, amount: 500 }]);
  });
});
`,
      },
      author: 'jordan-lee',
      section: 'requested',
      additions: 142,
      deletions: 18,
      commits: 3,
      lastCommitMinutes: 200,
      requestedMinutes: 180,
    },
    {
      number: 33,
      title: 'Upgrade the image loader',
      files: {
        'src/recipes/RecipeImage.tsx': `export function RecipeImage({ src, alt }: { src: string; alt: string }) {
  return <img src={src} alt={alt} loading="lazy" decoding="async" width={320} height={200} />;
}
`,
      },
      author: 'alex-kim',
      section: 'requested',
      team: 'web',
      additions: 12,
      deletions: 9,
      commits: 1,
      lastCommitMinutes: 26 * 60,
      requestedMinutes: 25 * 60,
    },
    {
      number: 29,
      title: 'Remember the last search',
      files: {
        'src/recipes/lastSearch.ts': `const KEY = 'recipe-app.lastSearch';

export function readLastSearch(): string {
  return localStorage.getItem(KEY) ?? '';
}

export function saveLastSearch(query: string): void {
  localStorage.setItem(KEY, query);
}
`,
      },
      author: 'priya-n',
      section: 'reviewed',
      additions: 38,
      deletions: 4,
      commits: 2,
      lastCommitMinutes: 3 * 24 * 60,
      talk: [{ author: 'sam-rivera', minutesAgo: 2 * 24 * 60 }],
    },
  ],
  blog: [],
};

/**
 * Everything the setup writes, worked out without touching the disk.
 * `home` is the demo profile's home folder; `now` anchors every time.
 */
export function buildScenario({ home, now }) {
  const projects = [
    { name: 'recipe-app', commits: RECIPE_APP },
    { name: 'blog', commits: BLOG },
  ].map((p) => ({
    ...p,
    repo: `${home}/code/${p.name}`,
    remote: `${home}/remotes/${p.name}.git`,
    worktreeRoot: `${home}/agents/${p.name}`,
    files: mainFiles(p.commits),
  }));

  const tasks = TASKS.map((t) => {
    const project = projects.find((p) => p.name === t.project);
    const worktree = `${project.worktreeRoot}/${t.branch}`;
    const w = workspace({
      files: project.files,
      sessionId: t.sessionId,
      cwd: worktree,
      branch: t.branch,
      startAt: now - t.ago,
    });
    t.play(w);
    return {
      key: t.key,
      title: t.title,
      project: project.name,
      repo: project.repo,
      branch: t.branch,
      worktree,
      sessionId: t.sessionId,
      createdAt: now - t.ago - 2 * MIN,
      seen: t.seen,
      summary: t.summary ?? null,
      done: t.done === true,
      pr: t.pr ?? null,
      ...w.done(),
    };
  });

  const reviews = Object.fromEntries(projects.map((p) => [p.repo, REVIEWS[p.name] ?? []]));
  return { projects, tasks, reviews };
}
