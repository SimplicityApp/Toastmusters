import { useEffect, useRef } from 'react';

/**
 * Close an open popover on Escape or on a press outside the elements it owns
 * (the button that opened it and the popover itself).
 *
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {Array<import('react').RefObject<HTMLElement>>} refs
 */
export function usePopover(open, onClose, refs) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!open) return undefined;
    const inside = (target) => refsRef.current.some((ref) => ref.current?.contains(target));
    const onPointer = (event) => {
      if (!inside(event.target)) onCloseRef.current();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
}

/**
 * Up / Down / Home / End between the items of an open menu or listbox.
 *
 * @param {KeyboardEvent} event
 * @param {HTMLElement|null} container
 * @param {string} selector - the focusable items, in order
 */
export function moveFocusWithArrows(event, container, selector) {
  if (!container || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...container.querySelectorAll(selector)].filter((el) => !el.disabled);
  if (items.length === 0) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement);
  let next;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
  else next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
  items[next].focus();
}
