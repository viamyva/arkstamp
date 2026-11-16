/**
 * DraggableTabBar
 *
 * Horizontal tab bar with drag-to-reorder.
 *
 * Strategy:
 *  - MOUSE: Pointer Events with setPointerCapture. Drag starts after 6 px movement.
 *  - TOUCH: Native Touch Events (touchstart/touchmove/touchend) attached to the
 *    scroll container with { passive: false } so we can call preventDefault() once
 *    a long-press drag is confirmed, stopping the browser's native scroll.
 *    Pointer Events are NOT used for touch because setPointerCapture fires
 *    pointercancel on movement, and omitting it means the browser scroll wins.
 */

import React, {
  useRef, useState, useEffect, useCallback, useMemo,
} from 'react';
import { Settings, Plus, Users, Pencil, Trash2 } from 'lucide-react';

export interface TabItem {
  id: string;
  label: string;
  isBuiltIn: boolean;
  template?: string;
  Icon?: React.ComponentType<{ className?: string }>;
}

interface DraggableTabBarProps {
  tabs: TabItem[];
  activeTab: string;
  onTabClick: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onManage: () => void;
  showManage: boolean;
  onAddTab: () => void;
  onSharedAccess: () => void;
  onRenameTab?: (id: string, newLabel: string) => void;
  onDeleteTab?: (id: string) => void;
}

const LONG_PRESS_MS = 500;
const TOUCH_CANCEL_PX = 8;   // horizontal movement before long-press is cancelled
const MOUSE_THRESHOLD_PX = 6;
const EDGE_ZONE = 60;
const SCROLL_SPEED = 6;

export function DraggableTabBar({
  tabs, activeTab, onTabClick, onReorder, onManage, showManage, onAddTab, onSharedAccess,
  onRenameTab, onDeleteTab,
}: DraggableTabBarProps) {

  // ── display order ──────────────────────────────────────────────────────────
  // 'shared' is always pinned last — exclude it from the draggable list
  const draggableTabs = tabs.filter(t => t.id !== 'shared');
  const sharedTab = tabs.find(t => t.id === 'shared');

  const [displayOrder, setDisplayOrder] = useState<string[]>(() => draggableTabs.map(t => t.id));
  const displayOrderRef = useRef<string[]>(displayOrder);

  const tabIdKey = draggableTabs.map(t => t.id).join(',');
  useEffect(() => {
    if (!isDraggingRef.current) setDisplayOrder(draggableTabs.map(t => t.id));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIdKey]);

  useEffect(() => { displayOrderRef.current = displayOrder; }, [displayOrder]);

  // ── drag state ─────────────────────────────────────────────────────────────
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [floatLeft, setFloatLeft] = useState(0);
  const [floatTop, setFloatTop] = useState(0);
  const [floatWidth, setFloatWidth] = useState(80);

  const draggingIdRef = useRef<string | null>(null);
  const isDraggingRef = useRef(false);
  const dragOffsetXRef = useRef(0);
  const midpointsRef = useRef<{ id: string; mid: number }[]>([]);
  const rafPendingRef = useRef(false);
  const lastClientXRef = useRef(0);

  // ── refs ───────────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);

  // ── quick menu (rename / delete) ───────────────────────────────────────────
  const [menuTabId, setMenuTabId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuTabId) return;
    const onOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuTabId(null);
        setMenuPos(null);
      }
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('touchstart', onOutside);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
    };
  }, [menuTabId]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const saveRename = useCallback((id: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) onRenameTab?.(id, trimmed);
    setRenamingId(null);
  }, [onRenameTab]);

  const handleDeleteTab = useCallback((id: string) => {
    setMenuTabId(null);
    setMenuPos(null);
    onDeleteTab?.(id);
  }, [onDeleteTab]);

  // Tap resolution: tapping the already-active tab opens the quick
  // rename/delete menu instead of re-selecting it. Built-in tabs only show
  // the delete option in that menu (see the menu render below).
  const handleTap = useCallback((id: string) => {
    const tab = tabs.find(t => t.id === id);
    if (id === activeTab && tab) {
      setMenuTabId(prev => {
        if (prev === id) {
          setMenuPos(null);
          return null;
        }
        const el = tabRefs.current.get(id);
        if (el) {
          const rect = el.getBoundingClientRect();
          setMenuPos({ left: rect.left + rect.width / 2, top: rect.bottom });
        }
        return id;
      });
      return;
    }
    setMenuTabId(null);
    setMenuPos(null);
    onTabClick(id);
  }, [activeTab, onTabClick, tabs]);

  // Touch-specific pending state
  const touchPendingRef = useRef<{
    id: string;
    el: HTMLButtonElement;
    identifier: number;
    startX: number;
    startY: number;
  } | null>(null);

  // Mouse-specific pending state
  const mousePendingRef = useRef<{
    id: string;
    el: HTMLButtonElement;
    startX: number;
    startY: number;
  } | null>(null);

  // ── auto-scroll ────────────────────────────────────────────────────────────
  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const startAutoScroll = useCallback((dir: 'left' | 'right') => {
    stopAutoScroll();
    const step = () => {
      if (!isDraggingRef.current) return;
      if (scrollRef.current) scrollRef.current.scrollLeft += dir === 'right' ? SCROLL_SPEED : -SCROLL_SPEED;
      autoScrollRafRef.current = requestAnimationFrame(step);
    };
    autoScrollRafRef.current = requestAnimationFrame(step);
  }, [stopAutoScroll]);

  // ── snapshot midpoints ─────────────────────────────────────────────────────
  const snapshotMidpoints = useCallback((draggingTabId: string) => {
    const container = scrollRef.current;
    if (!container) return;
    const containerLeft = container.getBoundingClientRect().left;
    const scrollLeft = container.scrollLeft;
    const snaps: { id: string; mid: number }[] = [];
    displayOrderRef.current.forEach(id => {
      if (id === draggingTabId) return;
      const el = tabRefs.current.get(id);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      snaps.push({ id, mid: rect.left - containerLeft + scrollLeft + rect.width / 2 });
    });
    midpointsRef.current = snaps;
  }, []);

  // ── begin drag ─────────────────────────────────────────────────────────────
  const beginDrag = useCallback((id: string, el: HTMLButtonElement, clientX: number) => {
    isDraggingRef.current = true;
    draggingIdRef.current = id;
    const rect = el.getBoundingClientRect();
    dragOffsetXRef.current = clientX - rect.left;
    setFloatLeft(rect.left);
    setFloatTop(rect.top);
    setFloatWidth(rect.width);
    setDraggingId(id);
    setMenuTabId(null);
    setMenuPos(null);
    setRenamingId(null);
    snapshotMidpoints(id);
    document.body.style.userSelect = 'none';
    (document.body.style as any).webkitUserSelect = 'none';
    if (navigator.vibrate) navigator.vibrate(25);
  }, [snapshotMidpoints]);

  // ── rAF-throttled order recompute ─────────────────────────────────────────
  const scheduleRecompute = useCallback((clientX: number) => {
    lastClientXRef.current = clientX;
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => {
      rafPendingRef.current = false;
      const id = draggingIdRef.current;
      if (!id || !isDraggingRef.current || !scrollRef.current) return;
      const containerLeft = scrollRef.current.getBoundingClientRect().left;
      const scrollLeft = scrollRef.current.scrollLeft;
      const pointerContentX = lastClientXRef.current - containerLeft + scrollLeft;
      const dragCenter = pointerContentX - dragOffsetXRef.current + floatWidth / 2;
      const snaps = midpointsRef.current;
      let insertIndex = snaps.length;
      for (let i = 0; i < snaps.length; i++) {
        if (dragCenter < snaps[i].mid) { insertIndex = i; break; }
      }
      const withoutDragged = displayOrderRef.current.filter(tid => tid !== id);
      const newOrder = [...withoutDragged];
      newOrder.splice(insertIndex, 0, id);
      if (newOrder.join(',') !== displayOrderRef.current.join(',')) setDisplayOrder(newOrder);
    });
  }, [floatWidth]);

  // ── end drag ───────────────────────────────────────────────────────────────
  const endDrag = useCallback((fireReorder = true) => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    touchPendingRef.current = null;
    mousePendingRef.current = null;
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    draggingIdRef.current = null;
    rafPendingRef.current = false;
    setDraggingId(null);
    stopAutoScroll();
    document.body.style.userSelect = '';
    (document.body.style as any).webkitUserSelect = '';
    if (fireReorder) {
      // Always append 'shared' at the end so it stays pinned last
      const orderedIds = [...displayOrderRef.current];
      const sharedId = tabs.find(t => t.id === 'shared')?.id;
      if (sharedId && !orderedIds.includes(sharedId)) orderedIds.push(sharedId);
      onReorder(orderedIds);
    }
  }, [stopAutoScroll, onReorder, tabs]);

  // ── TOUCH event handlers (attached imperatively for passive:false) ─────────
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      // Find which tab was touched
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      const btn = target?.closest('[data-tab-id]') as HTMLButtonElement | null;
      if (!btn) return;
      const id = btn.dataset.tabId;
      if (!id) return;

      touchPendingRef.current = {
        id,
        el: btn,
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
      };

      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        const p = touchPendingRef.current;
        if (p && p.id === id) {
          beginDrag(id, p.el, p.startX);
        }
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = Array.from(e.changedTouches).find(
        t => t.identifier === touchPendingRef.current?.identifier
      );
      if (!touch) return;

      if (!isDraggingRef.current) {
        // Pre-drag: cancel long-press on horizontal OR vertical movement
        const dx = Math.abs(touch.clientX - (touchPendingRef.current?.startX ?? 0));
        const dy = Math.abs(touch.clientY - (touchPendingRef.current?.startY ?? 0));
        if (longPressTimerRef.current && (dx > TOUCH_CANCEL_PX || dy > TOUCH_CANCEL_PX)) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
          touchPendingRef.current = null;
        }
        return;
      }

      // Drag is active — prevent page scroll and handle movement
      e.preventDefault();

      setFloatLeft(touch.clientX - dragOffsetXRef.current);

      const container2 = scrollRef.current;
      if (container2) {
        const rect = container2.getBoundingClientRect();
        const relX = touch.clientX - rect.left;
        if (relX < EDGE_ZONE) startAutoScroll('left');
        else if (relX > rect.width - EDGE_ZONE) startAutoScroll('right');
        else stopAutoScroll();
      }

      scheduleRecompute(touch.clientX);
    };

    const onTouchEnd = (e: TouchEvent) => {
      const touch = Array.from(e.changedTouches).find(
        t => t.identifier === touchPendingRef.current?.identifier
      );
      if (!touch) return;

      if (!isDraggingRef.current && touchPendingRef.current) {
        // Was a tap — fire click
        const { id } = touchPendingRef.current;
        if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
        touchPendingRef.current = null;
        handleTap(id);
        return;
      }

      endDrag(true);
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', () => endDrag(false), { passive: true });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    };
  }, [beginDrag, endDrag, scheduleRecompute, startAutoScroll, stopAutoScroll, handleTap]);

  // ── MOUSE pointer events ───────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const pending = mousePendingRef.current;

      if (pending && !isDraggingRef.current) {
        const dx = Math.abs(e.clientX - pending.startX);
        const dy = Math.abs(e.clientY - pending.startY);
        if (dx > MOUSE_THRESHOLD_PX || dy > MOUSE_THRESHOLD_PX) {
          mousePendingRef.current = null;
          beginDrag(pending.id, pending.el, e.clientX);
        }
        return;
      }

      if (!isDraggingRef.current) return;
      e.preventDefault();

      setFloatLeft(e.clientX - dragOffsetXRef.current);

      const container = scrollRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        if (relX < EDGE_ZONE) startAutoScroll('left');
        else if (relX > rect.width - EDGE_ZONE) startAutoScroll('right');
        else stopAutoScroll();
      }

      scheduleRecompute(e.clientX);
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (mousePendingRef.current && !isDraggingRef.current) {
        const { id } = mousePendingRef.current;
        mousePendingRef.current = null;
        handleTap(id);
        return;
      }
      endDrag(true);
    };

    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  }, [beginDrag, endDrag, scheduleRecompute, startAutoScroll, stopAutoScroll, handleTap]);

  // ── mouse pointerdown on a tab ─────────────────────────────────────────────
  const handleMouseDown = useCallback((
    e: React.PointerEvent<HTMLButtonElement>,
    id: string,
  ) => {
    if (e.button !== 0 || e.pointerType !== 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    mousePendingRef.current = {
      id,
      el: e.currentTarget,
      startX: e.clientX,
      startY: e.clientY,
    };
  }, []);

  // ── tab map ────────────────────────────────────────────────────────────────
  const tabById = useMemo(() => {
    const m = new Map<string, TabItem>();
    tabs.forEach(t => m.set(t.id, t));
    return m;
  }, [tabs]);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className="relative"
      style={{ WebkitUserSelect: 'none', userSelect: 'none' } as React.CSSProperties}
    >
      <div
        className="flex items-center overflow-x-auto"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        } as React.CSSProperties}
      >
        {/* + Add tab button — always pinned at left */}
        <button
          onClick={onAddTab}
          title="Add a tab"
          style={{ touchAction: 'manipulation' }}
          className="flex items-center justify-center px-3 py-3 mr-1 border-r border-slate-200 text-slate-400 hover:text-slate-700 transition-colors flex-shrink-0"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* Scrollable tab names with right-edge fade — gradient covers only this zone */}
        <div className="relative flex-1 min-w-0">
          <div
            ref={scrollRef}
            className="flex items-center overflow-x-auto"
            style={{
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
              WebkitUserSelect: 'none',
              userSelect: 'none',
              touchAction: isDraggingRef.current ? 'none' : 'pan-x',
            } as React.CSSProperties}
          >
            {displayOrder.map((id) => {
              const tab = tabById.get(id);
              if (!tab) return null;
              const { Icon } = tab;
              const isActive = activeTab === id;
              const isBeingDragged = draggingId === id;

              const isRenaming = renamingId === id;

              return (
                <div key={id} className="relative flex-shrink-0">
                  <button
                    data-tab-id={id}
                    ref={el => {
                      if (el) tabRefs.current.set(id, el);
                      else tabRefs.current.delete(id);
                    }}
                    onPointerDown={e => handleMouseDown(e, id)}
                    style={{
                      touchAction: 'pan-x',
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      opacity: isBeingDragged ? 0 : 1,
                      cursor: isDraggingRef.current ? 'grabbing' : 'grab',
                      transition: isBeingDragged ? 'none' : 'opacity 120ms',
                    } as React.CSSProperties}
                    className={`flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap ${
                      isActive && !draggingId
                        ? 'text-slate-900 border-b-2 border-slate-900'
                        : 'text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    {Icon && <Icon className="w-4 h-4" />}
                    {isRenaming ? (
                      <input
                        ref={renameInputRef}
                        defaultValue={tab.label}
                        onClick={e => e.stopPropagation()}
                        onPointerDown={e => e.stopPropagation()}
                        onBlur={e => saveRename(id, e.currentTarget.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        style={{ userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
                        className="bg-transparent border-0 border-b border-slate-400 focus:outline-none text-sm font-medium text-slate-900 w-24"
                      />
                    ) : (
                      <span>{tab.label}</span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          {/* Long fade gradient — only over the tab names, not the buttons */}
          <div
            className="pointer-events-none absolute inset-y-0 right-0 w-24"
            style={{ background: 'linear-gradient(to right, transparent, #faf7f2 80%)' }}
          />
        </div>

        {/* Shared Access icon button — outside the fade, always fully visible */}
        <button
          onClick={onSharedAccess}
          title="Shared Access"
          style={{ touchAction: 'manipulation' }}
          className="flex items-center justify-center px-3 py-3 border-l border-slate-200 text-slate-400 hover:text-slate-700 transition-colors flex-shrink-0 bg-[#faf7f2]"
        >
          <Users className="w-4 h-4" />
        </button>

        {/* Gear — outside the fade, always fully visible */}
        <button
          onClick={onManage}
          title="Manage tabs"
          style={{ touchAction: 'manipulation' }}
          className={`flex items-center justify-center px-3 py-3 border-l border-slate-200 transition-colors flex-shrink-0 bg-[#faf7f2] ${
            showManage ? 'text-slate-900' : 'text-slate-400 hover:text-slate-700'
          }`}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* Floating drag clone */}
      {draggingId && (() => {
        const tab = tabById.get(draggingId);
        if (!tab) return null;
        const { Icon } = tab;
        return (
          <div
            style={{
              position: 'fixed',
              top: floatTop,
              left: floatLeft,
              width: floatWidth,
              pointerEvents: 'none',
              zIndex: 9999,
              userSelect: 'none',
            }}
            className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-slate-900 bg-white shadow-2xl rounded-xl border border-slate-200 whitespace-nowrap"
          >
            {Icon && <Icon className="w-4 h-4" />}
            <span>{tab.label}</span>
          </div>
        );
      })()}

      {/* Quick menu — rename / delete — rendered fixed so it isn't clipped by the scrolling tab strip */}
      {menuTabId && menuPos && (() => {
        const tab = tabById.get(menuTabId);
        if (!tab) return null;
        return (
          <div
            ref={menuRef}
            style={{
              position: 'fixed',
              left: menuPos.left,
              top: menuPos.top,
              transform: 'translateX(-50%)',
              marginTop: 4,
              zIndex: 9999,
            }}
            className="flex items-center gap-0.5 bg-white rounded-xl shadow-lg border border-slate-100 p-1"
          >
            {!tab.isBuiltIn && (
              <button
                onClick={() => {
                  setMenuTabId(null);
                  setMenuPos(null);
                  setRenamingId(menuTabId);
                }}
                title="Rename"
                className="p-2 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <Pencil className="w-3.5 h-3.5 text-slate-500" />
              </button>
            )}
            <button
              onClick={() => handleDeleteTab(menuTabId)}
              title="Delete"
              className="p-2 rounded-lg hover:bg-red-50 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
            </button>
          </div>
        );
      })()}

    </div>
  );
}
