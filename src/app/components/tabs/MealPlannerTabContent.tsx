/**
 * MealPlannerTabContent
 *
 * Tap a meal label to edit it inline.
 * Drag the grip handle to reorder within or between days.
 * Tap × to delete.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { Plus, X, GripVertical, Loader2, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';

interface Meal { id: string; dayKey: string; label: string; order: number; }

interface DragState {
  mealId: string;
  fromDayKey: string;
  ghostLabel: string;
  ghostX: number; ghostY: number;
  ghostW: number; ghostH: number;
  offsetX: number; offsetY: number;
  overDayKey: string;
  overIndex: number;
}

interface MealPlannerTabContentProps {
  chapterId: string; tabId: string; ownerUid?: string; refreshKey?: number;
}

function toISO(d: Date) { return d.toISOString().slice(0, 10); }

const DAY_STEP = 3; // how many days the nav arrows advance per tap

function buildDays(offset: number) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  return Array.from({ length: 8 }, (_, i) => {
    const d = new Date(today); d.setDate(today.getDate() + offset + i - 1);
    const key = toISO(d);
    const isPast = d.getTime() < today.getTime();
    const isToday = d.getTime() === today.getTime();
    const isTomorrow = d.getTime() === tomorrow.getTime();
    const long = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const short = isToday ? 'Today' : isTomorrow ? 'Tomorrow'
      : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return { key, label: long, shortLabel: short, isPast };
  });
}

function Spinner() {
  return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-slate-300 animate-spin" /></div>;
}

export function MealPlannerContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: MealPlannerTabContentProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [meals, setMeals] = useState<Meal[]>([]);
  const [loading, setLoading] = useState(true);
  const [drag, setDrag] = useState<DragState | null>(null);
  const mealsRef = useRef<Meal[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const [dayOffset, setDayOffset] = useState(0);
  const days = useMemo(() => buildDays(dayOffset), [dayOffset]);
  const goBack = () => setDayOffset(o => o - DAY_STEP);
  const goForward = () => setDayOffset(o => o + DAY_STEP);

  const colPath = useCallback(
    () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/meals`,
    [effectiveUid, chapterId, tabId],
  );

  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(query(collection(db, colPath()), orderBy('order', 'asc')), snap => {
      const loaded = snap.docs.map(d => ({ id: d.id, ...d.data() } as Meal));
      setMeals(loaded); mealsRef.current = loaded;
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey, colPath]);

  const handleAdd = async (dayKey: string, label: string) => {
    if (!user || !effectiveUid) return;
    const dayMeals = mealsRef.current.filter(m => m.dayKey === dayKey);
    const order = dayMeals.length > 0 ? Math.max(...dayMeals.map(m => m.order)) + 1 : 0;
    await addDoc(collection(db, colPath()), { dayKey, label, order, createdAt: serverTimestamp() });
  };

  const handleDelete = async (id: string) => {
    if (!user || !effectiveUid) return;
    await deleteDoc(fsDoc(db, colPath(), id));
  };

  const handleEdit = async (id: string, newLabel: string) => {
    if (!user || !effectiveUid || !newLabel.trim()) return;
    await updateDoc(fsDoc(db, colPath(), id), { label: newLabel.trim() });
  };

  const saveReorder = useCallback(async (updated: Meal[]) => {
    if (!user || !effectiveUid) return;
    const batch = writeBatch(db);
    updated.forEach(m => batch.update(fsDoc(db, colPath(), m.id), { order: m.order, dayKey: m.dayKey }));
    await batch.commit().catch(console.error);
  }, [user, effectiveUid, colPath]);

  const hitTest = useCallback((clientX: number, clientY: number) => {
    const ghost = document.getElementById('meal-drag-ghost');
    if (ghost) ghost.style.pointerEvents = 'none';
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (ghost) ghost.style.pointerEvents = '';
    if (!el) return null;
    const dayEl = el.closest('[data-day-key]') as HTMLElement | null;
    if (!dayEl) return null;
    const dayKey = dayEl.getAttribute('data-day-key')!;
    const listEl = dayEl.querySelector('[data-meal-list]') as HTMLElement | null;
    if (!listEl) return { dayKey, index: 0 };
    const rows = Array.from(listEl.querySelectorAll<HTMLElement>('[data-meal-id]'));
    let index = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) { index = i; break; }
    }
    return { dayKey, index };
  }, []);

  const startDrag = useCallback((
    e: React.PointerEvent<HTMLButtonElement>,
    mealId: string, fromDayKey: string, label: string,
  ) => {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);

    const rowEl = (e.currentTarget as HTMLElement).closest('[data-meal-id]') as HTMLElement | null;
    const rect = rowEl?.getBoundingClientRect() ?? { left: e.clientX, top: e.clientY, width: 180, height: 32 };

    const state: DragState = {
      mealId, fromDayKey, ghostLabel: label,
      ghostX: rect.left, ghostY: rect.top,
      ghostW: rect.width, ghostH: rect.height,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      overDayKey: fromDayKey,
      overIndex: mealsRef.current.filter(m => m.dayKey === fromDayKey).findIndex(m => m.id === mealId),
    };
    dragRef.current = state; setDrag(state);

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const newX = ev.clientX - dragRef.current.offsetX;
      const newY = ev.clientY - dragRef.current.offsetY;
      const hit = hitTest(ev.clientX, ev.clientY);
      const next: DragState = {
        ...dragRef.current, ghostX: newX, ghostY: newY,
        overDayKey: hit?.dayKey ?? dragRef.current.overDayKey,
        overIndex: hit?.index ?? dragRef.current.overIndex,
      };
      dragRef.current = next; setDrag(next);
    };

    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      const d = dragRef.current; dragRef.current = null; setDrag(null);
      if (!d) return;
      const { mealId: id, fromDayKey, overDayKey, overIndex } = d;
      setMeals(prev => {
        const byDay: Record<string, Meal[]> = {};
        for (const day of days) byDay[day.key] = [];
        prev.forEach(m => { if (byDay[m.dayKey]) byDay[m.dayKey].push(m); });
        for (const k of Object.keys(byDay)) byDay[k].sort((a, b) => a.order - b.order);
        const srcArr = byDay[fromDayKey];
        const srcIdx = srcArr.findIndex(m => m.id === id);
        if (srcIdx === -1) return prev;
        const [moved] = srcArr.splice(srcIdx, 1);
        moved.dayKey = overDayKey;
        const dstArr = byDay[overDayKey];
        dstArr.splice(Math.min(Math.max(overIndex, 0), dstArr.length), 0, moved);
        const updated: Meal[] = [];
        for (const k of Object.keys(byDay)) byDay[k].forEach((m, i) => updated.push({ ...m, order: i }));
        mealsRef.current = updated; saveReorder(updated); return updated;
      });
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  }, [days, hitTest, saveReorder]);

  if (loading) return <Spinner />;

  return (
    <div className="w-full relative">
      {/* Floating drag ghost */}
      {drag && (
        <div
          id="meal-drag-ghost"
          style={{
            position: 'fixed', left: drag.ghostX, top: drag.ghostY,
            width: drag.ghostW, height: drag.ghostH,
            zIndex: 9999, pointerEvents: 'none', opacity: 0.92,
          }}
          className="flex items-center gap-1.5 bg-white border border-slate-300 rounded-xl px-2 py-1.5 shadow-xl"
        >
          <GripVertical className="w-3 h-3 text-slate-400 flex-shrink-0" />
          <span className="text-xs text-slate-800 truncate">{drag.ghostLabel}</span>
        </div>
      )}

      {/* Desktop: horizontal grid with side nav arrows */}
      <div className="hidden md:flex items-stretch gap-2">
        <button
          onClick={goBack}
          aria-label="Show earlier days"
          className="flex-shrink-0 self-center flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 grid gap-2" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map(day => (
            <DayColumn key={day.key} day={day} useShortLabel
              meals={meals.filter(m => m.dayKey === day.key).sort((a, b) => a.order - b.order)}
              drag={drag} onGripPointerDown={startDrag}
              onDelete={handleDelete} onEdit={handleEdit} onAdd={handleAdd}
            />
          ))}
        </div>

        <button
          onClick={goForward}
          aria-label="Show later days"
          className="flex-shrink-0 self-center flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Mobile: vertical stack with top/bottom nav arrows */}
      <div className="md:hidden space-y-3">
        <button
          onClick={goBack}
          aria-label="Show earlier days"
          className="mx-auto flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors"
        >
          <ChevronUp className="w-4 h-4" />
        </button>

        {days.map(day => (
          <DayColumn key={day.key} day={day} useShortLabel={false}
            meals={meals.filter(m => m.dayKey === day.key).sort((a, b) => a.order - b.order)}
            drag={drag} onGripPointerDown={startDrag}
            onDelete={handleDelete} onEdit={handleEdit} onAdd={handleAdd}
          />
        ))}

        <button
          onClick={goForward}
          aria-label="Show later days"
          className="mx-auto flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 text-slate-400 hover:text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Day column ───────────────────────────────────────────────────────────────

interface DayColumnProps {
  day: { key: string; label: string; shortLabel: string; isPast: boolean };
  meals: Meal[];
  drag: DragState | null;
  onGripPointerDown: (e: React.PointerEvent<HTMLButtonElement>, mealId: string, dayKey: string, label: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newLabel: string) => void;
  onAdd: (dayKey: string, label: string) => void;
  useShortLabel: boolean;
}

function DayColumn({ day, meals, drag, onGripPointerDown, onDelete, onEdit, onAdd, useShortLabel }: DayColumnProps) {
  const [inputValue, setInputValue] = useState('');
  const [showInput, setShowInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

  const isDropTarget = drag !== null && drag.overDayKey === day.key;

  const submitAdd = () => {
    const v = inputValue.trim();
    if (v) onAdd(day.key, v);
    setInputValue(''); setShowInput(false);
  };

  const startEdit = (meal: Meal) => {
    setEditingId(meal.id);
    setEditValue(meal.label);
    setTimeout(() => { editRef.current?.focus(); editRef.current?.select(); }, 30);
  };

  const commitEdit = (id: string) => {
    const v = editValue.trim();
    if (v) onEdit(id, v);
    setEditingId(null); setEditValue('');
  };

  return (
    <div
      data-day-key={day.key}
      className={`flex flex-col rounded-2xl border transition-colors
        ${day.isPast ? 'border-slate-100 bg-slate-50/60 opacity-60' : 'border-slate-200 bg-white'}
        ${isDropTarget ? 'border-slate-400 ring-1 ring-slate-300 bg-slate-50' : ''}
      `}
    >
      {/* Header */}
      <div className="px-3 pt-2.5 pb-1.5 border-b border-slate-100">
        <p className={`text-[11px] font-semibold uppercase tracking-wider leading-none ${day.isPast ? 'text-slate-400' : 'text-slate-500'}`}>
          {useShortLabel ? day.shortLabel : day.label}
        </p>
      </div>

      {/* Meal list */}
      <div data-meal-list className="flex-1 px-1.5 pt-1.5 pb-1 space-y-0.5 min-h-[48px]">
        {meals.map(meal => {
          const isDragging = drag?.mealId === meal.id;
          const isEditing = editingId === meal.id;
          return (
            <div
              key={meal.id}
              data-meal-id={meal.id}
              className={`flex items-center gap-1.5 group rounded-xl px-2 py-1.5 select-none transition-opacity
                ${isDragging ? 'opacity-0' : isEditing ? 'bg-slate-50' : 'bg-white hover:bg-slate-50'}
              `}
            >
              {isEditing ? (
                /* ── Inline edit mode ── */
                <input
                  ref={editRef}
                  value={editValue}
                  autoFocus
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitEdit(meal.id);
                    if (e.key === 'Escape') { setEditingId(null); setEditValue(''); }
                  }}
                  onBlur={() => commitEdit(meal.id)}
                  onPointerDown={e => e.stopPropagation()}
                  className="w-full text-sm px-2 py-1 rounded-lg border border-slate-300 focus:outline-none focus:border-slate-500 bg-white"
                  style={{ fontSize: '16px', minWidth: 0 }}
                />
              ) : (
                <>
                  {/* Grip */}
                  <button
                    className="touch-none cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 transition-colors flex-shrink-0 p-0.5"
                    onPointerDown={e => onGripPointerDown(e, meal.id, day.key, meal.label)}
                  >
                    <GripVertical className="w-3 h-3" />
                  </button>

                  {/* Label — tap to edit */}
                  <span
                    className="flex-1 text-xs text-slate-800 leading-snug break-words min-w-0 cursor-text"
                    onClick={() => startEdit(meal)}
                  >
                    {meal.label}
                  </span>

                  {/* Delete */}
                  <button
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => onDelete(meal.id)}
                    className="flex-shrink-0 p-0.5 rounded hover:bg-red-50 text-slate-300 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          );
        })}
        {meals.length === 0 && !showInput && (
          <p className="text-[10px] text-slate-300 px-2 py-1">Empty</p>
        )}
      </div>

      {/* Add input */}
      <div className="px-2 pb-2 pt-0.5">
        {showInput ? (
          <input
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') { setShowInput(false); setInputValue(''); } }}
            onBlur={submitAdd}
            placeholder="Add meal…"
            autoFocus
            className="w-full text-xs px-2 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:border-slate-400 bg-white placeholder-slate-300"
            style={{ fontSize: '16px' }}
          />
        ) : (
          <button
            onClick={() => { setShowInput(true); setTimeout(() => inputRef.current?.focus(), 30); }}
            className={`w-full flex items-center justify-center gap-1 py-1 rounded-lg text-[11px] font-medium transition-colors
              ${day.isPast ? 'text-slate-300 hover:text-slate-400 hover:bg-slate-100' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <Plus className="w-3 h-3" /><span>Add</span>
          </button>
        )}
      </div>
    </div>
  );
}
