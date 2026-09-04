'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

export type SheetSide = 'left' | 'right';

export function ResponsiveSheet({
  open,
  title,
  side,
  onClose,
  children,
  footer
}: {
  open: boolean;
  title: string;
  side: SheetSide;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
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
    const first = panel?.querySelector<HTMLElement>('[data-sheet-close]');
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) return;
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      const focusOutside = !panel.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === firstItem || focusOutside)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (document.activeElement === lastItem || focusOutside)) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      for (const previous of priorState) {
        previous.element.inert = previous.inert;
        if (previous.ariaHidden === null) previous.element.removeAttribute('aria-hidden');
        else previous.element.setAttribute('aria-hidden', previous.ariaHidden);
      }
      previousFocus?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div ref={layerRef} className="sheet-layer">
      <button
        type="button"
        className="sheet-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className={`responsive-sheet responsive-sheet--${side}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="sheet-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="icon-button sheet-close"
            data-sheet-close
            aria-label={`close ${title}`}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer ? <footer className="sheet-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
