import { describe, expect, it } from 'vitest';
import { iconFor } from './fileIcons';

describe('iconFor', () => {
  it('reads the extension', () => {
    expect(iconFor('src/Http/Controller.php')).toBe('php');
    expect(iconFor('views/legacy.phtml')).toBe('php');
    expect(iconFor('src/ui/App.tsx')).toBe('react');
    expect(iconFor('src/ui/Old.jsx')).toBe('react');
    expect(iconFor('src/main.ts')).toBe('script');
    expect(iconFor('build.mjs')).toBe('script');
    expect(iconFor('legacy.cjs')).toBe('script');
    expect(iconFor('public/app.js')).toBe('script');
    expect(iconFor('tsconfig.json')).toBe('data');
    expect(iconFor('.github/workflows/ci.yml')).toBe('config');
    expect(iconFor('docker-compose.yaml')).toBe('config');
    expect(iconFor('Cargo.toml')).toBe('config');
    expect(iconFor('php.ini')).toBe('config');
    expect(iconFor('README.md')).toBe('docs');
    expect(iconFor('docs/intro.mdx')).toBe('docs');
    expect(iconFor('notes.txt')).toBe('docs');
    expect(iconFor('src/styles.css')).toBe('styles');
    expect(iconFor('a.scss')).toBe('styles');
    expect(iconFor('a.sass')).toBe('styles');
    expect(iconFor('index.html')).toBe('markup');
    expect(iconFor('templates/base.twig')).toBe('markup');
    for (const ext of ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp']) expect(iconFor(`logo.${ext}`)).toBe('image');
    expect(iconFor('build.sh')).toBe('shell');
    expect(iconFor('src/db/schema.sql')).toBe('sql');
    expect(iconFor('Cargo.lock')).toBe('lock');
    expect(iconFor('composer.lock')).toBe('lock');
  });

  it('knows the names that say more than their extension', () => {
    expect(iconFor('composer.json')).toBe('manifest');
    expect(iconFor('packages/web/package.json')).toBe('manifest');
    expect(iconFor('package-lock.json')).toBe('lock');
    expect(iconFor('pnpm-lock.yaml')).toBe('lock');
    expect(iconFor('Dockerfile')).toBe('shell');
    expect(iconFor('docker/Dockerfile.dev')).toBe('shell');
    expect(iconFor('api.dockerfile')).toBe('shell');
    expect(iconFor('Makefile')).toBe('shell');
    expect(iconFor('GNUmakefile')).toBe('shell');
    expect(iconFor('.env')).toBe('config');
    expect(iconFor('app/.env.example')).toBe('config');
    expect(iconFor('.env.local')).toBe('config');
  });

  it('ignores case', () => {
    expect(iconFor('LOGO.PNG')).toBe('image');
    expect(iconFor('Readme.MD')).toBe('docs');
    expect(iconFor('DOCKERFILE')).toBe('shell');
    expect(iconFor('Package.JSON')).toBe('manifest');
    expect(iconFor('.ENV')).toBe('config');
  });

  it('reads multi-dot names by what they are', () => {
    expect(iconFor('resources/views/welcome.blade.php')).toBe('markup');
    expect(iconFor('src/vite-env.d.ts')).toBe('script');
    expect(iconFor('src/ui/icons.test.ts')).toBe('script');
    expect(iconFor('jquery.min.js')).toBe('script');
  });

  it('falls back to the generic page', () => {
    expect(iconFor('LICENSE')).toBe('file');
    expect(iconFor('.gitignore')).toBe('file');
    expect(iconFor('bin/console')).toBe('file');
    expect(iconFor('archive.tar.gz')).toBe('file');
    expect(iconFor('trailing.')).toBe('file');
    expect(iconFor('odd.constructor')).toBe('file');
    // A name merely starting with "env" is not an env file.
    expect(iconFor('.envrc')).toBe('file');
    // The folder a path sits in never decides.
    expect(iconFor('styles.css/README')).toBe('file');
  });
});
