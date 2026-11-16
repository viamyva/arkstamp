import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  onSnapshot, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { Plus, Trash2, Loader2, X, GripVertical, Tag, Pencil } from 'lucide-react';

interface InventoryItem { id: string; name: string; category: string; quantity: number; location: string; value: string; notes: string; order: number; }
const EMPTY_INV = { name: '', category: '', quantity: '1', location: '', value: '', notes: '' };

interface InventoryTabContentProps {
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

export function InventoryContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: InventoryTabContentProps) {
  // NOTE: ghostTargetUid was referenced in the original code but does not exist
  // in AuthContext. The correct pattern is ownerUid (passed from ChapterDetail
  // when viewing a shared deck), which already covers ghost mode via ChapterDetail.
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_INV);
  const [saving, setSaving] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_INV);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTouchIdx = useRef<number | null>(null);

  const col = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/items`;

  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(query(collection(db, col()), orderBy('order', 'asc')), snap => {
      const loaded = snap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryItem));
      loaded.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      setItems(loaded);
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  const sf = (f: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm(p => ({ ...p, [f]: e.target.value }));
  const sef = (f: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setEditForm(p => ({ ...p, [f]: e.target.value }));

  const handleAdd = async () => {
    if (!user || !form.name.trim()) return;
    setSaving(true);
    const maxOrder = items.reduce((m, i) => Math.max(m, i.order ?? 0), -1);
    await addDoc(collection(db, col()), {
      name: form.name.trim(), category: form.category.trim(),
      quantity: parseInt(form.quantity, 10) || 1,
      location: form.location.trim(), value: form.value.trim(),
      notes: form.notes.trim(), order: maxOrder + 1, createdAt: serverTimestamp(),
    });
    setForm(EMPTY_INV); setShowForm(false); setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!user) return;
    await deleteDoc(fsDoc(db, col(), id));
  };

  const handleQty = async (item: InventoryItem, delta: number) => {
    const newQty = Math.max(0, (item.quantity || 0) + delta);
    await updateDoc(fsDoc(db, col(), item.id), { quantity: newQty });
  };

  const openEdit = (item: InventoryItem) => {
    setEditingItem(item);
    setEditForm({ name: item.name, category: item.category || '', quantity: String(item.quantity || 1), location: item.location || '', value: item.value || '', notes: item.notes || '' });
  };

  const handleEdit = async () => {
    if (!editingItem || !editForm.name.trim()) return;
    setSaving(true);
    await updateDoc(fsDoc(db, col(), editingItem.id), {
      name: editForm.name.trim(), category: editForm.category.trim(),
      quantity: parseInt(editForm.quantity, 10) || 1,
      location: editForm.location.trim(), value: editForm.value.trim(), notes: editForm.notes.trim(),
    });
    setEditingItem(null); setSaving(false);
  };

  const commitReorder = async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const reordered = [...items];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const updated = reordered.map((item, i) => ({ ...item, order: i }));
    setItems(updated);
    setDragIndex(null); setDragOverIndex(null);
    await Promise.all(updated.map(item => updateDoc(fsDoc(db, col(), item.id), { order: item.order })));
  };

  const handleDragStart = (idx: number) => setDragIndex(idx);
  const handleDragOver = (e: React.DragEvent, idx: number) => { e.preventDefault(); setDragOverIndex(idx); };
  const handleDrop = async (e: React.DragEvent, idx: number) => { e.preventDefault(); if (dragIndex === null) return; await commitReorder(dragIndex, idx); };

  const handleTouchStart = (e: React.TouchEvent, idx: number) => {
    e.stopPropagation();
    activeTouchIdx.current = idx;
    touchTimer.current = setTimeout(() => { setDragIndex(idx); }, 200);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (dragIndex === null) {
      if (touchTimer.current) { clearTimeout(touchTimer.current); touchTimer.current = null; }
      return;
    }
    e.preventDefault();
    const touch = e.touches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const row = el?.closest('[data-inv-idx]') as HTMLElement | null;
    if (row) {
      const overIdx = parseInt(row.dataset.invIdx ?? '-1', 10);
      if (overIdx >= 0) setDragOverIndex(overIdx);
    }
  };
  const handleTouchEnd = async () => {
    if (touchTimer.current) { clearTimeout(touchTimer.current); touchTimer.current = null; }
    if (dragIndex !== null && dragOverIndex !== null) {
      await commitReorder(dragIndex, dragOverIndex);
    } else {
      setDragIndex(null); setDragOverIndex(null);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="max-w-2xl space-y-3">
      {items.map((item, idx) => (
        <div
          key={item.id}
          data-inv-idx={idx}
          draggable
          onDragStart={() => handleDragStart(idx)}
          onDragOver={e => handleDragOver(e, idx)}
          onDrop={e => handleDrop(e, idx)}
          onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
          className={`bg-white rounded-2xl border shadow-sm p-4 flex items-center gap-3 group transition-all select-none ${dragOverIndex === idx ? 'border-slate-400 scale-[1.01]' : 'border-slate-100'} ${dragIndex === idx ? 'opacity-50' : ''}`}
        >
          <span
            className="w-6 h-8 flex items-center justify-center flex-shrink-0 cursor-grab active:cursor-grabbing touch-none select-none"
            style={{ WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' } as React.CSSProperties}
            onTouchStart={e => handleTouchStart(e, idx)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <GripVertical className={`w-4 h-4 transition-colors ${dragIndex === idx ? 'text-slate-600' : 'text-slate-300 group-hover:text-slate-400'}`} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate">{item.name}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
              {item.category && <span className="text-xs text-slate-400">{item.category}</span>}
              {item.location && <span className="text-xs text-slate-500 flex items-center gap-0.5"><Tag className="w-3 h-3" />{item.location}</span>}
              {item.value && <span className="text-xs text-slate-400">{item.value}</span>}
            </div>
            {item.notes && <p className="text-xs text-slate-400 mt-0.5 truncate">{item.notes}</p>}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={() => handleQty(item, -1)} className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors text-slate-600 font-bold text-sm">-</button>
            <span className="w-8 text-center text-sm font-semibold text-slate-800">{item.quantity}</span>
            <button onClick={() => handleQty(item, 1)} className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors text-slate-600 font-bold text-sm">+</button>
          </div>
          <button onClick={() => openEdit(item)} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-slate-100 transition-all flex-shrink-0"><Pencil className="w-3.5 h-3.5 text-slate-400" /></button>
          <button onClick={() => handleDelete(item.id)} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-50 transition-all flex-shrink-0"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
        </div>
      ))}
      {items.length === 0 && !showForm && <p className="text-center text-sm text-slate-400 pt-4">No items yet</p>}
      {showForm ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-900">Add Item</p><button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4 text-slate-400" /></button></div>
          <input placeholder="Item name *" value={form.name} onChange={sf('name')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Category" value={form.category} onChange={sf('category')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            <input type="number" min="1" placeholder="Qty" value={form.quantity} onChange={sf('quantity')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Location / Box" value={form.location} onChange={sf('location')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            <input placeholder="Est. value" value={form.value} onChange={sf('value')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          </div>
          <input placeholder="Notes" value={form.notes} onChange={sf('notes')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          <button onClick={handleAdd} disabled={!form.name.trim() || saving} className="w-full py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 disabled:opacity-30 transition-colors">{saving ? 'Adding...' : 'Add Item'}</button>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 transition-colors"><Plus className="w-4 h-4" />Add item</button>
      )}
      {editingItem && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setEditingItem(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-900">Edit Item</p><button onClick={() => setEditingItem(null)} className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4 text-slate-400" /></button></div>
            <input placeholder="Item name *" value={editForm.name} onChange={sef('name')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Category" value={editForm.category} onChange={sef('category')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
              <input type="number" min="1" placeholder="Qty" value={editForm.quantity} onChange={sef('quantity')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Location / Box" value={editForm.location} onChange={sef('location')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
              <input placeholder="Est. value" value={editForm.value} onChange={sef('value')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            </div>
            <input placeholder="Notes" value={editForm.notes} onChange={sef('notes')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            <div className="flex gap-2 pt-1">
              <button onClick={() => { handleDelete(editingItem.id); setEditingItem(null); }} className="px-4 py-2.5 text-red-500 text-sm font-medium rounded-xl hover:bg-red-50 transition-colors">Delete</button>
              <button onClick={handleEdit} disabled={!editForm.name.trim() || saving} className="flex-1 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 disabled:opacity-30 transition-colors">{saving ? 'Saving...' : 'Save Changes'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
