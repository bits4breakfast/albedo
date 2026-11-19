/**
 * @vitest-environment jsdom
 *
 * Triggers in Projects… (#448): every event Off until turned on; Off / Draft
 * per event, and Suggest only where there is an action to suggest; Draft's
 * message; saved to the project's own file, not with the project form.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_TRIGGERS, setTriggerFiles, type TriggerFiles } from '../../triggers/settings';
import { TriggersField, TriggersSheet } from './TriggersSheet';

let files: Map<number, string>;
let prev: TriggerFiles;
beforeEach(() => {
  files = new Map();
  prev = setTriggerFiles({ read: async (id) => files.get(id) ?? null, write: async (id, json) => void files.set(id, json) });
});
afterEach(() => {
  cleanup();
  setTriggerFiles(prev);
});

const row = (label: string) => screen.getByRole('group', { name: label });
const pressed = (label: string) =>
  within(row(label))
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent);

describe('the sheet', () => {
  it('lists the events, all Off; only the approval can Suggest', async () => {
    render(<TriggersSheet projectId={3} projectName="shop" onClose={() => {}} />);
    expect(await screen.findByRole('dialog', { name: 'Triggers · shop' })).toBeTruthy();
    const events = [
      'Your PR is merged',
      'CI failed on your PR',
      'A reviewer requests changes or comments',
      'Your PR is approved and checks are green',
    ];
    for (const e of events) expect(pressed(e)).toEqual(['Off']);
    expect(within(row('Your PR is merged')).queryByRole('button', { name: 'Suggest' })).toBeNull();
    expect(within(row('Your PR is approved and checks are green')).getByRole('button', { name: 'Suggest' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('Draft shows its message, with what is added; Save writes the project’s file and closes', async () => {
    let closed = false;
    render(<TriggersSheet projectId={3} projectName="shop" onClose={() => (closed = true)} />);
    await screen.findByRole('dialog');
    fireEvent.click(within(row('Your PR is merged')).getByRole('button', { name: 'Draft' }));
    const box = screen.getByRole('textbox', { name: 'Your PR is merged: the message Albedo drafts' });
    expect(screen.getByText(/Added for you: PR number, title, merge commit\./)).toBeTruthy();
    fireEvent.change(box, { target: { value: '/after-merge — watch the deploy.' } });
    fireEvent.click(within(row('Your PR is approved and checks are green')).getByRole('button', { name: 'Suggest' }));
    expect(screen.getByText(/the same dialog as the task bar’s\. Never merges on its own\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    expect(JSON.parse(files.get(3)!)).toEqual({
      version: 1,
      ...DEFAULT_TRIGGERS,
      merged: { mode: 'draft', template: '/after-merge — watch the deploy.' },
      approved: { mode: 'suggest', template: '' },
    });
  });

  it('Cancel writes nothing', async () => {
    let closed = false;
    render(<TriggersSheet projectId={3} projectName="shop" onClose={() => (closed = true)} />);
    await screen.findByRole('dialog');
    fireEvent.click(within(row('CI failed on your PR')).getByRole('button', { name: 'Draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(closed).toBe(true);
    expect(files.size).toBe(0);
  });

  it('an unreadable file starts from Off and says so', async () => {
    files.set(4, 'not json');
    render(<TriggersSheet projectId={4} projectName="shop" onClose={() => {}} />);
    expect(await screen.findByText(/couldn’t be read, so every trigger is Off/)).toBeTruthy();
  });
});

describe('in Projects…', () => {
  it('says what is on, and Edit… opens the sheet', async () => {
    files.set(5, JSON.stringify({ merged: { mode: 'draft', template: 'x' }, approved: { mode: 'suggest' } }));
    render(<TriggersField projectId={5} projectName="shop" busy={false} />);
    expect(await screen.findByText('Merged: Draft · Approved: Suggest')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Triggers' }));
    expect(screen.getByRole('dialog', { name: 'Triggers · shop' })).toBeTruthy();
  });

  it('Off when nothing is saved; a project not saved yet cannot have them', async () => {
    render(<TriggersField projectId={6} projectName="shop" busy={false} />);
    expect(await screen.findByText('Off')).toBeTruthy();
    cleanup();
    render(<TriggersField projectId={null} projectName="shop" busy={false} />);
    expect((screen.getByRole('button', { name: 'Edit Triggers' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
