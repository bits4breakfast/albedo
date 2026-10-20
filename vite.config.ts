import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Which commit this build is, so the app can say what is running. Read here
 * rather than in build.sh so `tauri build`, `tauri dev` and build.sh all get
 * it. `dirty` means the tree had uncommitted changes: the commit alone does
 * not describe it. Null outside a git checkout.
 */
function buildInfo(): { sha: string; dirty: boolean; at: string } | null {
  try {
    const git = (args: string) => execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { sha: git('rev-parse --short HEAD'), dirty: git('status --porcelain') !== '', at: new Date().toISOString() };
  } catch {
    return null;
  }
}

// Tauri expects a fixed port and does not tolerate the server falling back.
export default defineConfig({
  plugins: [react()],
  define: { __ALBEDO_BUILD__: JSON.stringify(buildInfo()) },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'safari15', sourcemap: true },
});
