import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { Plus, Trash2, Loader2, X, Check, Edit2, Calendar as CalendarIcon, Clock, GripVertical, TrendingUp, ArrowUpDown } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '../ui/chart';

interface EventLogEntry { id: string; date: string; time: string; text: string; order: number; }
type ELSort = null | 'date_asc' | 'date_desc';

function fmtELDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  const now = new Date();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
function fmtGraphDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtELTime(t: string): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function nowHHMM(): string { const n = new Date(); return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`; }

interface EventLogTabContentProps {
  chapterId: string;
  tabId: string;
  ownerUid?: string;
  refreshKey?: number;
}

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
    </div>
  );
}

export function EventLogContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: EventLogTabContentProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [entries, setEntries] = useState<EventLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortMode, setSortMode] = useState<ELSort>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');
  const [editText, setEditText] = useState('');
  const [quickMode, setQuickMode] = useState<'date' | 'datetime' | null>(null);
  const [quickDate, setQuickDate] = useState('');
  const [quickTime, setQuickTime] = useState('');
  const [quickText, setQuickText] = useState('');
  const quickRef = useRef<HTMLInputElement>(null);
  const [addingRow, setAddingRow] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState('');
  const [newText, setNewText] = useState('');
  const entriesRef = useRef<EventLogEntry[]>([]);

  // Drag state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragDelta, setDragDelta] = useState(0);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragRef2 = useRef<{ id: string; startY: number; startIndex: number; rowSpan: number; originalCenters: number[] } | null>(null);
  const dragOverRef2 = useRef<number | null>(null);
  const listRef2 = useRef<HTMLDivElement>(null);

  const col = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/entries`;

  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(query(collection(db, col()), orderBy('order', 'asc')), snap => {
      const loaded = snap.docs.map(d => ({ id: d.id, ...d.data() } as EventLogEntry));
      setEntries(loaded); entriesRef.current = loaded; setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  const saveELOrder = async (ordered: EventLogEntry[]) => {
    if (!user) return;
    const batch = writeBatch(db);
    ordered.forEach((e, i) => batch.update(fsDoc(db, col(), e.id), { order: i }));
    await batch.commit().catch(console.error);
  };

  const sorted = useMemo(() => {
    if (!sortMode) return [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (sortMode === 'date_asc') return [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    return [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  }, [entries, sortMode]);

  const graphData = useMemo(() => {
    const sortedEntries = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    const dataMap: Record<string, { date: string; value: number }> = {};
    sortedEntries.forEach(e => {
      const numValue = parseFloat(e.text);
      if (!isNaN(numValue)) { dataMap[e.date] = { date: e.date, value: numValue }; }
    });
    return Object.values(dataMap).sort((a, b) => a.date.localeCompare(b.date));
  }, [entries]);

  const yAxisRange = useMemo(() => {
    if (graphData.length === 0) return { min: 0, max: 100 };
    const values = graphData.map(d => d.value);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal;
    const padding = range * 0.1;
    return { min: Math.floor((minVal - padding) * 10) / 10, max: Math.ceil((maxVal + padding) * 10) / 10 };
  }, [graphData]);

  const openQuick = (mode: 'date' | 'datetime') => {
    setQuickMode(mode); setQuickDate(todayISO()); setQuickTime(mode === 'datetime' ? nowHHMM() : ''); setQuickText('');
    setTimeout(() => quickRef.current?.focus(), 60);
  };

  const saveQuick = async () => {
    if (!user || !quickText.trim()) { setQuickMode(null); return; }
    const maxOrder = entries.length > 0 ? Math.max(...entries.map(e => e.order ?? 0)) + 1 : 0;
    await addDoc(collection(db, col()), { date: quickDate, time: quickTime, text: quickText.trim(), order: maxOrder, createdAt: serverTimestamp() });
    setQuickMode(null);
  };

  const saveRow = async () => {
    if (!user) return;
    const maxOrder = entries.length > 0 ? Math.max(...entries.map(e => e.order ?? 0)) + 1 : 0;
    await addDoc(collection(db, col()), { date: newDate, time: newTime, text: newText.trim(), order: maxOrder, createdAt: serverTimestamp() });
    setAddingRow(false); setNewDate(''); setNewTime(''); setNewText('');
  };

  const openEdit = (e: EventLogEntry) => { setEditingId(e.id); setEditDate(e.date); setEditTime(e.time); setEditText(e.text); };
  const saveEdit = async (id: string) => {
    if (!user) return;
    await updateDoc(fsDoc(db, col(), id), { date: editDate, time: editTime, text: editText.trim() });
    setEditingId(null);
  };
  const handleELDelete = async (id: string) => {
    if (!user) return;
    await deleteDoc(fsDoc(db, col(), id));
  };

  const startELDrag = (id: string, startY: number) => {
    if (!listRef2.current || sortMode !== null) return;
    const rows = Array.from(listRef2.current.querySelectorAll<HTMLElement>('[data-el-id]'));
    const si = rows.findIndex(r => r.getAttribute('data-el-id') === id);
    if (si === -1) return;
    const rowSpan = rows[si].getBoundingClientRect().height + 1;
    const oc = rows.map(r => { const rect = r.getBoundingClientRect(); return rect.top + rect.height / 2; });
    dragRef2.current = { id, startY, startIndex: si, rowSpan, originalCenters: oc };
    dragOverRef2.current = si;
    setDraggingId(id); setDragDelta(0); setDragOverIndex(si);

    const mv = (e: PointerEvent) => {
      if (!dragRef2.current) return;
      const delta = e.clientY - dragRef2.current.startY;
      setDragDelta(delta);
      const cy = oc[si] + delta;
      let best = si, md = Infinity;
      for (let i = 0; i < oc.length; i++) { const d = Math.abs(cy - oc[i]); if (d < md) { md = d; best = i; } }
      setDragOverIndex(best); dragOverRef2.current = best;
    };
    const blk = (e: TouchEvent) => e.preventDefault();
    const up = () => {
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('touchmove', blk);
      const ti = dragOverRef2.current;
      const csi = dragRef2.current?.startIndex ?? -1;
      const cid = dragRef2.current?.id;
      dragRef2.current = null; dragOverRef2.current = null;
      setDragDelta(0); setDraggingId(null); setDragOverIndex(null);
      if (ti !== null && csi !== -1 && ti !== csi && cid) {
        setEntries(prev => {
          const base = [...prev].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          const [item] = base.splice(csi, 1);
          base.splice(ti, 0, item);
          saveELOrder(base);
          entriesRef.current = base;
          return base;
        });
      }
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('touchmove', blk, { passive: false });
  };

  const getELShift = (index: number): number => {
    if (!draggingId || dragOverIndex === null || !dragRef2.current) return 0;
    const { startIndex, rowSpan } = dragRef2.current;
    const oi = dragOverIndex;
    if (oi === startIndex) return 0;
    if (oi > startIndex && index > startIndex && index <= oi) return -rowSpan;
    if (oi < startIndex && index >= oi && index < startIndex) return rowSpan;
    return 0;
  };

  if (loading) return <Spinner />;

  return (
    <div className="max-w-2xl space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button onClick={() => openQuick('date')} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 transition-colors">
            <CalendarIcon className="w-3.5 h-3.5" />Today
          </button>
          <button onClick={() => openQuick('datetime')} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors">
            <Clock className="w-3.5 h-3.5" />Now
          </button>
          <button
            onClick={() => setShowGraph(!showGraph)}
            className={`inline-flex items-center justify-center w-8 h-8 rounded-xl transition-colors ${showGraph ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
            title="Toggle Graph"
          >
            <TrendingUp className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setSortMode(s => s === 'date_desc' ? 'date_asc' : 'date_desc')}
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl font-medium transition-colors ${sortMode?.startsWith('date') ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
            {sortMode === 'date_asc' ? 'Oldest First' : 'Newest First'}
          </button>
        </div>
      </div>

      {/* Graph */}
      {showGraph && graphData.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 mb-4">
          <div className="h-64 w-full">
            <ChartContainer config={{ value: { label: 'Value', color: '#0f172a' } }}>
              <LineChart data={graphData} margin={{ top: 5, right: 30, left: 0, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10, angle: -45, textAnchor: 'end', height: 80 }} tickFormatter={fmtGraphDate} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} domain={[yAxisRange.min, yAxisRange.max]} />
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Line type="monotone" dataKey="value" stroke="#0f172a" strokeWidth={2} dot={{ fill: '#0f172a', r: 3 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ChartContainer>
          </div>
        </div>
      )}

      {/* Quick-add inline row */}
      {quickMode && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-wrap gap-2 items-end">
          <div className="flex gap-2 flex-wrap flex-1 min-w-0">
            <input type="date" value={quickDate} onChange={e => setQuickDate(e.target.value)} className="px-2.5 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            {quickMode === 'datetime' && <input type="time" value={quickTime} onChange={e => setQuickTime(e.target.value)} className="px-2.5 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />}
            <input ref={quickRef} value={quickText} onChange={e => setQuickText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveQuick(); if (e.key === 'Escape') setQuickMode(null); }} placeholder="What happened..." className="flex-1 min-w-[160px] px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          </div>
          <div className="flex gap-2">
            <button onClick={saveQuick} disabled={!quickText.trim()} className="px-4 py-2 bg-slate-900 text-white text-xs font-semibold rounded-xl hover:bg-slate-800 disabled:opacity-30 transition-colors">Save</button>
            <button onClick={() => setQuickMode(null)} className="px-3 py-2 text-xs text-slate-500 hover:text-slate-900 transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {/* Table */}
      {entries.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="grid px-4 py-2 bg-slate-50 border-b border-slate-100" style={{ gridTemplateColumns: '24px 90px 70px 1fr 64px', gap: '8px' }}>
            <div /><p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Date</p>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Time</p>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Event</p>
            <div />
          </div>
          <div ref={listRef2}>
            {sorted.map((entry, index) => {
              const isDragging = draggingId === entry.id;
              const shift = isDragging ? 0 : getELShift(index);
              return (
                <div
                  key={entry.id}
                  data-el-id={entry.id}
                  style={{ transform: isDragging ? `translateY(${dragDelta}px)` : shift !== 0 ? `translateY(${shift}px)` : undefined, transition: isDragging ? 'none' : draggingId ? 'transform 180ms ease' : 'none', position: isDragging ? 'relative' : undefined, zIndex: isDragging ? 10 : undefined }}
                  className={`border-b border-slate-50 last:border-0 group ${isDragging ? 'shadow-lg bg-white' : ''}`}
                >
                  {editingId === entry.id ? (
                    <div className="grid px-4 py-2.5 bg-slate-50/50 items-center gap-2" style={{ gridTemplateColumns: '24px 90px 70px 1fr 64px' }}>
                      <div />
                      <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} className="px-2 py-1.5 rounded-lg border border-slate-200 text-xs focus:outline-none focus:border-slate-900 w-full" />
                      <input type="time" value={editTime} onChange={e => setEditTime(e.target.value)} className="px-2 py-1.5 rounded-lg border border-slate-200 text-xs focus:outline-none focus:border-slate-900 w-full" />
                      <input value={editText} onChange={e => setEditText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveEdit(entry.id); if (e.key === 'Escape') setEditingId(null); }} autoFocus className="px-2 py-1.5 rounded-lg border border-slate-200 text-xs focus:outline-none focus:border-slate-900 w-full" />
                      <div className="flex gap-1">
                        <button onClick={() => saveEdit(entry.id)} className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 transition-colors"><Check className="w-3 h-3 text-white" /></button>
                        <button onClick={() => setEditingId(null)} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"><X className="w-3 h-3 text-slate-400" /></button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid px-4 py-3 items-center gap-2" style={{ gridTemplateColumns: '24px 90px 70px 1fr 64px' }}>
                      <button className="p-0.5 touch-none cursor-grab active:cursor-grabbing text-slate-200 hover:text-slate-400 transition-colors" onPointerDown={e => { e.preventDefault(); startELDrag(entry.id, e.clientY); }} title="Drag to reorder">
                        <GripVertical className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-sm text-slate-700 font-medium leading-snug">{fmtELDate(entry.date)}</span>
                      <span className="text-sm text-slate-400">{fmtELTime(entry.time)}</span>
                      <span className="text-sm text-slate-900 leading-snug">{entry.text}</span>
                      <div className="flex items-center gap-0.5 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                        <button onClick={() => openEdit(entry)} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"><Edit2 className="w-3.5 h-3.5 text-slate-400" /></button>
                        <button onClick={() => handleELDelete(entry.id)} className="p-1.5 rounded-lg hover:bg-red-50 transition-colors"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {entries.length === 0 && !quickMode && <p className="text-center text-sm text-slate-400 py-6">No entries yet. Use the buttons above to log an event.</p>}

      {/* Add row manually */}
      {addingRow ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-900">Add Entry</p><button onClick={() => setAddingRow(false)} className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4 text-slate-400" /></button></div>
          <div className="grid grid-cols-2 gap-2">
            <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} className="px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            <input type="time" value={newTime} onChange={e => setNewTime(e.target.value)} className="px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          </div>
          <input value={newText} onChange={e => setNewText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveRow(); }} placeholder="What happened..." autoFocus className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          <button onClick={saveRow} disabled={!newText.trim()} className="w-full py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 disabled:opacity-30 transition-colors">Add Entry</button>
        </div>
      ) : (
        <button onClick={() => setAddingRow(true)} className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900 border border-slate-200 hover:border-slate-400 bg-white px-3 py-1.5 rounded-lg transition-all">
          <Plus className="w-3.5 h-3.5" />Add row
        </button>
      )}
    </div>
  );
}
