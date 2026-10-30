import { describe, expect, it } from 'vitest';
import { crateFor, mismatches, tauriNpmVersions } from './check-tauri-versions.mjs';

describe('Tauri JS and Rust packages in step (#177)', () => {
  it('pairs the api with tauri and each plugin with its crate; the CLI has none', () => {
    expect(crateFor('@tauri-apps/api')).toBe('tauri');
    expect(crateFor('@tauri-apps/plugin-sql')).toBe('tauri-plugin-sql');
    expect(crateFor('@tauri-apps/cli')).toBeNull();
    expect(crateFor('@tauri-apps/cli-darwin-arm64')).toBeNull();
  });

  it('reads only the top-level @tauri-apps packages', () => {
    const lock = JSON.stringify({
      packages: {
        '': { name: 'app' },
        'node_modules/@tauri-apps/api': { version: '2.12.4' },
        'node_modules/@tauri-apps/plugin-fs': { version: '2.7.1' },
        'node_modules/@tauri-apps/plugin-fs/node_modules/@tauri-apps/api': { version: '2.10.0' },
        'node_modules/react': { version: '19.0.0' },
      },
    });
    expect([...tauriNpmVersions(lock)]).toEqual([
      ['@tauri-apps/api', '2.12.4'],
      ['@tauri-apps/plugin-fs', '2.7.1'],
    ]);
  });

  it("reports the pairs #160 broke, and not a patch difference", () => {
    const npm = new Map([
      ['@tauri-apps/api', '2.12.4'],
      ['@tauri-apps/plugin-shell', '2.5.0'],
      ['@tauri-apps/plugin-fs', '2.7.1'],
      ['@tauri-apps/cli', '2.12.4'],
    ]);
    const cargo = new Map([
      ['tauri', '2.11.5'],
      ['tauri-plugin-shell', '2.3.6'],
      ['tauri-plugin-fs', '2.7.0'],
    ]);
    expect(mismatches(npm, cargo)).toEqual([
      { npm: '@tauri-apps/api', npmVersion: '2.12.4', crate: 'tauri', crateVersion: '2.11.5' },
      { npm: '@tauri-apps/plugin-shell', npmVersion: '2.5.0', crate: 'tauri-plugin-shell', crateVersion: '2.3.6' },
    ]);
  });

  it('skips a package whose crate is not in the lockfile', () => {
    expect(mismatches(new Map([['@tauri-apps/plugin-os', '2.3.0']]), new Map())).toEqual([]);
  });
});
