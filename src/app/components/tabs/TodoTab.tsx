import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db, functions } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  onSnapshot, getDoc, setDoc, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Plus, Trash2, Loader2, Check, CheckCheck, GripVertical, Sparkles } from 'lucide-react';

interface TodoItem { id: string; text: string; completed: boolean; order: number; }

interface TodoTabProps {
  chapterId: string;
  tabId: string;
  chapterTitle?: string;
  tabName?: string;
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

export function TodoContent({ chapterId, tabId, chapterTitle = '', tabName = '', ownerUid, refreshKey = 0 }: TodoTabProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [items, setItems] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const addRef = useRef<HTMLInputElement>(null);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const itemsRef = useRef<TodoItem[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // Maps a locally-generated temp id (used for optimistic inserts) to the
  // real Firestore doc id once it comes back, so writes still land correctly.
  const tempIdMap = useRef<Record<string, string>>({});
  const resolveId = (id: string) => tempIdMap.current[id] ?? id;

  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  useEffect(() => { editingIdRef.current = editingId; }, [editingId]);

  const colPath = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/items`;
  const tabDocPath = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}`;

  const [sortCheckedToBottom, setSortCheckedToBottom] = useState(true);

  const load = async () => {
    if (!user || !effectiveUid) return;
    try {
      const tabSnap = await getDoc(fsDoc(db, tabDocPath()));
      const val = tabSnap.data()?.todoSortCheckedToBottom;
      setSortCheckedToBottom(val === undefined ? true : !!val);
    } catch {
      // Default stays true if the setting can't be read.
    }
  };

  useEffect(() => { if (user && effectiveUid) load(); }, [tabId, user, effectiveUid, refreshKey]);

  // Live listener: edits from any window, or any other user on a shared deck,
  // land here in real time. If a row created via saveEditAndAddBelow is still
  // showing under its temp id (waiting on its own Firestore write), keep
  // showing it under that temp id so the row doesn't remount and steal focus.
  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(query(collection(db, colPath()), orderBy('order', 'asc')), snap => {
      const incoming = snap.docs.map(d => ({ id: d.id, ...d.data() } as TodoItem));
      const reverseTemp = new Map<string, string>();
      for (const [tempId, realId] of Object.entries(tempIdMap.current)) {
        if (editingIdRef.current === tempId) reverseTemp.set(realId, tempId);
      }
      setItems(incoming.map(it => {
        const displayId = reverseTemp.get(it.id);
        return displayId ? { ...it, id: displayId } : it;
      }));
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  const addItem = async () => {
    if (!user || !effectiveUid || !addRef.current?.value.trim()) return;
    const text = addRef.current.value.trim();
    addRef.current.value = '';
    if (sortCheckedToBottom) {
      // Insert new item just before the first completed item so unchecked
      // items always stay above completed ones.
      const firstCheckedOrder = items.find(i => i.completed)?.order ?? items.length;
      const newOrder = firstCheckedOrder;
      // Shift all completed items down by 1 to make room
      const toShift = items.filter(i => i.completed);
      await Promise.all(toShift.map(i =>
        updateDoc(fsDoc(db, colPath(), i.id), { order: i.order + 1 }).catch(console.error)
      ));
      await addDoc(collection(db, colPath()), {
        text, completed: false, order: newOrder, createdAt: serverTimestamp(),
      });
    } else {
      // Sorting is off, so just append the new item at the end.
      await addDoc(collection(db, colPath()), {
        text, completed: false, order: items.length, createdAt: serverTimestamp(),
      });
    }
  };

  const toggleSortCheckedToBottom = async () => {
    if (!user || !effectiveUid) return;
    const next = !sortCheckedToBottom;
    setSortCheckedToBottom(next);
    await setDoc(fsDoc(db, tabDocPath()), { todoSortCheckedToBottom: next }, { merge: true }).catch(console.error);
  };

  const toggle = async (item: TodoItem) => {
    if (!user || !effectiveUid) return;
    const next = !item.completed;
    // Update local state immediately with the resolved value (not a flip of
    // whatever's in state at write-time) so it can't collide with the live
    // onSnapshot listener, which was otherwise re-flipping the checkbox back
    // once the write round-tripped -- the cause of the double-click bug.
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, completed: next } : i));
    try {
      await updateDoc(fsDoc(db, colPath(), resolveId(item.id)), { completed: next });
    } catch (err) { console.error(err); }
  };

  const allChecked = items.length > 0 && items.every(i => i.completed);
  const toggleAll = async () => {
    if (!user || !effectiveUid || items.length === 0) return;
    const next = !allChecked;
    setItems(prev => prev.map(i => ({ ...i, completed: next })));
    await Promise.all(items.map(i =>
      updateDoc(fsDoc(db, colPath(), resolveId(i.id)), { completed: next }).catch(console.error)
    ));
  };

  const remove = async (id: string) => {
    if (!user || !effectiveUid) return;
    await deleteDoc(fsDoc(db, colPath(), resolveId(id)));
    setItems(prev => prev.filter(i => i.id !== id));
  };

  const [editValue, setEditValue] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

  const startEdit = (item: TodoItem) => {
    setEditingId(item.id);
    setEditValue(item.text);
    setTimeout(() => editRef.current?.focus(), 0);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue('');
  };

  const saveEdit = async () => {
    const id = editingId;
    const text = editValue.trim();
    setEditingId(null);
    setEditValue('');
    if (!id || !user || !effectiveUid) return;
    const original = itemsRef.current.find(i => i.id === id);
    if (!text || text === original?.text) return;
    setItems(prev => prev.map(i => i.id === id ? { ...i, text } : i));
    await updateDoc(fsDoc(db, colPath(), resolveId(id)), { text }).catch(console.error);
  };

  // Pressing Enter while editing saves the current item and inserts a fresh
  // blank item right below it (in whatever order is currently on screen).
  // The new row shows up and grabs focus immediately; the Firestore writes
  // happen in the background so typing never waits on a network round trip.
  const saveEditAndAddBelow = () => {
    const id = editingId;
    const text = editValue.trim();
    if (!id || !user || !effectiveUid) { setEditingId(null); setEditValue(''); return; }

    const original = itemsRef.current.find(i => i.id === id);
    const finalText = text || original?.text || '';
    if (text && text !== original?.text) {
      updateDoc(fsDoc(db, colPath(), resolveId(id)), { text }).catch(console.error);
    }

    const baseItems = itemsRef.current.map(i => i.id === id ? { ...i, text: finalText } : i);
    const currentOrdered = sortCheckedToBottom
      ? [...baseItems.filter(i => !i.completed), ...baseItems.filter(i => i.completed)]
      : baseItems;
    const idx = currentOrdered.findIndex(i => i.id === id);
    if (idx === -1) { setEditingId(null); setEditValue(''); return; }

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newItem: TodoItem = { id: tempId, text: '', completed: false, order: currentOrdered.length };
    const reordered = [...currentOrdered];
    reordered.splice(idx + 1, 0, newItem);
    const finalItems = reordered.map((it, i) => ({ ...it, order: i }));

    setItems(finalItems);
    setEditingId(tempId);
    setEditValue('');
    setTimeout(() => editRef.current?.focus(), 0);

    addDoc(collection(db, colPath()), {
      text: '', completed: false, order: newItem.order, createdAt: serverTimestamp(),
    }).then(newDoc => {
      tempIdMap.current[tempId] = newDoc.id;
      return Promise.all(
        finalItems.map(it => updateDoc(fsDoc(db, colPath(), resolveId(it.id)), { order: it.order }).catch(console.error))
      );
    }).catch(console.error);
  };

  const saveOrder = async (ordered: TodoItem[]) => {
    if (!user || !effectiveUid) return;
    await Promise.all(
      ordered.map((item, i) =>
        updateDoc(fsDoc(db, colPath(), resolveId(item.id)), { order: i }).catch(console.error)
      )
    );
  };

  const startDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    e.preventDefault();
    draggingRef.current = true;
    setDraggingId(id);

    const handleMove = (ev: PointerEvent) => {
      if (!listRef.current) return;
      const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-todo-id]'));
      let newIndex = rows.length - 1;
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) { newIndex = i; break; }
      }
      setItems(prev => {
        const oldIndex = prev.findIndex(t => t.id === id);
        if (oldIndex === newIndex) return prev;
        const next = [...prev];
        const [item] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, item);
        return next;
      });
    };

    const handleEnd = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleEnd);
      document.removeEventListener('pointercancel', handleEnd);
      draggingRef.current = false;
      setDraggingId(null);
      saveOrder(itemsRef.current);
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleEnd);
    document.addEventListener('pointercancel', handleEnd);
  }, []);

  const generateAiTasks = async () => {
    if (!user) return;
    setAiLoading(true);
    setAiError('');
    try {
      const existingTasks = items
        .filter(i => i.text.trim())
        .map(i => `- ${i.text}${i.completed ? ' (done)' : ''}`)
        .join('\n');

      const context = [
        chapterTitle ? `Deck: "${chapterTitle}"` : '',
        tabName ? `Tab: "${tabName}"` : '',
        existingTasks ? `Existing tasks:\n${existingTasks}` : '',
      ].filter(Boolean).join('\n');

      const prompt =
        `You are helping a user build a to-do list for their planning deck.\n\n` +
        `${context}\n\n` +
        `RULES — follow exactly:\n` +
        `1. Suggest 3-6 NEW tasks not already in the list above.\n` +
        `2. Base suggestions ONLY on the deck name, tab name, and existing tasks — no generic advice.\n` +
        `3. Each task must be a short, concrete, actionable item (under 10 words).\n` +
        `4. Do NOT repeat or rephrase existing tasks.\n` +
        `5. Do NOT add filler like "Review progress" or "Stay organized".\n\n` +
        `Respond with JSON in this exact format:\n` +
        `{"chapter":{"cards":[{"title":"Tasks","category":"AI","items":["task 1","task 2","task 3"]}]}}`;

      const generate = httpsCallable(functions, 'generateChapter');
      const result = await generate({ prompt }) as any;
      const aiItems: string[] = result?.data?.chapter?.cards?.[0]?.items ?? [];

      if (aiItems.length === 0) { setAiError('No suggestions returned.'); return; }

      let order = items.length;
      for (const text of aiItems) {
        if (!text.trim()) continue;
        await addDoc(collection(db, colPath()), {
          text: text.trim(), completed: false, order: order++, createdAt: serverTimestamp(),
        });
      }
    } catch (err: any) {
      setAiError(err?.message?.replace('Firebase: ', '') ?? 'Failed to generate tasks.');
    } finally {
      setAiLoading(false);
    }
  };

  if (loading) return <Spinner />;

  const done = items.filter(i => i.completed).length;
  // When the toggle is on, unchecked items render above completed ones,
  // regardless of the underlying order field. When it's off, items render
  // strictly by the order field, so a checked item stays in its last spot.
  const orderedItems = sortCheckedToBottom
    ? [...items.filter(i => !i.completed), ...items.filter(i => i.completed)]
    : items;

  return (
    <div className="max-w-xl">
      <div className="flex items-center justify-between mb-3 min-h-[20px]">
        <span className="text-xs text-slate-400">
          {items.length > 0 ? `${done} of ${items.length} completed` : ''}
        </span>
        <div className="flex items-center gap-2">
          {aiError && <span className="text-xs text-red-400">{aiError}</span>}
          <button
            onClick={toggleAll}
            disabled={items.length === 0}
            title={allChecked ? 'Uncheck all' : 'Check all'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-500 bg-white border border-slate-200 rounded-xl hover:border-slate-400 hover:text-slate-900 transition-all disabled:opacity-40 shadow-sm"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            {allChecked ? 'Uncheck all' : 'Check all'}
          </button>
          <button
            onClick={toggleSortCheckedToBottom}
            title="Move checked items to the bottom"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-500 bg-white border border-slate-200 rounded-xl hover:border-slate-400 hover:text-slate-900 transition-all shadow-sm"
          >
            <span
              className={`relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors ${
                sortCheckedToBottom ? 'bg-slate-900' : 'bg-slate-200'
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                  sortCheckedToBottom ? 'translate-x-3.5' : 'translate-x-0.5'
                }`}
              />
            </span>
            Sort checked to bottom
          </button>
          <button
            onClick={generateAiTasks}
            disabled={aiLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-500 bg-white border border-slate-200 rounded-xl hover:border-slate-400 hover:text-slate-900 transition-all disabled:opacity-40 shadow-sm"
          >
            {aiLoading
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Sparkles className="w-3 h-3 text-amber-500" />
            }
            {aiLoading ? 'Thinking…' : 'AI Suggest'}
          </button>
        </div>
      </div>
      <div ref={listRef} className="space-y-2">
        {orderedItems.map(item => (
          <div
            key={item.id}
            data-todo-id={item.id}
            className={`flex items-center gap-3 bg-white rounded-xl px-4 py-3 shadow-sm border border-slate-100 group transition-opacity ${draggingId === item.id ? 'opacity-40' : ''}`}
          >
            <button
              className="p-1 touch-none cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 transition-colors flex-shrink-0"
              onPointerDown={e => startDrag(e, item.id)}
              title="Drag to reorder"
            >
              <GripVertical className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => toggle(item)}
              className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all ${
                item.completed ? 'bg-slate-900 border-slate-900' : 'border-slate-300 hover:border-slate-500'
              }`}
            >
              {item.completed && <Check className="w-3 h-3 text-white" />}
            </button>
            {editingId === item.id ? (
              <input
                ref={editRef}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onBlur={saveEdit}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); saveEditAndAddBelow(); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                }}
                className="flex-1 text-sm text-slate-800 bg-transparent focus:outline-none border-b border-slate-300"
              />
            ) : (
              <span
                onClick={() => startEdit(item)}
                className={`flex-1 text-sm cursor-text ${item.completed ? 'line-through text-slate-400' : 'text-slate-800'}`}
              >
                {item.text}
              </span>
            )}
            <button onClick={() => remove(item.id)} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 transition-all">
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 bg-white rounded-xl px-4 py-3 shadow-sm border border-dashed border-slate-200">
        <div className="w-5 h-5 rounded-full border-2 border-slate-200 flex-shrink-0" />
        <input
          ref={addRef}
          placeholder="Add an item..."
          onKeyDown={e => { if (e.key === 'Enter') addItem(); }}
          className="flex-1 text-sm text-slate-800 placeholder-slate-400 bg-transparent focus:outline-none"
        />
        <button onClick={addItem} className="p-1 rounded hover:bg-slate-100 transition-colors">
          <Plus className="w-4 h-4 text-slate-400" />
        </button>
      </div>
      {items.length === 0 && (
        <p className="text-center text-sm text-slate-400 pt-4">Add your first task above</p>
      )}
    </div>
  );
}
