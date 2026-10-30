import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildInfo } from './src/lib/buildEmbed';

/*
 * Which commit this build is, so the app can say what is running, and the
 * first-parent history before it, for What's New. Read here rather than in
 * build.sh so `tauri build`, `tauri dev` and build.sh all get it. Null outside
 * a git checkout; src/lib/buildEmbed.ts says what fails soft and how.
 */
const build = buildInfo();

// Tauri expects a fixed port and does not tolerate the server falling back.
export default defineConfig({
  plugins: [react()],
  define: { __ALBEDO_BUILD__: JSON.stringify(build) },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'safari15', sourcemap: true },
});
