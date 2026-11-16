import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db, storage, functions } from '../../../lib/firebase';
import { getSavedMapCenter } from '../UserAvatar';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  getDocs, getDoc, query, orderBy, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import {
  Plus, Trash2, Loader2, FileText, ImageIcon, File,
  Download, X, Sparkles, ChevronDown, MapPin,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocItem { id: string; fileName: string; fileUrl: string; fileType: string; uploadedAt: string; }

interface ItineraryTabContentProps {
  chapterId: string;
  tabId: string;
  ownerUid?: string;
  refreshKey?: number;
}

const VALID_SEGMENT_CATS = ['flight', 'hotel', 'car', 'activity', 'transfer', 'note'] as const;
type SegmentCategory = typeof VALID_SEGMENT_CATS[number];

interface ItinerarySegment {
  id: string; title: string; category: SegmentCategory; details: string[]; order: number;
  date?: string; time?: string; lat?: number; lng?: number; address?: string;
  pinColor?: string; pinEmoji?: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CAT_DOT: Record<SegmentCategory, string> = {
  flight:   '#4f46e5',
  hotel:    '#0f766e',
  car:      '#64748b',
  activity: '#be185d',
  transfer: '#0f172a',
  note:     '#94a3b8',
};

const PIN_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#14b8a6','#3b82f6','#8b5cf6','#ec4899',
  '#64748b','#0f172a',
];

const PIN_EMOJI_OPTIONS: { emoji: string; bg: string }[] = [
  { emoji: '⭐', bg: '#f59e0b' },
  { emoji: '❤️', bg: '#ef4444' },
  { emoji: '🏠', bg: '#6366f1' },
  { emoji: '🍴', bg: '#16a34a' },
  { emoji: '☕', bg: '#92400e' },
  { emoji: '🚩', bg: '#dc2626' },
  { emoji: '📷', bg: '#0f172a' },
  { emoji: '🎵', bg: '#7c3aed' },
  { emoji: '🛒', bg: '#f97316' },
  { emoji: '🌿', bg: '#15803d' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Split freeform notes into detail lines, trimming each line but preserving
 * blank lines *between* content (used as visual separators) — only leading
 * and trailing blank lines are dropped. */
function notesToDetails(notes: string): string[] {
  const lines = notes.split('\n').map(s => s.trim());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end);
}

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <Loader2 className="w-5 h-5 text-slate-300 animate-spin" />
    </div>
  );
}

function parseDate(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function estimateDate(before?: ItinerarySegment, after?: ItinerarySegment): string {
  const a = parseDate(before?.date);
  const b = parseDate(after?.date);
  if (a && b) {
    if (a.toDateString() === b.toDateString()) return before!.date!;
    const mid = new Date((a.getTime() + b.getTime()) / 2);
    return mid.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }
  if (a) return before!.date!;
  if (b) return after!.date!;
  return '';
}

function toInputDate(s?: string): string {
  if (!s) return '';
  const d = parseDate(s);
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fromInputDate(s: string): string {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTime(t?: string): string {
  if (!t) return '';
  const [h, min] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${String(min).padStart(2, '0')} ${ampm}`;
}

/** Sort segments chronologically by date, preserving original order for ties */
function sortSegmentsChronologically(segs: ItinerarySegment[]): ItinerarySegment[] {
  return [...segs].sort((a, b) => {
    const da = parseDate(a.date);
    const db_ = parseDate(b.date);
    if (da && db_) return da.getTime() - db_.getTime();
    if (da) return -1;
    if (db_) return 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

// ─── FLIP animation hook ──────────────────────────────────────────────────────
//
// FLIP = First, Last, Invert, Play
// 1. capturePositions()  — record each card's current Y (First)
// 2. React re-renders with new order (Last — browser has new layout)
// 3. animateToNewPositions() — instantly snap cards back to old Y (Invert),
//    then transition to 0 (Play) using a spring easing for the moved card
//    and a smooth ease-out for any cards that shifted to make room.

function useFlipList() {
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const snapshots = useRef<Map<string, number>>(new Map());

  const getCardRef = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  const capturePositions = useCallback(() => {
    snapshots.current.clear();
    cardRefs.current.forEach((el, id) => {
      snapshots.current.set(id, el.getBoundingClientRect().top);
    });
  }, []);

  const animateToNewPositions = useCallback((movedId?: string) => {
    requestAnimationFrame(() => {
      cardRefs.current.forEach((el, id) => {
        const oldTop = snapshots.current.get(id);
        if (oldTop === undefined) return;
        const newTop = el.getBoundingClientRect().top;
        const delta = oldTop - newTop;
        if (Math.abs(delta) < 1) return; // card didn't move — skip

        // Invert: teleport back to old position with no transition
        el.style.transition = 'none';
        el.style.transform = `translateY(${delta}px)`;

        // Play: animate to natural (new) position
        requestAnimationFrame(() => {
          const isMoved = id === movedId;
          // Spring bounce for the card whose date was changed;
          // smooth ease-out for neighbours that just shifted
          const easing = isMoved
            ? 'cubic-bezier(0.34, 1.45, 0.64, 1)'   // gentle spring
            : 'cubic-bezier(0.25, 0.46, 0.45, 0.94)'; // smooth ease-out
          const duration = isMoved ? '480ms' : '320ms';
          el.style.transition = `transform ${duration} ${easing}`;
          el.style.transform = '';

          const cleanup = () => {
            el.style.transition = '';
            el.style.transform = '';
          };
          el.addEventListener('transitionend', cleanup, { once: true });
        });
      });
    });
  }, []);

  return { getCardRef, capturePositions, animateToNewPositions };
}

// ─── Compact Pin Picker ───────────────────────────────────────────────────────

function PinPicker({
  pinColor, pinEmoji, defaultColor, onChange,
}: {
  pinColor: string; pinEmoji: string; defaultColor: string;
  onChange: (color: string, emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentColor = pinColor || defaultColor;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
        title="Map pin style"
      >
        <span
          className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white shadow-sm flex-shrink-0"
          style={{ background: currentColor }}
        >
          {pinEmoji ? <span className="block text-[7px] leading-none text-center mt-[1px]">{pinEmoji}</span> : null}
        </span>
        <span>Pin</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1.5 z-20 bg-white border border-slate-200 rounded-xl shadow-lg p-3 space-y-2.5"
          style={{ minWidth: '200px' }}
        >
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => { onChange('', ''); setOpen(false); }}
              className="w-5 h-5 rounded-full border-2 flex-shrink-0"
              style={{
                background: 'conic-gradient(#ef4444,#f97316,#eab308,#22c55e,#3b82f6,#8b5cf6,#ef4444)',
                borderColor: (!pinColor && !pinEmoji) ? '#0f172a' : 'transparent',
                outline: (!pinColor && !pinEmoji) ? '2px solid #0f172a' : 'none',
                outlineOffset: '2px',
              }}
              title="Default"
            />
            {PIN_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => { onChange(c, ''); setOpen(false); }}
                className="w-5 h-5 rounded-full border-2 flex-shrink-0"
                style={{
                  background: c,
                  borderColor: (pinColor === c && !pinEmoji) ? '#0f172a' : 'transparent',
                  outline: (pinColor === c && !pinEmoji) ? '2px solid #0f172a' : 'none',
                  outlineOffset: '2px',
                }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PIN_EMOJI_OPTIONS.map(({ emoji, bg }) => (
              <button
                key={emoji}
                type="button"
                onClick={() => { onChange(bg, emoji); setOpen(false); }}
                className="w-6 h-6 rounded-full border-2 flex items-center justify-center text-[11px] flex-shrink-0"
                style={{
                  background: bg,
                  borderColor: pinEmoji === emoji ? '#0f172a' : 'transparent',
                  outline: pinEmoji === emoji ? '2px solid #0f172a' : 'none',
                  outlineOffset: '2px',
                }}
              >{emoji}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Inline Event Form ────────────────────────────────────────────────────────

interface EventFormProps {
  initialTitle?: string;
  initialDate?: string;
  initialTime?: string;
  initialAddress?: string;
  initialNotes?: string;
  initialPinColor?: string;
  initialPinEmoji?: string;
  defaultPinColor?: string;
  onSave: (data: {
    title: string; date: string; time: string;
    address: string; notes: string;
    pinColor: string; pinEmoji: string;
  }) => void;
  onCancel: () => void;
}

function EventForm({
  initialTitle = '', initialDate = '', initialTime = '',
  initialAddress = '', initialNotes = '',
  initialPinColor = '', initialPinEmoji = '',
  defaultPinColor = '#64748b',
  onSave, onCancel,
}: EventFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [dateVal, setDateVal] = useState(toInputDate(initialDate));
  const [timeVal, setTimeVal] = useState(initialTime);
  const [address, setAddress] = useState(initialAddress);
  const [notes, setNotes] = useState(initialNotes);
  const [pinColor, setPinColor] = useState(initialPinColor);
  const [pinEmoji, setPinEmoji] = useState(initialPinEmoji);
  const titleRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  // Grow the textarea to fit its content on every change
  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  };

  // Also resize on initial render (when editing an existing event with notes)
  useEffect(() => {
    if (notesRef.current && notes) autoResize(notesRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    onSave({
      title: title.trim(),
      date: fromInputDate(dateVal),
      time: timeVal,
      address: address.trim(),
      notes: notes.trim(),
      pinColor, pinEmoji,
    });
  };

  return (
    <div
      className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3 shadow-sm"
      style={{ boxShadow: '0 4px 20px rgba(15,23,42,0.07)' }}
    >
      <input
        ref={titleRef}
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
        placeholder="Event title"
        className="w-full text-sm font-semibold text-slate-900 placeholder-slate-300 bg-transparent border-0 border-b border-slate-100 pb-2 focus:outline-none focus:border-slate-300 transition-colors"
      />

      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Date</label>
          <input
            type="date"
            value={dateVal}
            onChange={e => setDateVal(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-700 focus:outline-none focus:border-slate-400 transition-colors bg-white"
          />
        </div>
        <div className="flex-1">
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Time</label>
          <input
            type="time"
            value={timeVal}
            onChange={e => setTimeVal(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-700 focus:outline-none focus:border-slate-400 transition-colors bg-white"
          />
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Location</label>
        <div className="relative">
          <MapPin className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-300 pointer-events-none" />
          <input
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="Address or place name"
            className="w-full pl-7 pr-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-700 placeholder-slate-300 focus:outline-none focus:border-slate-400 transition-colors"
          />
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Notes</label>
        <textarea
          ref={notesRef}
          value={notes}
          onChange={e => { setNotes(e.target.value); autoResize(e.target); }}
          placeholder="Confirmation numbers, details, reminders…"
          rows={2}
          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-700 placeholder-slate-300 focus:outline-none focus:border-slate-400 transition-colors resize-none overflow-hidden"
          style={{ minHeight: '52px' }}
        />
      </div>

      <div className="flex items-center justify-between pt-1">
        <PinPicker
          pinColor={pinColor}
          pinEmoji={pinEmoji}
          defaultColor={defaultPinColor}
          onChange={(c, e) => { setPinColor(c); setPinEmoji(e); }}
        />
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!title.trim()}
            className="px-4 py-1.5 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-700 disabled:opacity-30 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Between-event Plus Button ────────────────────────────────────────────────

function BetweenPlus({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="flex items-center justify-center h-5 cursor-pointer"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <div
        className="flex items-center justify-center w-5 h-5 rounded-full border transition-all duration-150"
        style={{
          opacity: hover ? 1 : 0,
          background: hover ? '#f8fafc' : 'transparent',
          borderColor: hover ? '#cbd5e1' : 'transparent',
          transform: hover ? 'scale(1)' : 'scale(0.7)',
        }}
      >
        <Plus className="w-2.5 h-2.5 text-slate-400" />
      </div>
    </div>
  );
}

// ─── Context Notes (debounced) ────────────────────────────────────────────────

const ContextNotesEditor = React.memo(function ContextNotesEditor({
  initialValue, onCommit,
}: { initialValue: string; onCommit: (val: string) => void }) {
  const [text, setText] = useState(initialValue);
  const hasSyncedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hasSyncedRef.current && initialValue) {
      setText(initialValue);
      hasSyncedRef.current = true;
    }
  }, [initialValue]);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const handleChange = (val: string) => {
    setText(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onCommit(val), 1200);
  };

  return (
    <textarea
      value={text}
      onChange={e => handleChange(e.target.value)}
      placeholder={"Paste booking confirmations, flight details, or any travel text here.\n\nExample:\nAA 123  JFK -> LAX  Jun 2  9:00am-1:15pm  Conf: ABC123\nMarriott Times Square  Check-in Jun 2  Check-out Jun 5  Conf: XYZ789"}
      rows={7}
      className="w-full px-3 py-2.5 bg-white rounded-xl border border-slate-200 text-xs text-slate-700 placeholder-slate-300 resize-none focus:outline-none focus:border-slate-400 transition-colors leading-relaxed"
    />
  );
});

// ─── Main Component ───────────────────────────────────────────────────────────

export function ItineraryContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: ItineraryTabContentProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;

  // ── core state ──
  const [segments, setSegments] = useState<ItinerarySegment[]>([]);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [contextNotes, setContextNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<DocItem | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [analysisError, setAnalysisError] = useState('');

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const allExpandedRef = useRef(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [insertAfterIdx, setInsertAfterIdx] = useState<number | null>(null);
  const [pendingSegDeletes, setPendingSegDeletes] = useState<Map<string, { seg: ItinerarySegment; timer: ReturnType<typeof setTimeout> }>>(new Map());

  // ── FLIP animation ──
  const { getCardRef, capturePositions, animateToNewPositions } = useFlipList();
  // Track the ID of the card whose date was just changed (gets the bounce)
  const reorderedIdRef = useRef<string | null>(null);
  // Track previous segment order to detect when a reorder actually happened
  const prevSegmentIdsRef = useRef<string[]>([]);

  // ── map state ──
  const [mapReady, setMapReady] = useState(false);
  const [activeDay, setActiveDay] = useState('all');
  const [activeSegId, setActiveSegId] = useState<string | null>(null);
  const [geocodingSet, setGeocodingSet] = useState<Set<string>>(new Set());
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);
  const [showMap, setShowMap] = useState(false);
  const [splitMode, setSplitMode] = useState(false);

  // ── refs ──
  const didAutoAnalyze = useRef(false);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const gMap = useRef<any>(null);
  const gMarkers = useRef<Map<string, any>>(new Map());
  const gInfoWin = useRef<any>(null);
  const segmentsRef = useRef<ItinerarySegment[]>([]);
  const activeDayRef = useRef<string>('all');
  const geocodingSetRef = useRef<Set<string>>(new Set());
  const plotMarkersRef = useRef<(dayOverride?: string) => void>(() => {});

  const MAPS_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_KEY as string | undefined;

  const segPath = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/segments`;
  const docPath = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/docs`;
  const tabDocRef = () => fsDoc(db, 'users', effectiveUid!, 'chapters', chapterId, 'customTabs', tabId);

  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { activeDayRef.current = activeDay; }, [activeDay]);
  useEffect(() => { geocodingSetRef.current = geocodingSet; }, [geocodingSet]);

  // ── FLIP: fire animation after every segments state change ──
  useEffect(() => {
    const newIds = segments.map(s => s.id);
    const prevIds = prevSegmentIdsRef.current;
    const orderChanged =
      prevIds.length > 0 &&
      prevIds.length === newIds.length &&
      newIds.some((id, i) => id !== prevIds[i]);

    if (orderChanged) {
      animateToNewPositions(reorderedIdRef.current ?? undefined);
      reorderedIdRef.current = null;
    }
    prevSegmentIdsRef.current = newIds;
  }, [segments, animateToNewPositions]);

  // ── data ──
  const load = async () => {
    if (!user) return;
    try {
      const [segSnap, docSnap, tabSnap] = await Promise.all([
        getDocs(query(collection(db, segPath()), orderBy('order', 'asc'))).catch(() => getDocs(collection(db, segPath()))),
        getDocs(collection(db, docPath())),
        getDoc(tabDocRef()),
      ]);
      const segs = segSnap.docs.map(d => ({ id: d.id, ...d.data() } as ItinerarySegment));
      setSegments(sortSegmentsChronologically(segs));
      if (!allExpandedRef.current) {
        allExpandedRef.current = true;
        setExpandedIds(new Set(segs.filter(s => s.details.length > 0).map(s => s.id)));
      }
      setDocs(docSnap.docs.map(d => ({ id: d.id, ...d.data(), uploadedAt: d.data().uploadedAt?.toDate?.()?.toISOString() ?? '' } as DocItem)));
      setContextNotes(tabSnap.data()?.contextNotes ?? '');
    } finally { setLoading(false); }
  };

  useEffect(() => { if (user) load(); }, [tabId, user, refreshKey]);

  useEffect(() => {
    if (loading || didAutoAnalyze.current || segments.length > 0) return;
    if (!contextNotes.trim() && docs.length === 0) return;
    didAutoAnalyze.current = true;
    analyze();
  }, [loading]);

  useEffect(() => {
    const h = () => setIsDesktop(window.innerWidth >= 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  useEffect(() => {
    return () => {
      gMarkers.current.forEach(m => m.setMap?.(null));
      gMarkers.current.clear();
      if (gInfoWin.current) { gInfoWin.current.close(); gInfoWin.current = null; }
      gMap.current = null;
      if ((window as any).__googleMapsReady) delete (window as any).__googleMapsReady;
    };
  }, []);

  // ── map functions ──
  const fitBounds = useCallback((dayOverride?: string) => {
    if (!gMap.current || !(window as any).google?.maps) return;
    const day = dayOverride ?? activeDayRef.current;
    const vis = segmentsRef.current.filter(s => s.lat && s.lng && (day === 'all' || s.date === day));
    if (!vis.length) return;
    if (vis.length === 1) { gMap.current.setCenter({ lat: vis[0].lat!, lng: vis[0].lng! }); gMap.current.setZoom(14); return; }
    const b = new (window as any).google.maps.LatLngBounds();
    vis.forEach(s => b.extend({ lat: s.lat!, lng: s.lng! }));
    gMap.current.fitBounds(b, { top: 60, bottom: 30, left: 30, right: 30 });
  }, []);

  const plotMarkers = useCallback((dayOverride?: string) => {
    if (!gMap.current || !(window as any).google?.maps) return;
    const currentSegments = segmentsRef.current;
    const day = dayOverride ?? activeDayRef.current;
    gMarkers.current.forEach(m => { try { m.map = null; } catch {} });
    gMarkers.current.clear();
    if (gInfoWin.current) { gInfoWin.current.close(); gInfoWin.current = null; }

    const g = (window as any).google.maps;
    const AdvancedMarkerElement = g.marker?.AdvancedMarkerElement;

    currentSegments.forEach(seg => {
      if (!seg.lat || !seg.lng) return;
      const visible = day === 'all' || seg.date === day;
      const pinColor = seg.pinColor || CAT_DOT[seg.category] || '#64748b';
      const pinEmoji = seg.pinEmoji || '';

      let markerEl: any;
      try {
        if (AdvancedMarkerElement) {
          const pinDiv = document.createElement('div');
          if (pinEmoji) {
            pinDiv.style.cssText = [
              'width:26px','height:26px','border-radius:50%',
              `background:${pinColor}`,
              'border:2.5px solid #ffffff',
              'box-shadow:0 2px 6px rgba(0,0,0,0.45)',
              'cursor:pointer',
              'display:flex','align-items:center','justify-content:center',
              'font-size:13px','line-height:1',
            ].join(';');
            pinDiv.textContent = pinEmoji;
          } else {
            pinDiv.style.cssText = [
              'width:16px','height:16px','border-radius:50%',
              `background:${pinColor}`,
              'border:2.5px solid #ffffff',
              'box-shadow:0 2px 6px rgba(0,0,0,0.45)',
              'cursor:pointer',
            ].join(';');
          }
          markerEl = new AdvancedMarkerElement({
            position: { lat: seg.lat, lng: seg.lng },
            map: visible ? gMap.current : null,
            title: seg.title,
            content: pinDiv,
          });
        } else {
          markerEl = new g.Marker({
            position: { lat: seg.lat, lng: seg.lng },
            map: visible ? gMap.current : null,
            title: seg.title,
          });
        }
      } catch (err) { console.error('[plotMarkers] failed for', seg.title, err); return; }

      markerEl.addListener('click', () => {
        if (gInfoWin.current) gInfoWin.current.close();
        const iw = new g.InfoWindow({
          content: `<div style="padding:6px 8px;font-family:-apple-system,sans-serif;max-width:200px"><strong style="font-size:12px;color:#0f172a">${seg.title}</strong>${seg.address ? `<br><span style="font-size:11px;color:#64748b;display:block;margin-top:2px">${seg.address}</span>` : ''}${seg.date ? `<br><span style="font-size:10px;color:#94a3b8">${seg.date}</span>` : ''}</div>`,
        });
        iw.open(gMap.current, markerEl);
        gInfoWin.current = iw;
        setActiveSegId(seg.id);
      });
      gMarkers.current.set(seg.id, markerEl);
    });
    fitBounds(day);
  }, [fitBounds]);

  const geocodeNew = useCallback(async () => {
    if (!(window as any).google?.maps?.Geocoder) return;
    const currentSegments = segmentsRef.current;
    const pending = currentSegments.filter(s => !s.lat && !geocodingSetRef.current.has(s.id));
    if (!pending.length) return;

    const pendingIds = pending.map(s => s.id);
    geocodingSetRef.current = new Set([...geocodingSetRef.current, ...pendingIds]);
    setGeocodingSet(new Set(geocodingSetRef.current));

    const geocoder = new (window as any).google.maps.Geocoder();
    const geocodeOne = (address: string): Promise<{ lat: number; lng: number; formatted: string } | null> =>
      new Promise(resolve => {
        geocoder.geocode({ address }, (results: any[], status: string) => {
          if (status === 'OK' && results?.[0]) {
            const { lat, lng } = results[0].geometry.location;
            resolve({ lat: typeof lat === 'function' ? lat() : lat, lng: typeof lng === 'function' ? lng() : lng, formatted: results[0].formatted_address });
          } else { resolve(null); }
        });
      });

    const updates: Record<string, { lat: number; lng: number; address: string }> = {};
    for (const seg of pending) {
      try {
        let q: string;
        if (seg.address) {
          q = seg.address;
        } else {
          const cleaned = seg.title.replace(/^(flight to|fly to|fly from|depart|arrive|land|hotel at|stay at|check in|check out|lunch at|dinner at|breakfast at|brunch at|cocktails at|drinks at|party at|meet at|event at|show at|ceremony at|reception at)\s+/i, '');
          const extra = seg.details.find(d => /\d{1,5}\s+\w/.test(d) || /,\s*\w{2}/.test(d));
          q = cleaned + (extra ? ', ' + extra : '');
        }
        const result = await geocodeOne(q);
        if (result) {
          updates[seg.id] = { lat: result.lat, lng: result.lng, address: result.formatted };
          await updateDoc(fsDoc(db, segPath(), seg.id), { lat: result.lat, lng: result.lng, address: result.formatted });
        }
      } catch (err) { console.error('[geocodeNew] error for', seg.title, err); }
    }

    if (Object.keys(updates).length > 0) {
      setSegments(prev => {
        const next = prev.map(s => updates[s.id] ? { ...s, ...updates[s.id] } : s);
        segmentsRef.current = next;
        return next;
      });
      setTimeout(() => plotMarkersRef.current?.(), 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Maps loader ──
  useEffect(() => {
    if (!MAPS_KEY) return;
    let cancelled = false;

    const initMap = () => {
      if (cancelled || gMap.current || !mapDivRef.current) return;
      const g = (window as any).google?.maps;
      if (!g?.Map) return;
      try {
        const savedCenter = getSavedMapCenter();
        const initialCenter = savedCenter
          ? { lat: savedCenter.lat, lng: savedCenter.lng }
          : { lat: 39.4143, lng: -77.4105 };
        const map = new g.Map(mapDivRef.current, {
          zoom: 13,
          center: initialCenter,
          disableDefaultUI: true,
          zoomControl: true,
          mapId: 'DEMO_MAP_ID',
        });
        gMap.current = map;
        setMapReady(true);
        g.event.addListenerOnce(map, 'idle', () => {
          if (cancelled) return;
          g.event.trigger(map, 'resize');
        });
      } catch (e) { console.error('Map init error:', e); }
    };

    if ((window as any).google?.maps?.Map) { initMap(); }

    const scriptId = 'google-maps-public-script';
    if (!document.getElementById(scriptId)) {
      const s = document.createElement('script');
      s.id = scriptId;
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&v=weekly&libraries=geometry,marker&loading=async`;
      s.async = true;
      document.head.appendChild(s);
    }

    const poll = setInterval(() => {
      if (cancelled) { clearInterval(poll); return; }
      if (gMap.current) { clearInterval(poll); return; }
      if ((window as any).google?.maps?.Map && mapDivRef.current) {
        clearInterval(poll);
        initMap();
      }
    }, 50);

    return () => { cancelled = true; clearInterval(poll); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [MAPS_KEY]);

  plotMarkersRef.current = plotMarkers;

  useEffect(() => {
    if (!gMap.current || !(window as any).google?.maps) return;
    plotMarkers();
  }, [segments, mapReady, plotMarkers]);

  useEffect(() => {
    if (!gMap.current || !(window as any).google?.maps) return;
    geocodeNew();
  }, [segments, mapReady, geocodeNew]);

  useEffect(() => {
    if (!gMap.current || !(window as any).google?.maps) return;
    const resizeAndFit = () => {
      (window as any).google.maps.event.trigger(gMap.current, 'resize');
      fitBounds();
    };
    resizeAndFit();
    const t = setTimeout(resizeAndFit, 200);
    return () => clearTimeout(t);
  }, [showMap, splitMode, isDesktop, segments, fitBounds]);

  const focusSegment = (seg: ItinerarySegment) => {
    setActiveSegId(seg.id);
    if (!seg.lat || !seg.lng || !gMap.current) return;
    if (!isDesktop && !splitMode) setShowMap(true);
    setTimeout(() => {
      if (!gMap.current) return;
      gMap.current.panTo({ lat: seg.lat!, lng: seg.lng! });
      gMap.current.setZoom(15);
      const marker = gMarkers.current.get(seg.id);
      if (marker) {
        if (gInfoWin.current) gInfoWin.current.close();
        const iw = new (window as any).google.maps.InfoWindow({
          content: `<div style="padding:6px 8px;font-family:-apple-system,sans-serif;max-width:200px"><strong style="font-size:12px;color:#0f172a">${seg.title}</strong>${seg.address ? `<br><span style="font-size:11px;color:#64748b;display:block;margin-top:2px">${seg.address}</span>` : ''}</div>`,
        });
        iw.open(gMap.current, marker);
        gInfoWin.current = iw;
      }
    }, !isDesktop && !splitMode ? 380 : 80);
  };

  const filterByDay = (day: string) => {
    setActiveDay(day);
    activeDayRef.current = day;
    gMarkers.current.forEach((marker, id) => {
      const seg = segmentsRef.current.find(s => s.id === id);
      const show = day === 'all' || seg?.date === day;
      if (typeof marker.setMap === 'function') {
        marker.setMap(show ? gMap.current : null);
      } else {
        marker.map = show ? gMap.current : null;
      }
    });
    setTimeout(() => fitBounds(day), 100);
  };

  // ── itinerary logic ──
  const commitContextNotes = async (val: string) => {
    setContextNotes(val);
    if (!user) return;
    await updateDoc(tabDocRef(), { contextNotes: val }).catch(console.error);
    if (val.trim() && segmentsRef.current.length === 0) analyze();
  };

  const validateCategory = (cat: string): SegmentCategory => {
    const lower = (cat || '').toLowerCase().trim();
    return (VALID_SEGMENT_CATS as readonly string[]).includes(lower) ? lower as SegmentCategory : 'note';
  };

  const analyze = async () => {
    if (!user) return;
    setAnalyzing(true); setAnalysisError('');
    try {
      const [mainDocSnap, tabDocSnap] = await Promise.all([
        getDocs(collection(db, `users/${effectiveUid}/chapters/${chapterId}/docs`)),
        getDocs(collection(db, docPath())),
      ]);
      const allFileNames = [...mainDocSnap.docs.map(d => d.data().fileName), ...tabDocSnap.docs.map(d => d.data().fileName)].filter(Boolean);
      const docLine = allFileNames.length > 0 ? `Travel documents: ${allFileNames.join(', ')}.` : '';
      const notesLine = contextNotes.trim().slice(0, 600) ? `Booking details: ${contextNotes.trim().slice(0, 600)}` : '';
      const prompt = [
        'Extract a travel itinerary and return as cards.',
        'Each card: title (descriptive, e.g. "Lunch at Pistarros"), category (must be one of: flight/hotel/car/activity/transfer/note), date (specific event date e.g. "March 13, 2027" or empty string), address (searchable location for a map pin -- include venue name and city/state, or a full street address; leave empty if truly unknown), items (2-4 details: times, confirmation numbers, notes).',
        docLine, notesLine,
      ].filter(Boolean).join(' ');

      const generateChapter = httpsCallable(functions, 'generateChapter');
      const result = await generateChapter({ prompt });
      const data = result.data as any;
      const cards = data?.chapter?.cards || data?.cards || [];
      if (!cards.length) { setAnalysisError('No itinerary details found. Try adding confirmation text in the notes section below.'); return; }

      const existing = await getDocs(collection(db, segPath()));
      const batch = writeBatch(db);
      existing.docs.forEach(d => { if (!d.data().manuallyAdded) batch.delete(d.ref); });
      cards.forEach((c: any, i: number) => {
        const newRef = fsDoc(collection(db, segPath()));
        batch.set(newRef, {
          title: c.title || c.name || 'Untitled',
          category: validateCategory(c.category),
          date: typeof c.date === 'string' ? c.date : '',
          address: typeof c.address === 'string' ? c.address.trim() : '',
          details: (c.items || []).map((item: any) => typeof item === 'string' ? item : (item.text || '')).filter(Boolean).slice(0, 8),
          order: i, createdAt: serverTimestamp(),
        });
      });
      await batch.commit();
      allExpandedRef.current = false;
      load();
    } catch (err) {
      console.error('Itinerary analysis error:', err);
      setAnalysisError('Something went wrong. Please try again.');
    } finally { setAnalyzing(false); }
  };

  const deleteSegment = (id: string) => {
    const seg = segments.find(s => s.id === id);
    if (!seg || !user) return;
    const existing = pendingSegDeletes.get(id);
    if (existing) clearTimeout(existing.timer);
    setSegments(prev => { const next = prev.filter(s => s.id !== id); segmentsRef.current = next; return next; });
    const timer = setTimeout(async () => {
      try { await deleteDoc(fsDoc(db, segPath(), id)); } catch {}
      setPendingSegDeletes(prev => { const n = new Map(prev); n.delete(id); return n; });
    }, 5000);
    setPendingSegDeletes(prev => new Map(prev).set(id, { seg, timer }));
  };

  const undoDeleteSegment = (id: string) => {
    const p = pendingSegDeletes.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    setPendingSegDeletes(prev => { const n = new Map(prev); n.delete(id); return n; });
    setSegments(prev => {
      const restored = sortSegmentsChronologically([...prev, p.seg]);
      segmentsRef.current = restored;
      return restored;
    });
  };

  const addEventAt = async (data: {
    title: string; date: string; time: string;
    address: string; notes: string;
    pinColor: string; pinEmoji: string;
  }, insertAfter: number) => {
    if (!user || !data.title) return;
    const details = data.notes ? notesToDetails(data.notes) : [];
    const newOrder = insertAfter + 1;
    const batch = writeBatch(db);
    segments.forEach((seg, idx) => {
      if (idx > insertAfter) {
        batch.update(fsDoc(db, segPath(), seg.id), { order: idx + 1 });
      }
    });
    const newRef = fsDoc(collection(db, segPath()));
    batch.set(newRef, {
      title: data.title,
      category: 'activity' as SegmentCategory,
      date: data.date,
      time: data.time,
      address: data.address,
      details,
      pinColor: data.pinColor,
      pinEmoji: data.pinEmoji,
      order: newOrder,
      manuallyAdded: true,
      createdAt: serverTimestamp(),
    });
    await batch.commit();
    setInsertAfterIdx(null);
    allExpandedRef.current = false;
    load();
  };

  /** Save edits — FLIP-animates the list if the date change causes a reorder */
  const saveEdit = async (seg: ItinerarySegment, data: {
    title: string; date: string; time: string;
    address: string; notes: string;
    pinColor: string; pinEmoji: string;
  }) => {
    if (!user) return;
    const details = data.notes ? notesToDetails(data.notes) : [];
    const addressChanged = data.address.trim() && data.address.trim() !== seg.address;
    const updates: Record<string, any> = {
      title: data.title || seg.title,
      date: data.date,
      time: data.time,
      details,
      pinColor: data.pinColor,
      pinEmoji: data.pinEmoji,
    };
    if (addressChanged) {
      updates.address = data.address.trim();
      updates.lat = null;
      updates.lng = null;
    }

    await updateDoc(fsDoc(db, segPath(), seg.id), updates);
    setEditingId(null);

    // Compute new sorted order
    const updatedSeg = { ...seg, ...updates };
    const updatedList = segments.map(s => s.id === seg.id ? updatedSeg : s);
    const resorted = sortSegmentsChronologically(updatedList);

    const oldOrder = segments.map(s => s.id);
    const newOrder = resorted.map(s => s.id);
    const orderWillChange = oldOrder.some((id, i) => id !== newOrder[i]);

    if (orderWillChange) {
      // Snapshot current positions BEFORE React re-renders
      capturePositions();
      reorderedIdRef.current = seg.id;
    }

    // Update state — FLIP effect fires in the useEffect watching segments
    setSegments(resorted);
    segmentsRef.current = resorted;

    if (addressChanged) {
      setGeocodingSet(prev => { const n = new Set(prev); n.delete(seg.id); return n; });
    }
  };

  const handleUpload = async (file: File) => {
    if (!user) return;
    setUploading(true);
    try {
      const storageRef = ref(storage, `users/${effectiveUid}/itinerary/${tabId}/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file);
      const fileUrl = await getDownloadURL(storageRef);
      await addDoc(collection(db, docPath()), { fileName: file.name, fileUrl, fileType: file.type, uploadedAt: serverTimestamp() });
      await load();
      if (segments.length === 0) { didAutoAnalyze.current = false; analyze(); }
    } catch (err) { console.error(err); }
    finally { setUploading(false); }
  };

  const handleDeleteDoc = async (d: DocItem) => {
    if (!user) return;
    await deleteDoc(fsDoc(db, docPath(), d.id));
    setDocs(prev => prev.filter(doc => doc.id !== d.id));
  };

  const handleDownload = async (d: DocItem) => {
    try {
      const res = await fetch(d.fileUrl); const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = d.fileName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { window.open(d.fileUrl, '_blank'); }
  };

  // ── derived ──
  const uniqueDays = [...new Set(segments.map(s => s.date).filter(Boolean))]
    .sort((a, b) => {
      const da = parseDate(a as string);
      const db_ = parseDate(b as string);
      if (!da || !db_) return 0;
      return da.getTime() - db_.getTime();
    }) as string[];

  const hasMappable = !!(MAPS_KEY && segments.length > 0);
  const detailEligibleIds = segments.filter(s => s.details.length > 0).map(s => s.id);
  const allDetailsShown = detailEligibleIds.length > 0 && detailEligibleIds.every(id => expandedIds.has(id));

  const toggleAllDetails = () => {
    setExpandedIds(allDetailsShown ? new Set() : new Set(detailEligibleIds));
  };

  const mapPanelStyle: React.CSSProperties = isDesktop || splitMode
    ? {}
    : showMap
      ? { position: 'fixed', inset: 0, zIndex: 40 }
      : { position: 'fixed', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none', zIndex: -1 };

  const mapDivHeight = isDesktop ? 'calc(100vh - 200px)' : splitMode ? '44svh' : '100svh';

  if (loading) return <Spinner />;

  return (
    <>
      {/* Mobile toggle pill */}
      {hasMappable && !isDesktop && (
        <div
          className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 rounded-full px-1.5 py-1.5 border border-slate-200/80 shadow-lg"
          style={{ background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
        >
          {!splitMode && (
            <>
              <button onClick={() => setShowMap(false)} className={`px-5 py-2 rounded-full text-xs font-semibold uppercase tracking-wider transition-colors ${!showMap ? 'bg-slate-900 text-white' : 'text-slate-500'}`}>Timeline</button>
              <button onClick={() => setShowMap(true)} className={`px-5 py-2 rounded-full text-xs font-semibold uppercase tracking-wider transition-colors ${showMap ? 'bg-slate-900 text-white' : 'text-slate-500'}`}>Map</button>
              <div className="w-px h-5 bg-slate-200 mx-1" />
            </>
          )}
          <button
            onClick={() => { setSplitMode(v => !v); setShowMap(false); }}
            className="p-2 text-slate-500 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
            title={splitMode ? 'Switch to tab view' : 'Split screen'}
          >
            {splitMode
              ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>
            }
          </button>
        </div>
      )}

      {/* Split layout */}
      <div
        className={`${isDesktop ? 'flex flex-row' : splitMode ? 'flex flex-col' : 'block'} -mx-4 md:mx-0`}
        style={{ height: isDesktop ? 'calc(100vh - 200px)' : undefined }}
      >
        {/* ── Left: Travel Details ── */}
        <div
          className={`
            ${isDesktop ? 'w-[45%] overflow-y-auto border-r border-slate-100' : 'w-full'}
            ${splitMode ? 'h-[44svh] overflow-y-auto border-b border-slate-100' : ''}
            ${!isDesktop && !splitMode && showMap ? 'hidden' : ''}
            px-4 md:px-6
          `}
        >
          <div className="max-w-xl space-y-5 py-5 pb-28 md:pb-8">

            {analyzing && segments.length === 0 && (
              <div className="flex items-center justify-center gap-2.5 py-6 text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Building your itinerary…</span>
              </div>
            )}
            {analysisError && segments.length === 0 && (
              <p className="text-xs text-red-400 text-center">{analysisError}</p>
            )}

            {/* ── Schedule ── */}
            {segments.length > 0 ? (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[10px] font-semibold uppercase tracking-[1.2px] text-slate-400">Schedule</span>
                  <div className="flex items-center gap-3">
                    {detailEligibleIds.length > 0 && (
                      <button
                        onClick={toggleAllDetails}
                        className="flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-700 transition-colors"
                      >
                        <span>{allDetailsShown ? 'Hide details' : 'Show details'}</span>
                        <span className={`relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors ${allDetailsShown ? 'bg-slate-800' : 'bg-slate-200'}`}>
                          <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${allDetailsShown ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                        </span>
                      </button>
                    )}
                    <span className="text-[10px] text-slate-300">{segments.length} event{segments.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>

                {/* Timeline */}
                <div className="relative">
                  <div className="absolute left-[7px] top-3 bottom-3 w-px bg-slate-100" />

                  {insertAfterIdx === -1 ? (
                    <div className="pl-6 mb-2">
                      <EventForm
                        initialDate={estimateDate(undefined, segments[0])}
                        defaultPinColor={CAT_DOT.activity}
                        onSave={data => addEventAt(data, -1)}
                        onCancel={() => setInsertAfterIdx(null)}
                      />
                    </div>
                  ) : (
                    <div className="pl-6 mb-1">
                      <BetweenPlus onClick={() => setInsertAfterIdx(-1)} />
                    </div>
                  )}

                  {segments.map((seg, idx) => {
                    const dotColor = seg.pinColor || CAT_DOT[seg.category] || '#94a3b8';
                    const isExpanded = expandedIds.has(seg.id);
                    const isActive = activeSegId === seg.id;
                    const isEditing = editingId === seg.id;

                    return (
                      <div key={seg.id}>
                        <div className="flex gap-3 items-start group">
                          {/* Timeline dot */}
                          <div className="relative flex-shrink-0 mt-[14px]">
                            <div
                              className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-sm z-10 relative"
                              style={{ background: dotColor }}
                            />
                          </div>

                          {/* Card — ref attached for FLIP */}
                          <div
                            className="flex-1 min-w-0 mb-1"
                            ref={getCardRef(seg.id) as React.RefCallback<HTMLDivElement>}
                          >
                            {isEditing ? (
                              <EventForm
                                initialTitle={seg.title}
                                initialDate={seg.date}
                                initialTime={seg.time}
                                initialAddress={seg.address}
                                initialNotes={seg.details.join('\n')}
                                initialPinColor={seg.pinColor}
                                initialPinEmoji={seg.pinEmoji}
                                defaultPinColor={CAT_DOT[seg.category]}
                                onSave={data => saveEdit(seg, data)}
                                onCancel={() => setEditingId(null)}
                              />
                            ) : (
                              <div
                                className={`rounded-xl px-3 py-2.5 cursor-pointer transition-all group/card ${
                                  isActive
                                    ? 'bg-white border border-slate-200 shadow-sm'
                                    : 'bg-transparent hover:bg-white hover:border hover:border-slate-100 hover:shadow-sm border border-transparent'
                                }`}
                                onClick={() => focusSegment(seg)}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex-1 min-w-0">
                                    {(seg.date || seg.time) && (
                                      <div className="flex items-center gap-1.5 mb-0.5">
                                        {seg.date && (
                                          <span className="text-[10px] text-slate-400 font-medium">{seg.date}</span>
                                        )}
                                        {seg.time && (
                                          <>
                                            <span className="text-slate-200 text-[10px]">·</span>
                                            <span className="text-[10px] text-slate-400">{formatTime(seg.time)}</span>
                                          </>
                                        )}
                                      </div>
                                    )}
                                    <p className="text-sm font-semibold text-slate-800 leading-snug">{seg.title}</p>
                                    {seg.address && (
                                      <p className="text-[11px] text-slate-400 leading-snug mt-0.5 truncate">{seg.address}</p>
                                    )}
                                    {seg.details.length > 0 && (
                                      <>
                                        <button
                                          onClick={e => {
                                            e.stopPropagation();
                                            setExpandedIds(prev => {
                                              const n = new Set(prev);
                                              n.has(seg.id) ? n.delete(seg.id) : n.add(seg.id);
                                              return n;
                                            });
                                          }}
                                          className="inline-flex items-center gap-0.5 text-[10px] text-slate-400 hover:text-slate-600 font-medium mt-1 transition-colors"
                                        >
                                          <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} />
                                          {isExpanded ? 'Hide' : 'Details'}
                                        </button>
                                        {isExpanded && (
                                          <div className="mt-1.5 pt-1.5 border-t border-dashed border-slate-100 space-y-0.5">
                                            {seg.details.map((d, i) => (
                                              d === ''
                                                ? <div key={i} className="h-2" aria-hidden="true" />
                                                : <p key={i} className="text-[11px] text-slate-500 leading-snug">{d}</p>
                                            ))}
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover/card:opacity-100 transition-opacity">
                                    <button
                                      onClick={e => { e.stopPropagation(); setEditingId(seg.id); }}
                                      className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
                                      title="Edit"
                                    >
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                    </button>
                                    <button
                                      onClick={e => { e.stopPropagation(); deleteSegment(seg.id); }}
                                      className="p-1.5 rounded-lg hover:bg-red-50 transition-colors"
                                      title="Delete"
                                    >
                                      <Trash2 className="w-3 h-3 text-red-300" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>

                        {insertAfterIdx === idx ? (
                          <div className="pl-6 my-1">
                            <EventForm
                              initialDate={estimateDate(seg, segments[idx + 1])}
                              defaultPinColor={CAT_DOT.activity}
                              onSave={data => addEventAt(data, idx)}
                              onCancel={() => setInsertAfterIdx(null)}
                            />
                          </div>
                        ) : (
                          <div className="pl-6">
                            <BetweenPlus onClick={() => setInsertAfterIdx(idx)} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : !analyzing ? (
              <div className="rounded-2xl border border-dashed border-slate-200 p-10 text-center">
                <div className="text-3xl mb-3">✈️</div>
                <p className="text-sm font-semibold text-slate-700 mb-1">Nothing here yet</p>
                <p className="text-xs text-slate-400 leading-relaxed max-w-xs mx-auto">
                  Upload a doc or paste confirmation details below — your itinerary builds automatically.
                </p>
                <button
                  onClick={() => setInsertAfterIdx(-1)}
                  className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 border border-slate-200 hover:border-slate-400 bg-white px-3 py-1.5 rounded-lg transition-all"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add first event
                </button>
                {insertAfterIdx === -1 && (
                  <div className="mt-3 text-left">
                    <EventForm
                      defaultPinColor={CAT_DOT.activity}
                      onSave={data => addEventAt(data, -1)}
                      onCancel={() => setInsertAfterIdx(null)}
                    />
                  </div>
                )}
              </div>
            ) : null}

            <button
              onClick={analyze}
              disabled={analyzing}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
            >
              {analyzing
                ? <><Loader2 className="w-3 h-3 animate-spin" />Scanning…</>
                : <><Sparkles className="w-3 h-3" />Re-Scan</>
              }
            </button>
            {analysisError && <p className="text-xs text-red-400">{analysisError}</p>}

            <div className="space-y-2">
              <button
                onClick={() => setShowContext(v => !v)}
                className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-700 transition-colors w-full text-left"
              >
                <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${showContext ? 'rotate-180' : ''}`} />
                Paste Confirmations &amp; Notes
              </button>
              {showContext && (
                <ContextNotesEditor initialValue={contextNotes} onCommit={commitContextNotes} />
              )}
            </div>

            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Travel Documents</p>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                <label className="cursor-pointer group" onClick={e => e.stopPropagation()}>
                  <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 group-hover:border-slate-300 group-hover:bg-slate-50 transition-all">
                    <div className="aspect-square flex flex-col items-center justify-center gap-1.5">
                      {uploading
                        ? <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
                        : <>
                            <Plus className="w-6 h-6 text-slate-300 group-hover:text-slate-500 transition-colors" />
                            <span className="text-[10px] text-slate-400">Add file</span>
                          </>
                      }
                    </div>
                  </div>
                  <input type="file" multiple onChange={e => { Array.from(e.target.files || []).forEach(handleUpload); (e.target as HTMLInputElement).value = ''; }} className="hidden" disabled={uploading} />
                </label>
                {docs.map(d => {
                  const isImage = d.fileType?.startsWith('image/');
                  const DocIcon = isImage ? ImageIcon : d.fileType?.includes('pdf') ? FileText : File;
                  return (
                    <div key={d.id} className="bg-white rounded-xl border border-slate-100 shadow-sm">
                      <div
                        className={`aspect-square overflow-hidden rounded-t-xl cursor-pointer active:opacity-80 ${isImage ? 'bg-slate-100' : 'bg-slate-50 flex items-center justify-center'}`}
                        onClick={() => setPreview(d)}
                      >
                        {isImage
                          ? <img src={d.fileUrl} alt={d.fileName} className="w-full h-full object-cover" />
                          : <DocIcon className="w-9 h-9 text-slate-300" />
                        }
                      </div>
                      <div className="p-2">
                        <p className="text-[10px] font-medium text-slate-700 truncate">{d.fileName}</p>
                        <div className="flex items-center justify-end gap-1 mt-1">
                          <button onClick={() => handleDownload(d)} className="p-1 rounded hover:bg-slate-100 transition-colors"><Download className="w-3 h-3 text-slate-400" /></button>
                          <button onClick={() => handleDeleteDoc(d)} className="p-1 rounded hover:bg-red-50 transition-colors"><Trash2 className="w-3 h-3 text-red-300" /></button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {docs.length === 0 && !uploading && (
                <p className="text-xs text-slate-400">Upload boarding passes, hotel confirmations, or any travel docs here.</p>
              )}
            </div>

          </div>
        </div>

        {/* ── Right: Map ── */}
        {MAPS_KEY && (
          <div
            className={`${isDesktop ? 'flex-1 relative' : splitMode ? 'relative' : ''} bg-slate-100`}
            style={isDesktop ? { height: '100%' } : splitMode ? { height: '44svh' } : mapPanelStyle}
          >
            {uniqueDays.length > 0 && (
              <div
                className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-0.5 rounded-full px-1 py-1 border border-slate-200/80 shadow-md"
                style={{ background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
              >
                <button
                  onClick={() => filterByDay('all')}
                  className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wide transition-colors ${activeDay === 'all' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  All
                </button>
                {uniqueDays.map((day, i) => (
                  <button
                    key={day}
                    onClick={() => filterByDay(day)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wide transition-colors ${activeDay === day ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800'}`}
                  >
                    Day {i + 1}
                  </button>
                ))}
              </div>
            )}
            <div
              ref={mapDivRef}
              className="w-full bg-slate-200"
              style={{ height: mapDivHeight, minHeight: isDesktop ? '500px' : '300px' }}
            />
          </div>
        )}
      </div>

      {/* Doc preview modal */}
      {preview && (
        <div className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="absolute top-5 right-5">
            <div className="w-9 h-9 bg-white/10 rounded-full flex items-center justify-center">
              <X className="w-5 h-5 text-white" />
            </div>
          </div>
          <div className="absolute top-5 left-5 right-16">
            <p className="text-white/80 text-sm font-medium truncate">{preview.fileName}</p>
          </div>
          {preview.fileType?.startsWith('image/')
            ? <img src={preview.fileUrl} alt={preview.fileName} className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg shadow-2xl" onClick={e => e.stopPropagation()} />
            : preview.fileType?.includes('pdf')
              ? <div className="w-[92vw] h-[88vh] rounded-lg overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}><iframe src={`${preview.fileUrl}#toolbar=0`} className="w-full h-full border-0 bg-white" title={preview.fileName} /></div>
              : <div className="bg-white rounded-2xl p-8 text-center shadow-2xl max-w-sm" onClick={e => e.stopPropagation()}>
                  <File className="w-12 h-12 text-slate-400 mx-auto mb-3" />
                  <p className="font-medium text-slate-900 mb-1">{preview.fileName}</p>
                  <button onClick={() => handleDownload(preview)} className="mt-4 px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-medium hover:bg-slate-800 transition-colors">Download</button>
                </div>
          }
        </div>
      )}

      {/* Undo delete toast */}
      {pendingSegDeletes.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none">
          {Array.from(pendingSegDeletes.entries()).map(([id, { seg }]) => (
            <div key={id} className="pointer-events-auto flex items-center gap-4 bg-slate-900 text-white pl-4 pr-2 py-2.5 rounded-xl shadow-xl text-sm whitespace-nowrap">
              <span className="text-slate-300"><span className="text-white font-medium">"{seg.title}"</span> removed</span>
              <button onClick={() => undoDeleteSegment(id)} className="font-semibold text-amber-400 hover:text-amber-300 px-2 py-1 rounded-lg hover:bg-white/10 transition-colors">Undo</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
