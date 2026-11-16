/**
 * useDeckGridDrag
 *
 * 2D counterpart to useDeckDrag, for reordering decks in the grid view.
 *
 * Strategy is the same as the list version, generalized to two axes:
 *  - Long-press on a ChapterCard fires `startDrag(id, startX, startY)`.
 *  - Pointer events track movement and compute the nearest target slot by
 *    2D distance to stable original-center snapshots (no feedback loop).
 *  - On pointer-up, the caller's `onReorder` callback receives the reordered array.
 *  - `getCardShift(index)` returns the {x,y} offset each non-dragged card should
 *    apply to visually "make room" for the dragged card. Because it's derived
 *    from each card's actual measured position (not an assumed column count),
 *    it naturally handles row wrapping at any grid width.
 *  - If the press ends without meaningful movement, `onLongPressWithoutMove`
 *    fires instead of a reorder -- used to open a context menu.
 */

import { useState, useRef, useCallback } from 'react';

interface DragItem {
  id: string;
}

interface UseDeckGridDragOptions<T extends DragItem> {
  /** The current ordered list of items. */
  items: T[];
  /** Called when the user drops a card in a new position. */
  onReorder: (reordered: T[]) => void;
  /** Ref to the grid container that holds `[data-chapter-id]` elements. */
  gridRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Called when a long-press fires (card lifts) but the pointer is released
   * without any real movement -- i.e. a "long press", not a drag. Used to
   * open a context menu (rename / delete / move to top) instead of reordering.
   */
  onLongPressWithoutMove?: (id: string) => void;
}

interface Point { x: number; y: number; }

interface UseDeckGridDragReturn {
  /** ID of the card currently being dragged, or null. */
  draggingId: string | null;
  /** Total X/Y translation (px) to apply to the dragged card. */
  dragDeltaX: number;
  dragDeltaY: number;
  /** Call this from ChapterCard's onLongPress callback. */
  startDrag: (id: string, startX: number, startY: number) => void;
  /**
   * Returns the {x,y} translation a card at `index` should apply while
   * another card is being dragged — shifts it into the gap's neighboring slot.
   */
  getCardShift: (index: number) => Point;
  /**
   * Set to true for ~300 ms after a drag ends to suppress the click event
   * that fires immediately after pointerup on desktop.
   */
  justDraggedRef: React.MutableRefObject<boolean>;
}

export function useDeckGridDrag<T extends DragItem>({
  items,
  onReorder,
  gridRef,
  onLongPressWithoutMove,
}: UseDeckGridDragOptions<T>): UseDeckGridDragReturn {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragDeltaX, setDragDeltaX] = useState(0);
  const [dragDeltaY, setDragDeltaY] = useState(0);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    startIndex: number;
    moved: boolean;
    originalCenters: Point[];
  } | null>(null);

  const dragOverIndexRef = useRef<number | null>(null);
  const justDraggedRef = useRef(false);

  const startDrag = useCallback((id: string, startX: number, startY: number) => {
    if (!gridRef.current) return;

    const cards = Array.from(gridRef.current.querySelectorAll<HTMLElement>('[data-chapter-id]'));
    const startIdx = cards.findIndex(c => c.getAttribute('data-chapter-id') === id);
    if (startIdx === -1) return;

    const originalCenters = cards.map(c => {
      const rect = c.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });

    dragRef.current = { id, startX, startY, startIndex: startIdx, moved: false, originalCenters };
    dragOverIndexRef.current = startIdx;

    setDraggingId(id);
    setDragDeltaX(0);
    setDragDeltaY(0);
    setDragOverIndex(startIdx);

    const handleMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragRef.current.moved = true;
      setDragDeltaX(dx);
      setDragDeltaY(dy);

      const { startIndex, originalCenters } = dragRef.current;
      const visualX = originalCenters[startIndex].x + dx;
      const visualY = originalCenters[startIndex].y + dy;

      let best = startIndex;
      let minDist = Infinity;
      for (let i = 0; i < originalCenters.length; i++) {
        const ddx = visualX - originalCenters[i].x;
        const ddy = visualY - originalCenters[i].y;
        const dist = ddx * ddx + ddy * ddy;
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
      setDragDeltaX(0);
      setDragDeltaY(0);
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
  }, [items, onReorder, gridRef, onLongPressWithoutMove]);

  const getCardShift = useCallback((index: number): Point => {
    if (!draggingId || dragOverIndex === null || !dragRef.current) return { x: 0, y: 0 };
    const { startIndex, originalCenters } = dragRef.current;
    const oi = dragOverIndex;
    if (oi === startIndex) return { x: 0, y: 0 };
    // Cards strictly between startIndex and the drop target each shift back
    // by exactly one flow slot -- computed from real measured positions, so
    // it's correct at row-wrap boundaries regardless of column count.
    if (oi > startIndex && index > startIndex && index <= oi) {
      const from = originalCenters[index];
      const to = originalCenters[index - 1];
      return { x: to.x - from.x, y: to.y - from.y };
    }
    if (oi < startIndex && index >= oi && index < startIndex) {
      const from = originalCenters[index];
      const to = originalCenters[index + 1];
      return { x: to.x - from.x, y: to.y - from.y };
    }
    return { x: 0, y: 0 };
  }, [draggingId, dragOverIndex]);

  return { draggingId, dragDeltaX, dragDeltaY, startDrag, getCardShift, justDraggedRef };
}
