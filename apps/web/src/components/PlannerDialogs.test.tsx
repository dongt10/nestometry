import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomManifest } from '../data/assetManifest';
import { createSceneDocumentFromRoom } from '../data/plannerDocument';
import { AddItemDialog } from './PlannerDialogs';
import { ResponsiveSheet } from './ResponsiveSheet';

afterEach(cleanup);

const room = roomManifest.find((candidate) => candidate.id === 'unit-3-standard-double')!;

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>open item dialog</button>
      {open ? (
        <AddItemDialog
          document={createSceneDocumentFromRoom(room.room)}
          nextId="custom_1"
          onAdd={vi.fn()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function SheetHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>open details</button>
      <ResponsiveSheet open={open} title="details" side="right" onClose={() => setOpen(false)}>
        <a href="https://example.com">source link</a>
      </ResponsiveSheet>
    </div>
  );
}

describe('AddItemDialog accessibility', () => {
  it('inerts the planner background, traps focus, and restores the trigger on close', () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole('button', { name: 'open item dialog' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'add an item' });
    expect(trigger).toHaveAttribute('aria-hidden', 'true');
    expect(trigger).toHaveProperty('inert', true);
    expect(screen.getByLabelText('preset')).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'add to plan' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'add an item' })).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('aria-hidden');
    expect((trigger as HTMLElement).inert).not.toBe(true);
    expect(trigger).toHaveFocus();
  });

  it('traps sheet focus, closes on escape, and restores the opener', () => {
    render(<SheetHarness />);
    const trigger = screen.getByRole('button', { name: 'open details' });
    trigger.focus();
    fireEvent.click(trigger);

    const sheet = screen.getByRole('dialog', { name: 'details' });
    expect(sheet.querySelector('[data-sheet-close]')).toHaveFocus();
    fireEvent.keyDown(window.document, { key: 'Escape' });

    expect(sheet).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
