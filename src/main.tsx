import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import App from './App';
import { applyPlatform, watchFullscreen } from './lib/platform';
import { applyStoredTheme } from './ui/theme';

// Before the first paint, not in an effect: an effect would render one frame
// of the wrong theme (or the wrong header padding) on every launch.
applyStoredTheme();
applyPlatform();
void watchFullscreen();

const host = document.getElementById('root');
if (!host) throw new Error('Albedo: #root is missing from index.html');

/**
 * Deliberately not wrapped in <StrictMode>. Strict mode double-invokes effects
 * in dev, and this app's mount effects have real side effects — spawning a pty
 * and starting the transcript watcher. A spawn/kill/spawn cycle on every mount
 * would churn real `claude` processes.
 */
createRoot(host).render(<App />);
