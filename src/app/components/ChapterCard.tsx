import React, { useState, useEffect, useRef } from 'react';
import { Pencil, Trash2 } from 'lucide-react';

interface Chapter {
  id: string;
  title: string;
  icon: string;
  updatedAt: string | null;
  sharedOwnerUid?: string;
}

interface ChapterCardProps {
  chapter: Chapter;
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onLongPress?: (clientX: number, clientY: number) => void;
  isDragging?: boolean;
  playHint?: boolean;
  isGrid?: boolean;
}

const REVEAL_WIDTH = 120;
const REVEAL_THRESHOLD = 50;

function formatRelativeDate(isoString: string | null): string {
  if (!isoString) return 'Unknown';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return 'Unknown';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export function ChapterCard({
  chapter, onClick, onEdit, onDelete,
  onLongPress, isDragging = false, playHint = false, isGrid = false,
}: ChapterCardProps) {
  const [revealed, setRevealed] = useState(false);
  const [swipeDelta, setSwipeDelta] = useState(0);
  const [useSwipeTransition, setUseSwipeTransition] = useState(false);

  // Hint animation phases: 0=idle  1=sliding out  2=sliding back
  const [hintPhase, setHintPhase] = useState<0 | 1 | 2>(0);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const revealedRef = useRef(false);
  const isDraggingRef = useRef(isDragging);
  const swipeRef = useRef<{
    startX: number; startY: number; deltaX: number;
    direction: 'horizontal' | 'vertical' | null;
  } | null>(null);

  // Keep isDraggingRef in sync
  useEffect(() => { isDraggingRef.current = isDragging; }, [isDragging]);

  const setRevealedState = (v: boolean) => {
    revealedRef.current = v;
    setRevealed(v);
  };

  // ---- SWIPE TO REVEAL ----
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const onTS = (e: TouchEvent) => {
      if (isDraggingRef.current) return;
      if (revealedRef.current) {
        const touchedActions = (e.target as Element).closest('[data-deck-actions]');
        if (!touchedActions) setRevealedState(false);
        return;
      }
      if ((e.target as Element).closest('button')) return;
      const t = e.touches[0];
      swipeRef.current = { startX: t.clientX, startY: t.clientY, deltaX: 0, direction: null };
    };

    const onTM = (e: TouchEvent) => {
      if (isDraggingRef.current) return;
      const g = swipeRef.current;
      if (!g) return;
      const dx = e.touches[0].clientX - g.startX;
      const dy = e.touches[0].clientY - g.startY;
      if (g.direction === null) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        g.direction = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      }
      if (g.direction === 'vertical' || dx > 0) { swipeRef.current = null; return; }
      e.preventDefault();
      g.deltaX = Math.max(dx, -(REVEAL_WIDTH + 20));
      setUseSwipeTransition(false);
      setSwipeDelta(g.deltaX);
    };

    const onTE = () => {
      if (isDraggingRef.current) return;
      const g = swipeRef.current;
      swipeRef.current = null;
      setUseSwipeTransition(true);
      setSwipeDelta(0);
      if (!g || g.direction !== 'horizontal') return;
      if (g.deltaX < -REVEAL_THRESHOLD) setRevealedState(true);
    };

    el.addEventListener('touchstart', onTS, { passive: true });
    el.addEventListener('touchmove', onTM, { passive: false });
    el.addEventListener('touchend', onTE);
    return () => {
      el.removeEventListener('touchstart', onTS);
      el.removeEventListener('touchmove', onTM);
      el.removeEventListener('touchend', onTE);
    };
  }, []);

  // ---- LONG PRESS DETECTION ----
  useEffect(() => {
    if (!onLongPress) return;
    const el = wrapperRef.current;
    if (!el) return;

    const timerRef = { current: null as ReturnType<typeof setTimeout> | null };
    const pressRef = { startX: 0, startY: 0, active: false };

    const onPD = (e: PointerEvent) => {
      if ((e.target as Element).closest('button')) return;
      if (isDraggingRef.current) return;
      pressRef.startX = e.clientX;
      pressRef.startY = e.clientY;
      pressRef.active = true;
      timerRef.current = setTimeout(() => {
        if (pressRef.active) {
          onLongPress(pressRef.startX, pressRef.startY);
        }
      }, 200);
    };

    const onPM = (e: PointerEvent) => {
      if (!pressRef.active || !timerRef.current) return;
      const dx = e.clientX - pressRef.startX;
      const dy = e.clientY - pressRef.startY;
      if (Math.sqrt(dx * dx + dy * dy) > 8) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        pressRef.active = false;
      }
    };

    const onPU = () => {
      pressRef.active = false;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };

    el.addEventListener('pointerdown', onPD);
    el.addEventListener('pointermove', onPM);
    el.addEventListener('pointerup', onPU);
    el.addEventListener('pointercancel', onPU);

    return () => {
      el.removeEventListener('pointerdown', onPD);
      el.removeEventListener('pointermove', onPM);
      el.removeEventListener('pointerup', onPU);
      el.removeEventListener('pointercancel', onPU);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onLongPress]);

  // ---- HINT ANIMATION ----
  useEffect(() => {
    if (!playHint) return;
    // Small settling delay, then slide out, hold, slide back
    const t1 = setTimeout(() => setHintPhase(1), 80);
    const t2 = setTimeout(() => setHintPhase(2), 820);
    const t3 = setTimeout(() => setHintPhase(0), 1220);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [playHint]);

  // Reset reveal when dragging starts
  useEffect(() => {
    if (isDragging) {
      setRevealedState(false);
      setSwipeDelta(0);
    }
  }, [isDragging]);

  // ---- STYLE COMPUTATION ----
  let swipeTranslateX = revealed ? -REVEAL_WIDTH : swipeDelta;
  let swipeTransition = revealed || (useSwipeTransition && swipeDelta === 0)
    ? 'transform 0.22s ease-out'
    : 'none';

  // Hint overrides swipe
  if (hintPhase === 1) {
    swipeTranslateX = -86;
    swipeTransition = 'transform 0.38s cubic-bezier(0.34, 1.1, 0.64, 1)';
  } else if (hintPhase === 2) {
    swipeTranslateX = 0;
    swipeTransition = 'transform 0.32s cubic-bezier(0.34, 1.3, 0.64, 1)';
  }

  // When dragging: outer wrapper (in ArkLibrary) handles translateY.
  // The face only needs the lifted appearance (scale + shadow).
  const faceStyle: React.CSSProperties = isDragging
    ? {
        transform: 'scale(1.025)',
        transition: 'transform 160ms ease, box-shadow 160ms ease',
        boxShadow: '0 20px 48px rgba(0,0,0,0.13), 0 6px 16px rgba(0,0,0,0.07)',
      }
    : {
        transform: `translateX(${swipeTranslateX}px)`,
        transition: swipeTransition,
      };

  const formattedDate = formatRelativeDate(chapter.updatedAt);

  return (
    <div
      ref={wrapperRef}
      className="relative rounded-2xl group"
      style={isDragging ? { zIndex: 50, position: 'relative' } : {}}
    >
      {/* Action buttons (own decks only) */}
      {!isDragging && (onEdit || onDelete) && (
        <div
          data-deck-actions="true"
          className="absolute inset-y-0 right-0 flex rounded-r-2xl overflow-hidden"
          style={{ width: onEdit && onDelete ? REVEAL_WIDTH : REVEAL_WIDTH / 2 }}
        >
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); setRevealedState(false); onEdit(); }}
              className="flex-1 bg-slate-700 flex items-center justify-center active:bg-slate-600 transition-colors"
              aria-label="Rename deck"
            >
              <Pencil className="w-5 h-5 text-white" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); setRevealedState(false); onDelete(); }}
              className="flex-1 bg-red-500 flex items-center justify-center active:bg-red-600 transition-colors rounded-r-2xl"
              aria-label="Delete deck"
            >
              <Trash2 className="w-5 h-5 text-white" />
            </button>
          )}
        </div>
      )}

      {/* Card face */}
      <div
        onClick={() => {
          if (isDragging) return;
          if (!revealed) onClick();
          else setRevealedState(false);
        }}
        className={`relative bg-white rounded-2xl shadow-md cursor-pointer ${
          chapter.sharedOwnerUid ? 'ring-2 ring-[#6b3a2a]' : ''
        }`}
        style={faceStyle}
      >
        {isGrid ? (
          /* ── GRID TILE ── */
          <div className="px-4 pt-4 pb-3 flex flex-col min-h-[130px]">
            <div className="flex items-start justify-between mb-2">
              <span className="text-3xl leading-none">{chapter.icon}</span>
              {!isDragging && (onEdit || onDelete) && (
                <div className="hidden md:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {onEdit && <button
                    onClick={e => { e.stopPropagation(); onEdit(); }}
                    className="p-1 hover:bg-slate-100 rounded-lg transition-colors"
                  ><Pencil className="w-3.5 h-3.5 text-slate-400" /></button>}
                  {onDelete && <button
                    onClick={e => { e.stopPropagation(); onDelete(); }}
                    className="p-1 hover:bg-red-50 rounded-lg transition-colors"
                  ><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>}
                </div>
              )}
            </div>
            <div className="mt-auto">
              <p className="text-sm font-bold text-slate-900 leading-snug line-clamp-2">{chapter.title}</p>
              {chapter.sharedOwnerUid
                ? <p className="text-xs mt-1 font-medium" style={{ color: '#6b3a2a' }}>Shared with you</p>
                : <p className="text-xs text-slate-400 mt-1 truncate">{formattedDate}</p>
              }
            </div>
          </div>
        ) : (
          /* ── LIST CARD ── */
          <div className="px-5 py-4">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0 pr-2">
                <h3 className="text-[17px] font-bold text-slate-900 leading-snug truncate">
                  {chapter.icon} {chapter.title}
                </h3>
                {chapter.sharedOwnerUid
                  ? <p className="text-xs font-semibold uppercase tracking-wide mt-1" style={{ color: '#6b3a2a' }}>Shared with you</p>
                  : <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mt-1">Updated: {formattedDate}</p>
                }
              </div>
              {!isDragging && (onEdit || onDelete) && (
                <div className="hidden md:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  {onEdit && <button
                    onClick={e => { e.stopPropagation(); onEdit(); }}
                    className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors"
                    title="Rename deck"
                  ><Pencil className="w-4 h-4 text-slate-400" /></button>}
                  {onDelete && <button
                    onClick={e => { e.stopPropagation(); onDelete(); }}
                    className="p-1.5 hover:bg-red-50 rounded-lg transition-colors"
                    title="Delete deck"
                  ><Trash2 className="w-4 h-4 text-red-400" /></button>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
