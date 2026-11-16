// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isJumpToLatestKey, JUMP_LATEST_ATTR, keyboardIsFree, transcriptTakesJumpKey } from './jumpKey';

afterEach(() => {
  document.body.innerHTML = '';
});

function layout() {
  document.body.innerHTML = `
    <div class="tx-scroll" id="scroller">
      <button id="chip">tool</button>
      <input id="inner-field" />
    </div>
    <textarea id="composer"></textarea>
    <div contenteditable="true" id="code"></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  return { scroller: $('scroller'), chip: $('chip'), innerField: $('inner-field'), composer: $('composer'), code: $('code') };
}

describe('keyboardIsFree (⌥⌘↓ to the latest message)', () => {
  it('acts when nothing has focus', () => {
    const { scroller } = layout();
    expect(keyboardIsFree(null, scroller)).toBe(true);
    expect(keyboardIsFree(document.body, scroller)).toBe(true);
  });

  it('acts when focus is in the transcript but not in a field', () => {
    const { scroller, chip } = layout();
    expect(keyboardIsFree(chip, scroller)).toBe(true);
  });

  it('holds back when a text field or something outside the transcript has focus', () => {
    const { scroller, innerField, composer, code } = layout();
    expect(keyboardIsFree(innerField, scroller)).toBe(false);
    expect(keyboardIsFree(composer, scroller)).toBe(false);
    expect(keyboardIsFree(code, scroller)).toBe(false);
  });
});

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', ...init });
const JUMP = { metaKey: true, altKey: true };

/** jsdom has no layout: offsetParent is always null, i.e. never on screen. */
function showOnScreen(el: HTMLElement) {
  Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => document.body });
}

describe('isJumpToLatestKey (#398)', () => {
  it('is ⌥⌘↓, and not ⌘↓, which steps to the next task', () => {
    expect(isJumpToLatestKey(key(JUMP))).toBe(true);
    expect(isJumpToLatestKey(key({ metaKey: true }))).toBe(false);
    expect(isJumpToLatestKey(key({ ...JUMP, shiftKey: true }))).toBe(false);
    expect(isJumpToLatestKey(key({ ...JUMP, ctrlKey: true }))).toBe(false);
    expect(isJumpToLatestKey(key({ ...JUMP, key: 'ArrowUp', code: 'ArrowUp' }))).toBe(false);
  });
});

describe('transcriptTakesJumpKey: when the editor lets ⌥⌘↓ through (#398)', () => {
  it('is true for ⌥⌘↓ with a transcript on screen and the keyboard free there', () => {
    const { scroller, chip } = layout();
    scroller.setAttribute(JUMP_LATEST_ATTR, '');
    showOnScreen(scroller);
    expect(transcriptTakesJumpKey(key(JUMP))).toBe(true);
    chip.focus();
    expect(transcriptTakesJumpKey(key(JUMP))).toBe(true);
    // ⌥⌘↑ is still the editor's.
    expect(transcriptTakesJumpKey(key({ ...JUMP, key: 'ArrowUp', code: 'ArrowUp' }))).toBe(false);
  });

  it('is false with the transcript hidden, or focus in a field or elsewhere', () => {
    const { scroller, composer } = layout();
    scroller.setAttribute(JUMP_LATEST_ATTR, '');
    expect(transcriptTakesJumpKey(key(JUMP))).toBe(false);
    showOnScreen(scroller);
    composer.focus();
    expect(transcriptTakesJumpKey(key(JUMP))).toBe(false);
  });
});
