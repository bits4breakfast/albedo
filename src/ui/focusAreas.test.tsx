/**
 * @vitest-environment jsdom
 *
 * The Tab cycle between the window's areas (#129): the pure decisions first,
 * then the DOM wiring against a fixture shaped like App's areas.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import {
  AREA_ORDER,
  areaSequence,
  cycleKeyOf,
  focusOnItsOwn,
  shouldCycle,
  useFocusAreaCycle,
  type FocusArea,
} from './focusAreas';
import { terminalTakesKey } from './shortcuts';

const all = new Set<FocusArea>(AREA_ORDER);
const without = (...gone: FocusArea[]) => new Set(AREA_ORDER.filter((a) => !gone.includes(a)));
const probe = (init: Partial<KeyboardEvent> = {}) =>
  ({ key: 'Tab', code: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...init }) as KeyboardEvent;

describe('cycleKeyOf', () => {
  it('reads Tab forwards and Shift+Tab backwards', () => {
    expect(cycleKeyOf(probe())).toEqual({ dir: 1, leave: false });
    expect(cycleKeyOf(probe({ shiftKey: true }))).toEqual({ dir: -1, leave: false });
  });

  it('reads Ctrl+Tab and Ctrl+Shift+Tab as the keys that leave', () => {
    expect(cycleKeyOf(probe({ ctrlKey: true }))).toEqual({ dir: 1, leave: true });
    expect(cycleKeyOf(probe({ ctrlKey: true, shiftKey: true }))).toEqual({ dir: -1, leave: true });
  });

  it('ignores Command and Option with Tab, other keys and IME composition', () => {
    expect(cycleKeyOf(probe({ metaKey: true }))).toBeNull();
    expect(cycleKeyOf(probe({ altKey: true }))).toBeNull();
    expect(cycleKeyOf(probe({ key: 'Escape' }))).toBeNull();
    expect(cycleKeyOf({ ...probe(), isComposing: true })).toBeNull();
  });
});

describe('shouldCycle', () => {
  const calm = { modalOpen: false, keepsTab: false, handled: false };
  const tab = { dir: 1 as const, leave: false };
  const ctrlTab = { dir: 1 as const, leave: true };

  it('cycles on Tab from anywhere that does not keep Tab', () => {
    expect(shouldCycle(tab, calm)).toBe(true);
  });

  it('leaves plain Tab to the terminal and the editor, but not Ctrl+Tab', () => {
    expect(shouldCycle(tab, { ...calm, keepsTab: true })).toBe(false);
    expect(shouldCycle({ ...tab, dir: -1 }, { ...calm, keepsTab: true })).toBe(false);
    expect(shouldCycle(ctrlTab, { ...calm, keepsTab: true })).toBe(true);
  });

  it('never acts behind an open dialog, with either key', () => {
    expect(shouldCycle(tab, { ...calm, modalOpen: true })).toBe(false);
    expect(shouldCycle(ctrlTab, { ...calm, modalOpen: true })).toBe(false);
  });

  it('leaves a key something else already handled', () => {
    expect(shouldCycle(tab, { ...calm, handled: true })).toBe(false);
  });
});

describe('areaSequence', () => {
  it('goes message box → terminal → Files → task list → message box', () => {
    const shown = without('editor');
    expect(areaSequence('composer', shown, 1)[0]).toBe('terminal');
    expect(areaSequence('terminal', shown, 1)[0]).toBe('files');
    expect(areaSequence('files', shown, 1)[0]).toBe('tasks');
    expect(areaSequence('tasks', shown, 1)[0]).toBe('composer');
  });

  it('walks backwards on Shift', () => {
    const shown = without('editor');
    expect(areaSequence('composer', shown, -1)[0]).toBe('tasks');
    expect(areaSequence('tasks', shown, -1)[0]).toBe('files');
    expect(areaSequence('files', shown, -1)[0]).toBe('terminal');
    expect(areaSequence('terminal', shown, -1)[0]).toBe('composer');
  });

  it('starts at the message box from outside every area, in either direction', () => {
    expect(areaSequence(null, all, 1)[0]).toBe('composer');
    expect(areaSequence(null, all, -1)[0]).toBe('composer');
  });

  it('skips an area that is not on screen', () => {
    // Transcript-only layout: no terminal pane.
    expect(areaSequence('composer', without('editor', 'terminal'), 1)[0]).toBe('files');
    // Terminal-only layout: no message box, so from outside the next one.
    expect(areaSequence(null, without('composer', 'editor'), 1)[0]).toBe('terminal');
    expect(areaSequence(null, without('composer', 'editor'), -1)[0]).toBe('tasks');
  });

  it('puts the editor in the message box slot when it is showing instead', () => {
    const shown = without('composer');
    expect(areaSequence('tasks', shown, 1)[0]).toBe('editor');
    expect(areaSequence('editor', shown, 1)[0]).toBe('terminal');
  });

  it('lists every other area on screen once, and never the one it starts from', () => {
    expect(areaSequence('files', all, 1)).toEqual(['tasks', 'composer', 'editor', 'terminal']);
    expect(areaSequence('tasks', new Set<FocusArea>(['tasks']), 1)).toEqual([]);
  });
});

describe('the terminal hands over Ctrl+Tab', () => {
  it('lets Ctrl+Tab and Ctrl+Shift+Tab leave instead of reaching the pty', () => {
    expect(terminalTakesKey(probe({ ctrlKey: true }))).toBe(false);
    expect(terminalTakesKey(probe({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('keeps plain Tab and Shift+Tab: autocomplete and the mode switch', () => {
    expect(terminalTakesKey(probe())).toBe(true);
    expect(terminalTakesKey(probe({ shiftKey: true }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/** App's areas, reduced to the attributes the cycle reads. */
const FIXTURE = `
  <button id="toolbar">Split</button>
  <div class="tasklist" id="tasks" tabindex="0" data-focus-area="tasks">
    <button id="new-task">New Task</button>
    <div class="task-row" tabindex="-1">A task</div>
  </div>
  <div id="transcript"><a href="#x" id="link">a link</a>
    <div id="card" data-focus-keeps-tab=""><input id="other" /><button id="submit">Submit</button></div>
  </div>
  <div id="composer" data-focus-area="composer">
    <textarea id="message" data-focus-default=""></textarea>
    <button id="send">Send</button>
  </div>
  <section id="terminal" data-focus-area="terminal">
    <div class="term" hidden=""><textarea id="xterm-other" data-focus-default="" data-focus-keeps-tab=""></textarea></div>
    <div class="term"><textarea id="xterm" data-focus-default="" data-focus-keeps-tab=""></textarea></div>
  </section>
  <div id="files" data-focus-area="files">
    <button id="commit">Commit</button>
    <div id="row-a" tabindex="0" data-focus-fallback="">a.ts</div>
    <div id="row-b" tabindex="0" data-focus-default="" data-focus-fallback="">b.ts</div>
  </div>
  <div id="editor-panel" data-focus-area="editor" hidden="">
    <div id="cm" tabindex="0" data-focus-default="" data-focus-keeps-tab="">code</div>
  </div>
`;

const $ = (id: string) => document.getElementById(id)!;
const active = () => document.activeElement?.id ?? null;

/** A key pressed where focus is, the way the browser delivers it. */
function press(init: KeyboardEventInit = {}): boolean {
  const target = document.activeElement ?? document.body;
  return fireEvent.keyDown(target, { key: 'Tab', code: 'Tab', ...init });
}

describe('the cycle in the DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    renderHook(() => useFocusAreaCycle());
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('lands in the message box on the first Tab with nothing focused', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    expect(press()).toBe(false); // default prevented
    expect(active()).toBe('message');
  });

  it('lands in the message box from a control outside every area, either direction', () => {
    $('toolbar').focus();
    press();
    expect(active()).toBe('message');
    $('link').focus();
    press({ shiftKey: true });
    expect(active()).toBe('message');
  });

  it('goes around: message box → terminal → Files → task list → message box', () => {
    $('message').focus();
    press();
    expect(active()).toBe('xterm');
    // The terminal keeps plain Tab; Ctrl+Tab leaves it.
    press({ ctrlKey: true });
    expect(active()).toBe('row-b');
    press();
    expect(active()).toBe('tasks');
    press();
    expect(active()).toBe('message');
  });

  it('goes backwards on Shift+Tab', () => {
    $('message').focus();
    press({ shiftKey: true });
    expect(active()).toBe('tasks');
    press({ shiftKey: true });
    expect(active()).toBe('row-b');
    press({ shiftKey: true });
    expect(active()).toBe('xterm');
    press({ ctrlKey: true, shiftKey: true });
    expect(active()).toBe('message');
  });

  it('cycles from any control inside an area, not only its stop', () => {
    $('new-task').focus();
    press();
    expect(active()).toBe('message');
    $('send').focus();
    press();
    expect(active()).toBe('xterm');
  });

  it('focuses the open file row, else the first row', () => {
    $('tasks').focus();
    press({ shiftKey: true });
    expect(active()).toBe('row-b');
    $('row-b').removeAttribute('data-focus-default');
    $('tasks').focus();
    press({ shiftKey: true });
    expect(active()).toBe('row-a');
  });

  it('leaves plain Tab and Shift+Tab to the terminal', () => {
    $('xterm').focus();
    expect(press()).toBe(true); // not prevented: the key is the terminal's
    expect(press({ shiftKey: true })).toBe(true);
    expect(active()).toBe('xterm');
  });

  it('leaves plain Tab to the editor, and Ctrl+Tab takes you out of it', () => {
    $('editor-panel').removeAttribute('hidden');
    $('composer').setAttribute('hidden', '');
    $('cm').focus();
    expect(press()).toBe(true);
    expect(active()).toBe('cm');
    press({ ctrlKey: true });
    expect(active()).toBe('xterm');
    // ...and the editor takes the message box's place in the cycle.
    $('tasks').focus();
    press();
    expect(active()).toBe('cm');
  });

  it('leaves Tab to a small form that walks its own fields', () => {
    $('other').focus();
    expect(press()).toBe(true);
    expect(active()).toBe('other');
    press({ ctrlKey: true });
    expect(active()).toBe('message');
  });

  it('skips an area that is not on screen', () => {
    $('terminal').setAttribute('hidden', '');
    $('message').focus();
    press();
    expect(active()).toBe('row-b');
  });

  it('skips an area whose stop cannot take focus', () => {
    ($('message') as HTMLTextAreaElement).disabled = true;
    $('send').setAttribute('disabled', '');
    $('tasks').focus();
    press();
    expect(active()).toBe('xterm');
  });

  it('focuses the visible terminal, not a hidden one', () => {
    $('message').focus();
    press();
    expect(active()).toBe('xterm');
  });

  it('does nothing behind an open dialog, with either key', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<input id="q" />';
    document.body.append(dialog);
    $('q').focus();
    expect(press()).toBe(true);
    expect(press({ ctrlKey: true })).toBe(true);
    expect(active()).toBe('q');
  });

  it('leaves a Tab that something else already handled', () => {
    $('toolbar').addEventListener('keydown', (e) => e.preventDefault());
    $('toolbar').focus();
    press();
    expect(active()).toBe('toolbar');
  });

  it('ignores Command+Tab and Option+Tab', () => {
    $('toolbar').focus();
    press({ metaKey: true });
    press({ altKey: true });
    expect(active()).toBe('toolbar');
  });

  it('rings the area it moved into, until focus leaves it', () => {
    $('message').focus();
    press();
    expect($('terminal').hasAttribute('data-focus-arrived')).toBe(true);
    press({ ctrlKey: true });
    expect($('terminal').hasAttribute('data-focus-arrived')).toBe(false);
    expect($('files').hasAttribute('data-focus-arrived')).toBe(true);
    // Moving within the area keeps it; a click elsewhere drops it.
    $('row-a').focus();
    expect($('files').hasAttribute('data-focus-arrived')).toBe(true);
    $('toolbar').focus();
    expect($('files').hasAttribute('data-focus-arrived')).toBe(false);
  });

  describe('a terminal that took focus when its task was selected', () => {
    // xterm's custom key handler, as Terminal.tsx installs it: a key it
    // refuses bubbles on; one it takes is sent to the pty and stopped.
    beforeEach(() => {
      $('xterm').addEventListener('keydown', (e) => {
        if (!terminalTakesKey(e)) return;
        e.preventDefault();
        e.stopPropagation();
      });
    });

    it('gives the first Tab to the message box', () => {
      focusOnItsOwn($('xterm'));
      expect(active()).toBe('xterm');
      press();
      expect(active()).toBe('message');
    });

    it('never takes Shift+Tab: it is Claude Code\'s mode switch', () => {
      focusOnItsOwn($('xterm'));
      expect(press({ shiftKey: true })).toBe(false); // the terminal's handler took it
      expect(active()).toBe('xterm');
    });

    it('keeps Tab once you type in it: autocomplete still works', () => {
      focusOnItsOwn($('xterm'));
      fireEvent.keyDown($('xterm'), { key: 'a', code: 'KeyA' });
      expect(press()).toBe(false); // the terminal's handler took it
      expect(active()).toBe('xterm');
    });

    it('a bare modifier is not typing', () => {
      focusOnItsOwn($('xterm'));
      fireEvent.keyDown($('xterm'), { key: 'Shift', code: 'ShiftLeft' });
      press();
      expect(active()).toBe('message');
    });

    it('keeps Tab once you click', () => {
      focusOnItsOwn($('xterm'));
      fireEvent.pointerDown($('terminal'));
      press();
      expect(active()).toBe('xterm');
    });

    it('keeps Tab when you reach it yourself', () => {
      $('message').focus();
      press();
      expect(active()).toBe('xterm');
      expect(press()).toBe(false);
      expect(active()).toBe('xterm');
    });
  });

  it('does not ring an area focused by a click', () => {
    $('message').focus();
    expect($('composer').hasAttribute('data-focus-arrived')).toBe(false);
  });
});
