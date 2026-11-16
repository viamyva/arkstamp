/**
 * useDeckDrag
 *
 * Encapsulates the vertical drag-to-reorder logic for the deck list in ArkLibrary.
 *
 * Strategy:
 *  - Long-press on a ChapterCard fires `startDrag(id, startY)`.
 *  - Pointer events track movement and compute the target slot index using
 *    stable original-center snapshots (no feedback loop).
 *  - On pointer-up, the caller's `onReorder` callback receives the reordered array.
 *  - `getCardShift(index)` returns the translateY offset each non-dragged card
 *    should apply to visually "make room" for the dragged card.
 */

import { useState, useRef, useCallback } from 'react';

interface DragItem {
  id: string;
}

interface UseDeckDragOptions<T extends DragItem> {
  /** The current ordered list of items. */
  items: T[];
  /** Called when the user drops a card in a new position. */
  onReorder: (reordered: T[]) => void;
  /** Ref to the scrollable container that holds `[data-chapter-id]` elements. */
  listRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Called when a long-press fires (card lifts) but the pointer is released
   * without any real movement -- i.e. a "long press", not a drag. Used to
   * open a context menu (rename / delete / move to top) instead of reordering.
   */
  onLongPressWithoutMove?: (id: string) => void;
}

interface UseDeckDragReturn {
  /** ID of the card currently being dragged, or null. */
  draggingId: string | null;
  /** Total Y translation (px) to apply to the dragged card. */
  dragDelta: number;
  /** Call this from ChapterCard's onLongPress callback. */
  startDrag: (id: string, startY: number) => void;
  /**
   * Returns the translateY (px) a card at `index` should apply while
   * another card is being dragged — shifts adjacent cards to show the gap.
   */
  getCardShift: (index: number) => number;
  /**
   * Set to true for ~300 ms after a drag ends to suppress the click event
   * that fires immediately after pointerup on desktop.
   */
  justDraggedRef: React.MutableRefObject<boolean>;
}

export function useDeckDrag<T extends DragItem>({
  items,
  onReorder,
  listRef,
  onLongPressWithoutMove,
}: UseDeckDragOptions<T>): UseDeckDragReturn {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragDelta, setDragDelta] = useState(0);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const dragRef = useRef<{
    id: string;
    startY: number;
    startIndex: number;
    rowSpan: number;
    originalCenters: number[];
    moved: boolean;
  } | null>(null);

  const dragOverIndexRef = useRef<number | null>(null);
  const justDraggedRef = useRef(false);

  const startDrag = useCallback((id: string, startY: number) => {
    if (!listRef.current) return;

    const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-chapter-id]'));
    const startIdx = rows.findIndex(r => r.getAttribute('data-chapter-id') === id);
    if (startIdx === -1) return;

    const rowEl = rows[startIdx];
    const rowSpan = rowEl.getBoundingClientRect().height + 12; // card height + gap-3
    const originalCenters = rows.map(r => {
      const rect = r.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });

    dragRef.current = { id, startY, startIndex: startIdx, rowSpan, originalCenters, moved: false };
    dragOverIndexRef.current = startIdx;

    setDraggingId(id);
    setDragDelta(0);
    setDragOverIndex(startIdx);

    const handleMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientY - dragRef.current.startY;
      if (Math.abs(delta) > 4) dragRef.current.moved = true;
      setDragDelta(delta);

      const { startIndex, originalCenters } = dragRef.current;
      const visualCenterY = originalCenters[startIndex] + delta;

      let best = startIndex;
      let minDist = Infinity;
      for (let i = 0; i < originalCenters.length; i++) {
        const dist = Math.abs(visualCenterY - originalCenters[i]);
        if (dist < minDist) { minDist = dist; best = i; }
      }

      setDragOverIndex(best);
      dragOverIndexRef.current = best;
    };

    const blockScroll = (e: TouchEvent) => { e.preventDefault(); };

    const handleEnd = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleEnd);
      document.removeEventListener('pointercancel', handleEnd);
      document.removeEventListener('touchmove', blockScroll);

      const targetIdx = dragOverIndexRef.current;
      const si = dragRef.current?.startIndex ?? -1;
      const currentId = dragRef.current?.id;
      const moved = dragRef.current?.moved ?? false;

      dragRef.current = null;
      dragOverIndexRef.current = null;
      setDragDelta(0);
      setDraggingId(null);
      setDragOverIndex(null);

      // Suppress the click that fires immediately after pointerup on desktop
      justDraggedRef.current = true;
      setTimeout(() => { justDraggedRef.current = false; }, 300);

      if (!moved && currentId) {
        onLongPressWithoutMove?.(currentId);
        return;
      }

      if (targetIdx !== null && si !== -1 && targetIdx !== si && currentId) {
        const next = [...items];
        const [movedItem] = next.splice(si, 1);
        next.splice(targetIdx, 0, movedItem);
        onReorder(next);
      }
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleEnd);
    document.addEventListener('pointercancel', handleEnd);
    document.addEventListener('touchmove', blockScroll, { passive: false } as AddEventListenerOptions);
  }, [items, onReorder, listRef, onLongPressWithoutMove]);

  const getCardShift = useCallback((index: number): number => {
    if (!draggingId || dragOverIndex === null || !dragRef.current) return 0;
    const { startIndex, rowSpan } = dragRef.current;
    const oi = dragOverIndex;
    if (oi === startIndex) return 0;
    if (oi > startIndex && index > startIndex && index <= oi) return -rowSpan;
    if (oi < startIndex && index >= oi && index < startIndex) return rowSpan;
    return 0;
  }, [draggingId, dragOverIndex]);

  return { draggingId, dragDelta, startDrag, getCardShift, justDraggedRef };
}
