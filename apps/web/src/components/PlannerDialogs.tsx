'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  CUSTOM_BLOCK_PRESETS,
  createCustomBlock,
  type CustomBlock,
  type CustomBlockPresetId,
  type SceneDocument
} from '../data/plannerDocument';

export function AddItemDialog({
  document,
  nextId,
  onAdd,
  onClose
}: {
  document: SceneDocument;
  nextId: string;
  onAdd: (block: CustomBlock) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [preset, setPreset] = useState<CustomBlockPresetId | 'custom'>('storage-bin');
  const initial = CUSTOM_BLOCK_PRESETS['storage-bin'];
  const [label, setLabel] = useState(initial.label);
  const [width, setWidth] = useState(initial.dimensions_m.width);
  const [depth, setDepth] = useState(initial.dimensions_m.depth);
  const [height, setHeight] = useState(initial.dimensions_m.height);

  useEffect(() => {
    returnFocusRef.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    const layer = layerRef.current;
    const siblings = layer?.parentElement
      ? [...layer.parentElement.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer)
      : [];
    const priorState = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden')
    }));
    for (const sibling of siblings) {
      sibling.inert = true;
      sibling.setAttribute('aria-hidden', 'true');
    }
    const first = dialogRef.current?.querySelector<HTMLElement>('select, input, button');
    first?.focus();
    return () => {
      for (const previous of priorState) {
        previous.element.inert = previous.inert;
        if (previous.ariaHidden === null) previous.element.removeAttribute('aria-hidden');
        else previous.element.setAttribute('aria-hidden', previous.ariaHidden);
      }
      returnFocusRef.current?.focus();
    };
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('select, input, button:not([disabled])') ?? [])];
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls.at(-1) ?? first;
    const focusOutside = !dialogRef.current?.contains(window.document.activeElement);
    if (event.shiftKey && (window.document.activeElement === first || focusOutside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (window.document.activeElement === last || focusOutside)) {
      event.preventDefault();
      first.focus();
    }
  };

  const applyPreset = (next: CustomBlockPresetId | 'custom') => {
    setPreset(next);
    if (next === 'custom') return;
    const value = CUSTOM_BLOCK_PRESETS[next];
    setLabel(value.label);
    setWidth(value.dimensions_m.width);
    setDepth(value.dimensions_m.depth);
    setHeight(value.dimensions_m.height);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const block = createCustomBlock(nextId, {
      label,
      dimensions_m: { width, depth, height },
      position_m: { x: 0, y: 0, z: 0 }
    });
    onAdd(block);
  };

  return (
    <div ref={layerRef} className="planner-dialog-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form ref={dialogRef} className="planner-dialog" role="dialog" aria-modal="true" aria-labelledby="add-item-title" onKeyDown={trapFocus} onSubmit={submit}>
        <h2 id="add-item-title">add an item</h2>
        <div className="form-grid">
          <label className="form-field form-field--wide">
            preset
            <select value={preset} onChange={(event) => applyPreset(event.target.value as CustomBlockPresetId | 'custom')}>
              <option value="storage-bin">storage bin</option>
              <option value="mini-fridge">mini fridge</option>
              <option value="bookcase">bookcase</option>
              <option value="table">table</option>
              <option value="custom">custom dimensions</option>
            </select>
          </label>
          <label className="form-field form-field--wide">
            label
            <input value={label} maxLength={80} required onChange={(event) => setLabel(event.target.value.toLocaleLowerCase('en-US'))} />
          </label>
          <label className="form-field">
            width (m)
            <input type="number" min="0.025" max="10" step="0.005" value={width} onChange={(event) => setWidth(event.currentTarget.valueAsNumber)} required />
          </label>
          <label className="form-field">
            depth (m)
            <input type="number" min="0.025" max="10" step="0.005" value={depth} onChange={(event) => setDepth(event.currentTarget.valueAsNumber)} required />
          </label>
          <label className="form-field">
            height (m)
            <input type="number" min="0.025" max="10" step="0.005" value={height} onChange={(event) => setHeight(event.currentTarget.valueAsNumber)} required />
          </label>
        </div>
        <p className="field-help">personal items are neutral dimension blocks, not exact product models. {document.layout.custom_blocks.length}/20 added.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>cancel</button>
          <button type="submit" className="primary-button">add to plan</button>
        </div>
      </form>
    </div>
  );
}

export function SharePanel({
  shareUrl,
  message,
  onCopy
}: {
  shareUrl: string | null;
  message: string | null;
  onCopy: () => void;
}) {
  return (
    <div className="share-panel">
      <p>create an editable link containing this room, arrangement, personal items, view, layers, and units.</p>
      <p className="field-help">the plan stays in the url fragment and is not sent to nestometry servers.</p>
      <p className="field-help">anyone with the link can read and edit its layout and custom item labels. browsers, synced history, clipboards, and messaging apps may retain the url.</p>
      {shareUrl ? <label className="form-field"><span>share link</span><input readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} /></label> : null}
      <button type="button" className="primary-button" onClick={onCopy}>copy share link</button>
      {message ? <p className="share-message" role="status">{message}</p> : null}
    </div>
  );
}
