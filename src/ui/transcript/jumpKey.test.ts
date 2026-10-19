// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { keyboardIsFree } from './TranscriptPane';

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

describe('keyboardIsFree (⌘↓ to the latest message)', () => {
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
