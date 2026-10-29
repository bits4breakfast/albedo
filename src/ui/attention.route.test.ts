import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The real backends, below the `__setAttentionBackend` seam: which route a
 * banner takes, and what a click on one does. The rest of attention.ts is
 * tested through the seam in attention.test.ts; this is the part the seam hid
 * when neither the bounce nor the banners ever reached the owner (#102).
 */

const invoke = vi.fn();
const sendNotification = vi.fn();
const isPermissionGranted = vi.fn();
const requestPermission = vi.fn();
let clicked: ((e: { payload: unknown }) => void) | null = null;

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    if (name === 'albedo://notification-clicked') clicked = fn;
    return Promise.resolve(() => {
      clicked = null;
    });
  },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFocused: () => Promise.resolve(false),
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => isPermissionGranted(),
  requestPermission: () => requestPermission(),
  sendNotification: (n: unknown) => sendNotification(n),
}));

/** A fresh module per test: the route is decided once per run. */
async function load() {
  vi.resetModules();
  const mod = await import('./attention');
  mod.watchFocus();
  // Let isFocused() resolve, so the window reads as unfocused.
  await new Promise((r) => setTimeout(r, 0));
  return mod;
}

/** What `invoke` answers for each native command. */
function native(permission: string | Error) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'notify_permission') {
      return permission instanceof Error ? Promise.reject(permission) : Promise.resolve(permission);
    }
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  invoke.mockReset();
  sendNotification.mockReset();
  isPermissionGranted.mockReset();
  requestPermission.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('banner route', () => {
  it('posts through the native command, carrying the task id, once macOS grants it', async () => {
    native('granted');
    const a = await load();
    a.noteStatusChange(4, 'running', 'idle', 'Fix login');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('notify_post', expect.anything()));
    expect(invoke).toHaveBeenCalledWith('notify_post', {
      title: 'Fix login',
      body: 'Finished its turn. The result is ready to read.',
      taskId: 4,
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('falls back to the plugin outside an app bundle (tauri dev)', async () => {
    native('unsupported');
    isPermissionGranted.mockResolvedValue(true);
    const a = await load();
    a.noteStatusChange(4, 'running', 'idle', 'Fix login');
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith('notify_post', expect.anything());
  });

  it('says why when macOS refuses, and posts nothing', async () => {
    native(new Error('Notifications are not allowed for this application'));
    const a = await load();
    a.noteStatusChange(4, 'running', 'idle', 'Fix login');
    await vi.waitFor(() => expect(a.notificationProblem()).toBe('Notifications are not allowed for this application'));
    expect(invoke).not.toHaveBeenCalledWith('notify_post', expect.anything());
    expect(sendNotification).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('asks macOS once per run, not once per banner', async () => {
    native('granted');
    const a = await load();
    a.noteStatusChange(4, 'running', 'idle', 'Fix login');
    a.noteStatusChange(5, 'running', 'blocked', 'Add export');
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === 'notify_post')).toHaveLength(2));
    expect(invoke.mock.calls.filter(([c]) => c === 'notify_permission')).toHaveLength(1);
  });
});

describe('dock bounce', () => {
  it('asks the native command, critical only for a task waiting on you', async () => {
    native('granted');
    const a = await load();
    a.noteStatusChange(4, 'running', 'idle', 'Fix login');
    a.noteStatusChange(5, 'running', 'blocked', 'Add export');
    expect(invoke).toHaveBeenCalledWith('attention_bounce', { critical: false });
    expect(invoke).toHaveBeenCalledWith('attention_bounce', { critical: true });
  });
});

describe('onNotificationClick', () => {
  it('hands over the task a banner was posted for, and ignores one without', async () => {
    const a = await load();
    const opened: number[] = [];
    const off = a.onNotificationClick((id) => opened.push(id));
    await vi.waitFor(() => expect(clicked).not.toBeNull());
    clicked?.({ payload: 7 });
    clicked?.({ payload: null });
    expect(opened).toEqual([7]);
    off();
    expect(clicked).toBeNull();
  });
});
