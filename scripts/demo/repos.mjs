// The demo projects' main branches: small, plausible apps, made up for the
// screenshots. Each commit lists the files it writes, whole.

export const RECIPE_APP = [
  {
    message: 'Recipe list and detail pages',
    daysAgo: 12,
    files: {
      'package.json': `{
  "name": "recipe-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vitest": "^2.1.8"
  }
}
`,
      'README.md': `# recipe-app

Keep your recipes in one place, scale them to the number of people at the
table, and cook from your phone.

\`\`\`sh
npm install
npm run dev
\`\`\`
`,
      'src/App.tsx': `import { RecipeList } from './recipes/RecipeList';
import { SettingsPage } from './settings/SettingsPage';
import './styles/theme.css';

export function App({ page }: { page: 'recipes' | 'settings' }) {
  return page === 'settings' ? <SettingsPage /> : <RecipeList />;
}
`,
      'src/recipes/types.ts': `export interface Ingredient {
  name: string;
  amount: number;
  unit: 'g' | 'ml' | 'cup' | 'tbsp' | 'tsp' | 'piece';
}

export interface Recipe {
  id: string;
  title: string;
  servings: number;
  minutes: number;
  ingredients: Ingredient[];
  steps: string[];
}
`,
      'src/recipes/RecipeList.tsx': `import { useRecipes } from './useRecipes';
import { RecipeCard } from './RecipeCard';

export function RecipeList() {
  const recipes = useRecipes();
  return (
    <ul className="recipe-list">
      {recipes.map((r) => (
        <li key={r.id}>
          <RecipeCard recipe={r} />
        </li>
      ))}
    </ul>
  );
}
`,
      'src/recipes/RecipeCard.tsx': `import type { Recipe } from './types';

export function RecipeCard({ recipe }: { recipe: Recipe }) {
  return (
    <article className="recipe-card">
      <h2>{recipe.title}</h2>
      <p className="recipe-meta">Serves {recipe.servings}</p>
    </article>
  );
}
`,
      'src/recipes/useRecipes.ts': `import { useEffect, useState } from 'react';
import type { Recipe } from './types';

export function useRecipes(): Recipe[] {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  useEffect(() => {
    fetch('/api/recipes')
      .then((r) => r.json())
      .then(setRecipes);
  }, []);
  return recipes;
}
`,
      'src/recipes/search.ts': `import type { Recipe } from './types';

/** Recipes whose title contains every word of the query. */
export function searchRecipes(recipes: Recipe[], query: string): Recipe[] {
  const words = query.toLowerCase().split(/\\s+/).filter(Boolean);
  if (words.length === 0) return recipes;
  return recipes.filter((r) => {
    const title = r.title.toLowerCase();
    return words.every((w) => title.includes(w));
  });
}
`,
      'src/styles/theme.css': `body {
  margin: 0;
  font: 17px/1.5 system-ui, sans-serif;
  background: #fffdf8;
  color: #1f1b16;
}

.recipe-card {
  border: 1px solid #e6dfd3;
  border-radius: 12px;
  padding: 16px;
  background: #ffffff;
}

.recipe-meta {
  color: #6b6257;
}

a {
  color: #b4441c;
}
`,
    },
  },
  {
    message: 'Scale ingredients to the number of servings',
    daysAgo: 9,
    files: {
      'src/recipes/scale.ts': `import type { Ingredient } from './types';

/** The same ingredients for \`servings\` people instead of \`from\`. */
export function scaleIngredients(items: Ingredient[], from: number, servings: number): Ingredient[] {
  const factor = servings / from;
  return items.map((i) => ({ ...i, amount: Math.round(i.amount * factor * 100) / 100 }));
}
`,
      'src/recipes/scale.test.ts': `import { describe, expect, it } from 'vitest';
import { scaleIngredients } from './scale';

describe('scaleIngredients', () => {
  it('doubles every amount for twice the servings', () => {
    const flour = { name: 'flour', amount: 250, unit: 'g' as const };
    expect(scaleIngredients([flour], 2, 4)).toEqual([{ ...flour, amount: 500 }]);
  });
});
`,
    },
  },
  {
    message: 'Settings page: metric or US units',
    daysAgo: 5,
    files: {
      'src/settings/useSettings.ts': `import { useCallback, useState } from 'react';

export interface Settings {
  units: 'metric' | 'us';
}

const KEY = 'recipe-app.settings';
const DEFAULTS: Settings = { units: 'metric' };

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [settings, update] as const;
}
`,
      'src/settings/SettingsPage.tsx': `import { useSettings } from './useSettings';

export function SettingsPage() {
  const [settings, update] = useSettings();
  return (
    <form className="settings">
      <h1>Settings</h1>
      <label>
        Units
        <select value={settings.units} onChange={(e) => update({ units: e.target.value as 'metric' | 'us' })}>
          <option value="metric">Metric (g, ml)</option>
          <option value="us">US (cups, oz)</option>
        </select>
      </label>
    </form>
  );
}
`,
      'src/settings/SettingsPage.test.tsx': `import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  beforeEach(() => localStorage.clear());

  it('starts with metric units', () => {
    render(<SettingsPage />);
    expect(screen.getByLabelText('Units')).toHaveValue('metric');
  });

  it('remembers the units', () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: 'us' } });
    expect(JSON.parse(localStorage.getItem('recipe-app.settings')!)).toEqual({ units: 'us' });
  });
});
`,
    },
  },
];

export const BLOG = [
  {
    message: 'Blog with posts written in Markdown',
    daysAgo: 20,
    files: {
      'package.json': `{
  "name": "blog",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "test": "vitest run"
  },
  "dependencies": {
    "astro": "^4.16.18"
  },
  "devDependencies": {
    "vitest": "^2.1.8"
  }
}
`,
      'astro.config.mjs': `import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://blog.example.com',
});
`,
      'src/content/config.ts': `import { defineCollection, z } from 'astro:content';

const posts = defineCollection({
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    published: z.date(),
  }),
});

export const collections = { posts };
`,
      'src/content/posts/sourdough-starter.md': `---
title: Keeping a sourdough starter alive
summary: Feed it, forget it, and what to do when it smells like nail polish.
published: 2026-09-14
---

A starter is flour, water and patience.
`,
      'src/content/posts/knife-skills.md': `---
title: Three knife cuts worth learning
summary: The rock, the push and the claw, and why the claw matters most.
published: 2026-10-02
---

Most of cooking is cutting things into pieces of the same size.
`,
      'src/pages/index.astro': `---
import { getCollection } from 'astro:content';
const posts = (await getCollection('posts')).sort((a, b) => +b.data.published - +a.data.published);
---
<ul>
  {posts.map((p) => <li><a href={\`/posts/\${p.slug}/\`}>{p.data.title}</a></li>)}
</ul>
`,
    },
  },
];
