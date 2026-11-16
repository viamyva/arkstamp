import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  onSnapshot, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { Plus, Trash2, Loader2, X, Check, Edit2 } from 'lucide-react';

interface ShoppingItem { id: string; text: string; quantity: string; category: string; completed: boolean; order: number; }

const SHOPPING_CATEGORIES = [
  'Produce', 'Dairy', 'Meat & Seafood', 'Bakery', 'Frozen',
  'Beverages', 'Snacks', 'Pantry', 'Household', 'Personal Care', 'Other',
];

// Sentence case: capitalise first letter, lowercase the rest
function toSentenceCase(s: string) {
  const t = s.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

// ── Swipeable shopping item: tap = toggle, left-swipe reveals edit + delete ──
function SwipeToDeleteItem({
  item, onToggle, onDelete, onEdit,
}: {
  item: ShoppingItem;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const [offsetX, setOffsetX] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const lockedRef = useRef<'h' | 'v' | null>(null);
  const didSwipeRef = useRef(false);
  const MAX_REVEAL = 144;
  const THRESHOLD = 80;

  const onPointerDown = (e: React.PointerEvent) => {
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    lockedRef.current = null;
    didSwipeRef.current = false;
    setSwiping(false);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (startXRef.current === null || startYRef.current === null) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;
    if (!lockedRef.current) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      lockedRef.current = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
    }
    if (lockedRef.current !== 'h') return;
    if (dx > 0) { setOffsetX(0); return; }
    e.preventDefault();
    didSwipeRef.current = true;
    setSwiping(true);
    setOffsetX(Math.max(dx, -MAX_REVEAL));
  };

  const onPointerUp = () => {
    if (didSwipeRef.current) {
      setOffsetX(Math.abs(offsetX) >= THRESHOLD ? -MAX_REVEAL : 0);
    }
    setSwiping(false);
    startXRef.current = null;
    startYRef.current = null;
    lockedRef.current = null;
  };

  const close = () => setOffsetX(0);
  const revealWidth = Math.abs(offsetX);

  return (
    <div className="relative overflow-hidden rounded-xl">
      <div className="absolute inset-y-0 right-0 flex items-stretch rounded-xl overflow-hidden" style={{ width: revealWidth }}>
        <button className="flex-1 flex items-center justify-center bg-slate-500 hover:bg-slate-600 transition-colors" style={{ opacity: revealWidth > 24 ? 1 : 0 }} onClick={() => { close(); onEdit(); }}>
          <Edit2 className="w-4 h-4 text-white" />
        </button>
        <button className="flex-1 flex items-center justify-center bg-red-500 hover:bg-red-600 transition-colors" style={{ opacity: revealWidth > 24 ? 1 : 0 }} onClick={() => { close(); onDelete(); }}>
          <Trash2 className="w-4 h-4 text-white" />
        </button>
      </div>
      <div
        className="relative flex items-center gap-3 bg-white px-4 py-3 shadow-sm border border-slate-100 rounded-xl touch-pan-y select-none"
        style={{ transform: `translateX(${offsetX}px)`, transition: swiping ? 'none' : 'transform 220ms ease' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => { if (!didSwipeRef.current) onToggle(); }}
      >
        <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all pointer-events-none ${item.completed ? 'bg-slate-900 border-slate-900' : 'border-slate-300'}`}>
          {item.completed && <Check className="w-3 h-3 text-white" />}
        </div>
        <div className="flex-1 min-w-0">
          <span className={`text-sm ${item.completed ? 'line-through text-slate-400' : 'text-slate-800'}`}>{item.text}</span>
          {item.quantity && (
            <div className="mt-0.5">
              <span className="text-xs text-slate-400">×{item.quantity}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ShoppingTabContentProps {
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

export function ShoppingContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: ShoppingTabContentProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ text: '', quantity: '', category: '' });
  const [saving, setSaving] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ text: '', quantity: '' });

  const col = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/items`;

  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(query(collection(db, col()), orderBy('order', 'asc')), snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() } as ShoppingItem)));
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  const sf = (f: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(p => ({ ...p, [f]: e.target.value }));

  const handleAdd = async () => {
    if (!user || !effectiveUid || !form.text.trim()) return;
    setSaving(true);
    await addDoc(collection(db, col()), {
      text: toSentenceCase(form.text),
      quantity: form.quantity.trim(),
      category: form.category.trim(),
      completed: false,
      order: items.length,
      createdAt: serverTimestamp(),
    });
    setForm({ text: '', quantity: '', category: '' });
    setShowForm(false);
    setSaving(false);
  };

  const startEdit = (item: ShoppingItem) => {
    setEditingId(item.id);
    setEditForm({ text: item.text, quantity: item.quantity ?? '' });
  };

  const saveEdit = async () => {
    if (!user || !effectiveUid || !editingId || !editForm.text.trim()) { setEditingId(null); return; }
    const newText = toSentenceCase(editForm.text);
    await updateDoc(fsDoc(db, col(), editingId), { text: newText, quantity: editForm.quantity.trim() });
    setEditingId(null);
  };

  const toggle = async (item: ShoppingItem) => {
    if (!user || !effectiveUid) return;
    await updateDoc(fsDoc(db, col(), item.id), { completed: !item.completed });
  };

  const remove = async (id: string) => {
    if (!user || !effectiveUid) return;
    await deleteDoc(fsDoc(db, col(), id));
  };

  const unchecked = items.filter(i => !i.completed);
  const checked = items.filter(i => i.completed);

  if (loading) return <Spinner />;

  return (
    <div className="max-w-xl space-y-4">
      <div className="space-y-2">
        {unchecked.map(item => (
          <SwipeToDeleteItem key={item.id} item={item} onToggle={() => toggle(item)} onDelete={() => remove(item.id)} onEdit={() => startEdit(item)} />
        ))}
        {unchecked.length > 0 && checked.length > 0 && <div className="border-t border-slate-200 my-1" />}
        {checked.map(item => (
          <SwipeToDeleteItem key={item.id} item={item} onToggle={() => toggle(item)} onDelete={() => remove(item.id)} onEdit={() => startEdit(item)} />
        ))}
      </div>

      {/* Inline edit modal */}
      {editingId && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-5" onClick={() => setEditingId(null)}>
          <div className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-2xl space-y-3" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-slate-900">Edit Item</p>
            <input autoFocus value={editForm.text} onChange={e => setEditForm(p => ({ ...p, text: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingId(null); }} placeholder="Item name" className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
            <input value={editForm.quantity} onChange={e => setEditForm(p => ({ ...p, quantity: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingId(null); }} placeholder="Quantity (e.g. 2, 1 lb)" className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
            <div className="flex gap-3">
              <button onClick={() => setEditingId(null)} className="flex-1 py-2.5 border border-slate-200 text-slate-600 text-sm rounded-xl hover:bg-slate-50 transition-colors">Cancel</button>
              <button onClick={saveEdit} disabled={!editForm.text.trim()} className="flex-1 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 disabled:opacity-30 transition-colors">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Add form */}
      {showForm ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Add Item</p>
            <button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4 text-slate-400" /></button>
          </div>
          <input ref={addRef} placeholder="Item name *" value={form.text} onChange={sf('text')} onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }} autoFocus className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Quantity (e.g. 2, 1 lb)" value={form.quantity} onChange={sf('quantity')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
            <select value={form.category} onChange={sf('category')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 bg-white text-slate-700">
              <option value="">Category</option>
              {SHOPPING_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <button onClick={handleAdd} disabled={!form.text.trim() || saving} className="w-full py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 disabled:opacity-30 transition-colors">
            {saving ? 'Adding...' : 'Add Item'}
          </button>
        </div>
      ) : (
        <button onClick={() => { setShowForm(true); setTimeout(() => addRef.current?.focus(), 50); }} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 transition-colors">
          <Plus className="w-4 h-4" />Add item
        </button>
      )}

      {items.length === 0 && !showForm && (
        <p className="text-center text-sm text-slate-400 pt-4">No items yet. Add your first shopping item above.</p>
      )}
    </div>
  );
}
