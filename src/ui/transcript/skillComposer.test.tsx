/**
 * @vitest-environment jsdom
 *
 * The message box's `/` list of skills (#349), driven through the real
 * Composer: when it opens and closes, the keys it takes (Return inserts and
 * never sends while it is open), what a pick inserts, and how long the strip
 * a pick leaves stays. Skill names and descriptions are made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { submitPty } from '../Terminal';
import { __resetSkills, recordSkillListings } from '../../capture/skills';
import { Composer } from './TranscriptPane';
import { __resetDrafts } from './drafts';

vi.mock('../Terminal', () => ({
  submitPty: vi.fn(async () => true),
  startPty: vi.fn(() => false),
  hasLivePty: vi.fn(() => true),
  ptyLiveSince: vi.fn(() => null),
  canResume: vi.fn(() => false),
  onPtyPresenceChange: vi.fn(() => () => {}),
}));
vi.mock('../../db/comments', async () => ({
  ...(await vi.importActual<typeof import('../../db/comments')>('../../db/comments')),
  markCommentsSent: vi.fn(async () => {}),
  listComments: vi.fn(async () => []),
  onCommentsChanged: vi.fn(() => () => {}),
}));
// A session with no listing is looked up on disk once; here it has no file.
vi.mock('../../db/reminders', async () => ({
  ...(await vi.importActual<typeof import('../../db/reminders')>('../../db/reminders')),
  transcriptPathFor: vi.fn(async () => null),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetDrafts();
  __resetSkills();
});

const SKILLS = [
  { name: 'brew-tea', description: 'Steep a pot of tea. Takes the kind of tea as an argument: green, black or oolong.' },
  { name: 'letter-review', description: 'Review a draft letter for tone.' },
  { name: 'garden:review-beds', description: 'Check the flower beds for weeds.' },
  { name: 'water-plants', description: 'Water the plants on the balcony.' },
];

function listSkills(sessionId = 'sess-1', skills = SKILLS) {
  recordSkillListings([{ sessionId, uuid: `${sessionId}-l`, ts: 1, initial: true, skills }]);
}

function renderBox(sessionId: string | null = 'sess-1') {
  return render(<Composer taskId={1} sessionId={sessionId} onSent={vi.fn()} />);
}

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const type = (value: string, caret = value.length) => {
  box().focus();
  fireEvent.change(box(), { target: { value } });
  box().setSelectionRange(caret, caret);
  fireEvent.select(box());
};
const key = (k: string, init: KeyboardEventInit & { isComposing?: boolean } = {}) =>
  fireEvent.keyDown(box(), { key: k, ...init });
const list = () => screen.queryByRole('listbox', { name: 'Skills' });
const options = () => within(list()!).getAllByRole('option');
const optionNames = () => options().map((o) => o.querySelector('.sk-name')?.textContent);
const strip = () => screen.queryByRole('note');

describe('opening the list', () => {
  it('opens on / at the start, listing the session’s skills, with a count', () => {
    listSkills();
    renderBox();
    type('/');
    expect(optionNames()).toEqual(['brew-tea', 'letter-review', 'garden:review-beds', 'water-plants']);
    expect(screen.getByText('4 of 4 skills')).toBeTruthy();
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    expect(box().getAttribute('aria-controls')).toBe(list()?.id);
  });

  it('opens after whitespace, not inside a word or a path', () => {
    listSkills();
    renderBox();
    type('see src/r');
    expect(list()).toBeNull();
    type('/Users/me/notes.txt');
    expect(list()).toBeNull();
    type('please /br');
    expect(optionNames()).toEqual(['brew-tea']);
  });

  it('filters in order, the plugin prefix not needed, and shows the first sentence with the whole description on hover', () => {
    listSkills();
    renderBox();
    type('/rev');
    // garden:review-beds starts with "rev" past its prefix; letter-review only holds it.
    expect(optionNames()).toEqual(['garden:review-beds', 'letter-review']);
    expect(screen.getByText('2 of 4 skills')).toBeTruthy();
    const brew = (type('/brew'), options()[0]!);
    expect(brew.querySelector('.sk-desc')?.textContent).toBe('Steep a pot of tea.');
    expect(brew.getAttribute('title')).toBe(SKILLS[0]!.description);
    // The prefix is drawn on its own, in the quieter tier.
    type('/garden');
    expect(options()[0]!.querySelector('.sk-prefix')?.textContent).toBe('garden:');
  });

  it('closes on a space before a pick, when nothing matches, and when the caret leaves the token', () => {
    listSkills();
    renderBox();
    type('/br ');
    expect(list()).toBeNull();
    type('/zzz');
    expect(list()).toBeNull();
    type('ask /br', 2);
    expect(list()).toBeNull();
  });

  it('says so when the session has listed no skills yet, and Return still sends', async () => {
    renderBox();
    type('/');
    expect(screen.getByText('No skills yet: the session lists them when it starts.')).toBeTruthy();
    expect(list()).toBeNull();
    type('/clear');
    key('Enter');
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, '/clear'));
  });

  it('follows a listing that arrives while it is open', () => {
    renderBox();
    type('/');
    act(() => listSkills());
    expect(optionNames()).toHaveLength(4);
  });
});

describe('the keys', () => {
  it('↓ then Return inserts /name and a space, and does not send', () => {
    listSkills();
    renderBox();
    type('/');
    key('ArrowDown');
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[1]?.id);
    key('Enter');
    expect(box().value).toBe('/letter-review ');
    expect(list()).toBeNull();
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('Tab inserts too; ↑ wraps to the last row', () => {
    listSkills();
    renderBox();
    type('/');
    key('ArrowUp');
    key('Tab');
    expect(box().value).toBe('/water-plants ');
  });

  it('replaces the whole token, and keeps what follows', () => {
    listSkills();
    renderBox();
    type('/bre and more', 3);
    key('Enter');
    expect(box().value).toBe('/brew-tea and more');
  });

  it('once closed, Return sends as usual', async () => {
    listSkills();
    renderBox();
    type('/');
    key('Enter');
    type('/brew-tea green');
    expect(list()).toBeNull();
    key('Enter');
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, '/brew-tea green'));
  });

  it('Esc closes this / for good, and does not send', () => {
    listSkills();
    renderBox();
    type('/br');
    key('Escape');
    expect(list()).toBeNull();
    type('/bre');
    expect(list()).toBeNull();
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('leaves keys an IME is composing, Shift+Tab and ⌘ combinations alone', () => {
    listSkills();
    renderBox();
    type('/');
    key('Enter', { isComposing: true });
    expect(box().value).toBe('/');
    key('Tab', { shiftKey: true });
    expect(box().value).toBe('/');
    key('ArrowDown', { metaKey: true });
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    expect(submitPty).not.toHaveBeenCalled();
  });

  it('a click on a row picks it', () => {
    listSkills();
    renderBox();
    type('/');
    fireEvent.click(options()[0]!);
    expect(box().value).toBe('/brew-tea ');
  });
});

describe('the strip', () => {
  it('shows the picked skill’s whole description while the message starts with it', () => {
    listSkills();
    renderBox();
    type('/br');
    key('Enter');
    expect(strip()?.getAttribute('aria-label')).toBe('About /brew-tea');
    expect(within(strip()!).getByText(SKILLS[0]!.description)).toBeTruthy();
    // Arguments typed after it keep it.
    type('/brew-tea green');
    expect(strip()).not.toBeNull();
  });

  it('is not there for a skill typed out without a pick', () => {
    listSkills();
    renderBox();
    type('/brew-tea green');
    expect(strip()).toBeNull();
  });

  it('goes when the command is deleted or edited into an unknown name, and stays gone', () => {
    listSkills();
    renderBox();
    type('/br');
    key('Enter');
    type('/brew-teaa ');
    expect(strip()).toBeNull();
    type('/brew-tea ');
    expect(strip()).toBeNull();
    type('/br');
    key('Enter');
    type('');
    expect(strip()).toBeNull();
  });

  it('✕ hides it for this message only', () => {
    listSkills();
    renderBox();
    type('/br');
    key('Enter');
    fireEvent.click(screen.getByRole('button', { name: 'Hide the description' }));
    expect(strip()).toBeNull();
    type('/brew-tea black');
    expect(strip()).toBeNull();
    // The next message: a new pick shows it again.
    type('');
    type('/wa');
    key('Enter');
    expect(strip()?.getAttribute('aria-label')).toBe('About /water-plants');
  });

  it('goes on send', async () => {
    listSkills();
    renderBox();
    type('/br');
    key('Enter');
    expect(strip()).not.toBeNull();
    key('Enter');
    await waitFor(() => expect(submitPty).toHaveBeenCalledWith(1, '/brew-tea '));
    await waitFor(() => expect(strip()).toBeNull());
  });

  it('is per session: another session’s skills are not offered', () => {
    listSkills('other', [{ name: 'someone-else', description: 'Not this one.' }]);
    listSkills();
    renderBox();
    type('/some');
    expect(list()).toBeNull();
  });
});
