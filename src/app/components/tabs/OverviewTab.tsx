import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db, functions, storage } from '../../../lib/firebase';
import { doc, updateDoc, deleteDoc, addDoc, collection, getDocs, query, orderBy, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { Plus, Check, X, ChevronDown, Trash2, GripVertical, Sparkles, Loader2, Camera, AlignLeft, Image as ImageIcon } from 'lucide-react';

interface CardItem { id: string; text: string; completed: boolean; }
interface Card { id: string; category: string; title: string; items: CardItem[]; order: number; type?: 'checklist' | 'photo' | 'notes'; photoUrl?: string; notesText?: string; }
interface PendingDelete { title: string; timer: ReturnType<typeof setTimeout>; }
interface CustomTab { id: string; name: string; template: string; order: number; }
interface OverviewTabProps {
  chapterId: string;
  ownerUid?: string;
  cards: Card[];
  customTabs?: CustomTab[];
  chapterTitle?: string;
  onRefresh: () => void;
}

export function OverviewTab({ chapterId, ownerUid, cards, customTabs = [], chapterTitle = '', onRefresh }: OverviewTabProps) {
  const { user } = useAuth();
  const [pendingDeletes, setPendingDeletes] = useState<Map<string, PendingDelete>>(new Map());

  // ── Add Card state ──────────────────────────────────────────
  const [isAddingCard, setIsAddingCard] = useState(false);
  const cardInputRef = useRef<HTMLInputElement>(null);

  // ── Add Photo state ─────────────────────────────────────────
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // ── Add Notes state ─────────────────────────────────────────
  const [isAddingNotes, setIsAddingNotes] = useState(false);
  const notesTitleRef = useRef<HTMLInputElement>(null);
  const notesTextRef = useRef<HTMLTextAreaElement>(null);

  // ── Lightbox state ──────────────────────────────────────────
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const effectiveUid = ownerUid ?? user?.uid ?? '';

  const toggleItem = async (card: Card, itemId: string) => {
    if (!user) return;
    const updated = card.items.map(i => i.id === itemId ? { ...i, completed: !i.completed } : i);
    await updateDoc(doc(db, 'users', effectiveUid, 'chapters', chapterId, 'cards', card.id), { items: updated });
    onRefresh();
  };
  const addNewItem = async (card: Card, text: string) => {
    if (!user || !text.trim()) return;
    const newItem: CardItem = { id: crypto.randomUUID(), text: text.trim(), completed: false };
    await updateDoc(doc(db, 'users', effectiveUid, 'chapters', chapterId, 'cards', card.id), { items: [...card.items, newItem] });
    onRefresh();
  };
  const updateCard = async (cardId: string, newTitle: string, newItems: CardItem[]) => {
    if (!user) return;
    await updateDoc(doc(db, 'users', effectiveUid, 'chapters', chapterId, 'cards', cardId), { title: newTitle, items: newItems });
    onRefresh();
  };
  const saveItemText = async (card: Card, itemId: string, newText: string) => {
    if (!user || !newText.trim()) return;
    const updated = card.items.map(i => i.id === itemId ? { ...i, text: newText.trim() } : i);
    await updateDoc(doc(db, 'users', effectiveUid, 'chapters', chapterId, 'cards', card.id), { items: updated });
    onRefresh();
  };
  const deleteCard = (cardId: string) => {
    if (!user) return;
    const cardData = cards.find(c => c.id === cardId);
    if (!cardData) return;
    const existing = pendingDeletes.get(cardId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(async () => {
      await deleteDoc(doc(db, 'users', effectiveUid, 'chapters', chapterId, 'cards', cardId));
      setPendingDeletes(prev => { const n = new Map(prev); n.delete(cardId); return n; });
      onRefresh();
    }, 5000);
    setPendingDeletes(prev => new Map(prev).set(cardId, { title: cardData.title, timer }));
  };
  const undoDelete = (cardId: string) => {
    const p = pendingDeletes.get(cardId);
    if (!p) return;
    clearTimeout(p.timer);
    setPendingDeletes(prev => { const n = new Map(prev); n.delete(cardId); return n; });
  };

  // ── Add Card ────────────────────────────────────────────────
  const handleAddCard = async () => {
    const value = cardInputRef.current?.value?.trim() || '';
    if (!user || !value) return;
    await addDoc(collection(db, 'users', effectiveUid, 'chapters', chapterId, 'cards'), {
      category: '',
      title: value,
      items: [],
      type: 'checklist',
      order: cards.length,
      createdAt: serverTimestamp(),
    });
    if (cardInputRef.current) cardInputRef.current.value = '';
    setIsAddingCard(false);
    onRefresh();
  };

  // ── Add Photo ───────────────────────────────────────────────
  const handlePhotoSelected = async (file: File) => {
    if (!user || !file) return;
    setUploadingPhoto(true);
    try {
      const storageRef = ref(storage, `users/${effectiveUid}/overview/${chapterId}/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file);
      const photoUrl = await getDownloadURL(storageRef);
      await addDoc(collection(db, 'users', effectiveUid, 'chapters', chapterId, 'cards'), {
        category: '',
        title: file.name.replace(/\.[^.]+$/, ''),
        items: [],
        type: 'photo',
        photoUrl,
        order: cards.length,
        createdAt: serverTimestamp(),
      });
      onRefresh();
    } catch (err) {
      console.error('Photo upload error:', err);
    } finally {
      setUploadingPhoto(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  };

  // ── Add Notes ───────────────────────────────────────────────
  const handleAddNotes = async () => {
    const title = notesTitleRef.current?.value?.trim() || 'Notes';
    const text = notesTextRef.current?.value?.trim() || '';
    if (!user || !text) return;
    await addDoc(collection(db, 'users', effectiveUid, 'chapters', chapterId, 'cards'), {
      category: '',
      title,
      items: [],
      type: 'notes',
      notesText: text,
      order: cards.length,
      createdAt: serverTimestamp(),
    });
    setIsAddingNotes(false);
    onRefresh();
  };

  // ── AI Summary ───────────────────────────────────────────────
  const sessionKey = `ark-summary-generated-${chapterId}`;
  const hasGeneratedThisSession = typeof sessionStorage !== 'undefined'
    ? sessionStorage.getItem(sessionKey) === '1'
    : false;

  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [summaryText, setSummaryText] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(hasGeneratedThisSession);
  const autoRunRef = useRef(false);

  const fetchTabContent = useCallback(async (): Promise<string> => {
    if (!user || customTabs.length === 0) return '';
    const subColMap: Record<string, { sub: string; fields: string[] }> = {
      todo:      { sub: 'items',    fields: ['text', 'completed'] },
      contacts:  { sub: 'contacts', fields: ['name', 'role', 'email', 'phone'] },
      timeline:  { sub: 'events',   fields: ['title', 'date', 'description'] },
      eventlog:  { sub: 'entries',  fields: ['date', 'time', 'text'] },
      budget:    { sub: 'items',    fields: ['description', 'type', 'amount', 'category'] },
      links:     { sub: 'items',    fields: ['title', 'url', 'note'] },
      inventory: { sub: 'items',    fields: ['name', 'category', 'quantity', 'condition'] },
      notes:     { sub: 'note',     fields: ['text'] },
    };
    const parts: string[] = [];
    for (const tab of customTabs) {
      const mapping = subColMap[tab.template];
      if (!mapping) continue;
      try {
        const colPath = `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tab.id}/${mapping.sub}`;
        const snap = await getDocs(collection(db, colPath));
        if (snap.empty) continue;
        const rows = snap.docs.map(d => {
          const data = d.data();
          return mapping.fields.map(f => data[f] !== undefined && data[f] !== '' ? String(data[f]) : null).filter(Boolean).join(' | ');
        }).filter(Boolean);
        if (rows.length === 0) continue;
        parts.push(`[${tab.name} — ${tab.template}]\n${rows.slice(0, 20).join('\n')}`);
      } catch { /* skip */ }
    }
    return parts.join('\n\n');
  }, [user, chapterId, customTabs, effectiveUid]);

  const generateSummary = useCallback(async () => {
    if (!user) return;
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const nonAiCards = cards.filter(c => c.category !== 'AI');
      const cardLines = nonAiCards.map(c => {
        const items = c.items.filter(i => i.text.trim()).map(i => `  - ${i.text}${i.completed ? ' (done)' : ''}`);
        return items.length > 0 ? `${c.title}:\n${items.join('\n')}` : null;
      }).filter(Boolean);
      const tabContent = await fetchTabContent();
      const totalContent = [...cardLines, tabContent].join('').trim();
      if (!totalContent && !chapterTitle.trim()) { setSummaryLoading(false); return; }
      const cardContext = cardLines.length > 0 ? `Overview sections:\n${cardLines.join('\n\n')}` : '';
      const prompt =
        `You are writing a concise paragraph summary for a planning deck called "${chapterTitle || 'this deck'}" ` +
        `in a personal life-planning app.\n\n` +
        (cardContext ? `${cardContext}\n\n` : '') +
        (tabContent ? `Content from other tabs:\n${tabContent}\n\n` : '') +
        `RULES — follow these exactly:\n` +
        `1. Write 2-4 sentences in plain prose (no bullet points, no lists).\n` +
        `2. Only reference REAL data provided above. Do NOT invent, assume, or add generic advice.\n` +
        `3. Be specific — mention names, dates, numbers, or statuses from the data.\n` +
        `4. If there is very little data, write just 1-2 sentences.\n` +
        `5. Do NOT start with "This deck" or "This planning deck". Start with the subject directly.\n` +
        `6. Do NOT include filler like "Ready to plan" or "No sections created".\n\n` +
        `Respond with a single JSON object in this exact format:\n` +
        `{"summary":"Your 2-4 sentence paragraph here."}`;
      const generate = httpsCallable(functions, 'generateChapter');
      const result = await generate({ prompt }) as any;
      let paragraph: string = result?.data?.summary ?? '';
      if (!paragraph) {
        const aiCard = result?.data?.chapter?.cards?.[0];
        if (aiCard && Array.isArray(aiCard.items) && aiCard.items.length > 0) paragraph = aiCard.items.join(' ');
      }
      if (!paragraph.trim()) { setSummaryLoading(false); return; }
      sessionStorage.setItem(sessionKey, '1');
      sessionStorage.setItem(`ark-summary-text-${chapterId}`, paragraph.trim());
      setSummaryText(paragraph.trim());
      setShowSummary(true);
      setHasGenerated(true);
    } catch (err: any) {
      setSummaryError(err?.message?.replace('Firebase: ', '') ?? 'Failed to generate summary.');
    } finally {
      setSummaryLoading(false);
    }
  }, [user, cards, customTabs, chapterTitle, chapterId, fetchTabContent, sessionKey]);

  useEffect(() => {
    if (hasGeneratedThisSession) {
      const saved = sessionStorage.getItem(`ark-summary-text-${chapterId}`);
      if (saved) { setSummaryText(saved); setShowSummary(true); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleCards = cards.filter(c => !pendingDeletes.has(c.id));

  // ── Add Card inline form ─────────────────────────────────────
  const AddCardForm = () => (
    <div className="bg-white rounded-xl border-2 border-slate-900 p-3 shadow-md">
      <input
        ref={cardInputRef}
        defaultValue=""
        onKeyDown={e => {
          if (e.key === 'Enter') handleAddCard();
          if (e.key === 'Escape') setIsAddingCard(false);
        }}
        placeholder="Card title"
        autoFocus
        className="w-full text-base font-bold border-0 border-b-2 border-slate-100 focus:border-slate-900 focus:outline-none pb-1 mb-3 bg-transparent placeholder-slate-300"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
      />
      <div className="flex gap-2">
        <button onClick={() => setIsAddingCard(false)} className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50 transition-colors">Cancel</button>
        <button onClick={handleAddCard} className="flex-1 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors">Add</button>
      </div>
    </div>
  );

  // ── Add Notes inline form ────────────────────────────────────
  const AddNotesForm = () => (
    <div className="bg-white rounded-xl border-2 border-slate-900 p-3 shadow-md">
      <input
        ref={notesTitleRef}
        defaultValue=""
        placeholder="Title (optional)"
        className="w-full text-base font-bold border-0 border-b-2 border-slate-100 focus:border-slate-900 focus:outline-none pb-1 mb-2 bg-transparent placeholder-slate-300"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
      />
      <textarea
        ref={notesTextRef}
        placeholder="Write your note…"
        autoFocus
        rows={4}
        onKeyDown={e => { if (e.key === 'Escape') setIsAddingNotes(false); }}
        className="w-full text-sm border border-slate-200 rounded-lg p-2 focus:outline-none focus:border-slate-900 resize-none mb-3 placeholder-slate-300"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
      />
      <div className="flex gap-2">
        <button onClick={() => setIsAddingNotes(false)} className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50 transition-colors">Cancel</button>
        <button onClick={handleAddNotes} className="flex-1 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors">Add</button>
      </div>
    </div>
  );

  // ── Three action buttons row ─────────────────────────────────
  const ActionButtons = () => (
    <div className="flex gap-2">
      {/* Add Card */}
      <button
        onClick={() => { setIsAddingCard(true); setIsAddingNotes(false); }}
        className="flex-1 flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-slate-200 rounded-xl py-3 hover:border-slate-400 hover:bg-white transition-all text-slate-400 hover:text-slate-600 min-h-[72px]"
      >
        <Plus className="w-4 h-4" />
        <span className="text-xs font-medium">Add Card</span>
      </button>

      {/* Add Photo */}
      <label className="flex-1 flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-slate-200 rounded-xl py-3 hover:border-slate-400 hover:bg-white transition-all text-slate-400 hover:text-slate-600 min-h-[72px] cursor-pointer">
        {uploadingPhoto
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <Camera className="w-4 h-4" />
        }
        <span className="text-xs font-medium">{uploadingPhoto ? 'Uploading…' : 'Add Photo'}</span>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          disabled={uploadingPhoto}
          onChange={e => { const f = e.target.files?.[0]; if (f) handlePhotoSelected(f); }}
        />
      </label>

      {/* Add Notes */}
      <button
        onClick={() => { setIsAddingNotes(true); setIsAddingCard(false); }}
        className="flex-1 flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-slate-200 rounded-xl py-3 hover:border-slate-400 hover:bg-white transition-all text-slate-400 hover:text-slate-600 min-h-[72px]"
      >
        <AlignLeft className="w-4 h-4" />
        <span className="text-xs font-medium">Add Notes</span>
      </button>
    </div>
  );

  return (
    <>
      {/* AI Summary bar */}
      <div className="mb-5">
        <div className="flex items-center justify-between gap-3 min-h-[32px]">
          <div className="flex-1 min-w-0">
            {summaryError && <p className="text-xs text-red-500">{summaryError}</p>}
          </div>
          <button
            onClick={generateSummary}
            disabled={summaryLoading}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-500 bg-white border border-slate-200 rounded-xl hover:border-slate-400 hover:text-slate-900 transition-all disabled:opacity-40 flex-shrink-0 shadow-sm"
          >
            {summaryLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {summaryLoading ? 'Summarising…' : hasGenerated ? 'Refresh Summary' : 'Summarise'}
          </button>
        </div>
        {showSummary && summaryText && (
          <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
            <Sparkles className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-slate-700 leading-relaxed flex-1">{summaryText}</p>
            <button onClick={() => setShowSummary(false)} className="p-0.5 rounded hover:bg-amber-100 transition-colors flex-shrink-0">
              <X className="w-3.5 h-3.5 text-amber-400" />
            </button>
          </div>
        )}
      </div>

      {visibleCards.length === 0 && pendingDeletes.size === 0 ? (
        <div className="flex flex-col items-center py-12">
          {isAddingCard ? (
            <div className="w-full max-w-sm"><AddCardForm /></div>
          ) : isAddingNotes ? (
            <div className="w-full max-w-sm"><AddNotesForm /></div>
          ) : (
            <div className="w-full max-w-sm text-center">
              <p className="text-slate-500 mb-5">No cards yet</p>
              <ActionButtons />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleCards.map(card => {
              // ── Photo card ──────────────────────────────────
              if (card.type === 'photo') {
                return (
                  <div key={card.id} className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden group relative">
                    <button
                      className="absolute top-2 right-2 z-10 p-1 bg-white/80 rounded-full hover:bg-red-50 active:bg-red-100 transition-all"
                      onClick={() => deleteCard(card.id)}
                      title="Delete"
                    >
                      <X className="w-3.5 h-3.5 text-slate-400" />
                    </button>
                    <button
                      className="w-full block"
                      onClick={() => card.photoUrl && setLightboxUrl(card.photoUrl)}
                    >
                      <div className="aspect-[4/3] overflow-hidden bg-slate-100">
                        {card.photoUrl
                          ? <img src={card.photoUrl} alt={card.title} className="w-full h-full object-cover hover:scale-105 transition-transform duration-300" />
                          : <div className="w-full h-full flex items-center justify-center"><ImageIcon className="w-8 h-8 text-slate-300" /></div>
                        }
                      </div>
                    </button>
                    {card.title && (
                      <div className="px-3 py-2">
                        <p className="text-xs font-medium text-slate-600 truncate">{card.title}</p>
                      </div>
                    )}
                  </div>
                );
              }

              // ── Notes card ──────────────────────────────────
              if (card.type === 'notes') {
                return (
                  <NotesCard
                    key={card.id}
                    card={card}
                    onSave={async (newTitle, newText) => {
                      if (!user) return;
                      await updateDoc(doc(db, 'users', effectiveUid, 'chapters', chapterId, 'cards', card.id), {
                        title: newTitle,
                        notesText: newText,
                        updatedAt: serverTimestamp(),
                      });
                    }}
                    onDelete={() => deleteCard(card.id)}
                  />
                );
              }

              // ── Default checklist card ──────────────────────
              return (
                <CardComponent key={card.id} card={card}
                  onToggleItem={itemId => toggleItem(card, itemId)}
                  onAddItem={text => addNewItem(card, text)}
                  onUpdateCard={(title, items) => updateCard(card.id, title, items)}
                  onSaveItemText={(itemId, text) => saveItemText(card, itemId, text)}
                  onDelete={() => deleteCard(card.id)}
                />
              );
            })}
          </div>

          {/* Action buttons row — or inline forms */}
          {isAddingCard ? (
            <AddCardForm />
          ) : isAddingNotes ? (
            <AddNotesForm />
          ) : (
            <ActionButtons />
          )}
        </div>
      )}

      {/* Undo delete toasts */}
      {pendingDeletes.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none">
          {Array.from(pendingDeletes.entries()).map(([cardId, { title }]) => (
            <div key={cardId} className="pointer-events-auto flex items-center gap-4 bg-slate-900 text-white pl-4 pr-2 py-2.5 rounded-xl shadow-xl text-sm whitespace-nowrap">
              <span className="text-slate-300"><span className="text-white font-medium">"{title}"</span> deleted</span>
              <button onClick={() => undoDelete(cardId)} className="font-semibold text-amber-400 hover:text-amber-300 transition-colors px-2 py-1 rounded-lg hover:bg-white/10">Undo</button>
            </div>
          ))}
        </div>
      )}

      {/* Photo lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 cursor-pointer"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="Photo"
            className="max-w-[95vw] max-h-[92vh] object-contain rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
          <button
            className="absolute top-5 right-5 w-9 h-9 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors"
            onClick={() => setLightboxUrl(null)}
          >
            <X className="w-5 h-5 text-white" />
          </button>
        </div>
      )}
    </>
  );
}

// ── NotesCard component ─────────────────────────────────────────────────────

interface NotesCardProps {
  card: Card;
  onSave: (title: string, text: string) => Promise<void>;
  onDelete: () => void;
}

function NotesCard({ card, onSave, onDelete }: NotesCardProps) {
  const [title, setTitle] = useState(card.title || '');
  const [text, setText] = useState(card.notesText || '');
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unsaved edit in flight (typed locally, not yet written to Firestore), so
  // an incoming refresh triggered by unrelated activity (another card, another
  // user) never overwrites what the user is actively typing.
  const dirtyTitleRef = useRef(false);
  const dirtyTextRef = useRef(false);

  // Keep local state in sync if the card prop changes (e.g. real-time update from another user) —
  // but only for fields the user isn't currently mid-edit on.
  useEffect(() => { if (!dirtyTitleRef.current) setTitle(card.title || ''); }, [card.title]);
  useEffect(() => { if (!dirtyTextRef.current) setText(card.notesText || ''); }, [card.notesText]);

  const scheduleSave = (newTitle: string, newText: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await onSave(newTitle, newText);
      } finally {
        dirtyTitleRef.current = false;
        dirtyTextRef.current = false;
        setSaving(false);
      }
    }, 800);
  };

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    dirtyTitleRef.current = true;
    setTitle(v);
    scheduleSave(v, text);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    dirtyTextRef.current = true;
    setText(v);
    scheduleSave(title, v);
  };

  // Flush on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const inputStyle = { userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties;

  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden group relative">
      {/* Delete button — always visible so it's reachable on mobile */}
      <button
        className="absolute top-2 right-2 z-10 p-1 bg-white/80 rounded-full hover:bg-red-50 active:bg-red-100 transition-all"
        onClick={onDelete}
        title="Delete"
      >
        <X className="w-3.5 h-3.5 text-slate-400" />
      </button>

      {/* Title row */}
      <div className="px-3 pt-3 pb-1 flex items-center gap-2">
        <AlignLeft className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
        <input
          value={title}
          onChange={handleTitleChange}
          placeholder="Title"
          className="flex-1 font-semibold text-slate-900 text-sm bg-transparent border-0 focus:outline-none placeholder-slate-300 min-w-0 pr-6"
          style={inputStyle}
        />
      </div>

      {/* Notes textarea — grows automatically with content */}
      <div className="px-3 pb-3">
        <textarea
          value={text}
          onChange={e => {
            handleTextChange(e);
            // Auto-height: shrink to auto first so scrollHeight is accurate
            e.target.style.height = 'auto';
            e.target.style.height = e.target.scrollHeight + 'px';
          }}
          ref={el => {
            // Set initial height on mount
            if (el) {
              el.style.height = 'auto';
              el.style.height = el.scrollHeight + 'px';
            }
          }}
          placeholder="Write your note…"
          rows={1}
          className="w-full text-sm text-slate-700 bg-transparent border-0 focus:outline-none resize-none leading-relaxed placeholder-slate-300 overflow-hidden"
          style={{ ...inputStyle, minHeight: '40px' }}
        />
      </div>

      {/* Saving indicator */}
      {saving && (
        <div className="absolute bottom-2 right-3 flex items-center gap-1 text-xs text-slate-400 pointer-events-none">
          <Loader2 className="w-3 h-3 animate-spin" />
          Saving
        </div>
      )}
    </div>
  );
}

interface CardComponentProps {
  card: Card;
  onToggleItem: (itemId: string) => void;
  onAddItem: (text: string) => void;
  onUpdateCard: (title: string, items: CardItem[]) => Promise<void>;
  onSaveItemText: (itemId: string, text: string) => Promise<void>;
  onDelete: () => void;
}

const REVEAL_WIDTH = 88;
const REVEAL_THRESHOLD = 50;
const LONG_PRESS_MS = 200;

function CardComponent({ card, onToggleItem, onAddItem, onUpdateCard, onSaveItemText, onDelete }: CardComponentProps) {
  const isAI = card.category === 'AI';
  const [isExpanded, setIsExpanded] = useState(true);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [editItems, setEditItems] = useState<CardItem[]>(card.items);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dragPreviewId, setDragPreviewId] = useState<string | null>(null);

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemDefault, setEditingItemDefault] = useState('');
  const itemInputRef = useRef<HTMLInputElement>(null);

  const [isAdding, setIsAdding] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  const [revealedItemId, setRevealedItemId] = useState<string | null>(null);
  const revealedItemIdRef = useRef<string | null>(null);
  const [swipeDelta, setSwipeDelta] = useState<{ itemId: string; deltaX: number } | null>(null);
  const [swipeTransition, setSwipeTransition] = useState(false);
  const [deletedItems, setDeletedItems] = useState<Set<string>>(new Set());

  const [completedOverrides, setCompletedOverrides] = useState<Map<string, boolean>>(new Map());
  useEffect(() => { setCompletedOverrides(new Map()); }, [card.items]);
  const getCompleted = (item: CardItem) =>
    completedOverrides.has(item.id) ? completedOverrides.get(item.id)! : item.completed;
  const handleToggleOptimistic = (itemId: string) => {
    const item = card.items.find(i => i.id === itemId);
    const current = completedOverrides.has(itemId) ? completedOverrides.get(itemId)! : (item?.completed ?? false);
    setCompletedOverrides(prev => new Map(prev).set(itemId, !current));
    onToggleItem(itemId);
  };

  const normalItemsListRef = useRef<HTMLDivElement>(null);
  const swipeGestureRef = useRef<{ startX: number; startY: number; itemId: string; deltaX: number; direction: 'horizontal' | 'vertical' | null } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasDraggingRef = useRef(false);
  const cardRef = useRef(card);
  cardRef.current = card;
  const onUpdateCardRef = useRef(onUpdateCard);
  onUpdateCardRef.current = onUpdateCard;

  const saveTitle = async () => {
    const value = titleInputRef.current?.value?.trim() || '';
    if (value && value !== card.title) await onUpdateCard(value, card.items);
    setIsEditingTitle(false);
  };

  const startDragRef = useRef((_itemId: string, _itemIdx: number) => {});
  startDragRef.current = (initItemId: string, initItemIdx: number) => {
    const items = [...cardRef.current.items];
    setEditItems(items);
    setDraggingItemId(initItemId);
    wasDraggingRef.current = true;
    let currentIdx = initItemIdx;
    let rafId: number | null = null;
    const onMove = (e: TouchEvent) => {
      const clientX = e.touches[0].clientX;
      const clientY = e.touches[0].clientY;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const el = document.elementFromPoint(clientX, clientY);
        const wrapper = el?.closest('[data-item-id]') as HTMLElement | null;
        if (!wrapper) return;
        const targetId = wrapper.dataset.itemId;
        if (!targetId) return;
        const targetIdx = items.findIndex(i => i.id === targetId);
        if (targetIdx === -1 || targetIdx === currentIdx) return;
        const [moved] = items.splice(currentIdx, 1);
        items.splice(targetIdx, 0, moved);
        currentIdx = targetIdx;
        setDraggingItemId(moved.id);
        setEditItems([...items]);
      });
    };
    const onEnd = () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.body.style.userSelect = '';
      setDraggingItemId(null);
      setDragPreviewId(null);
      onUpdateCardRef.current(cardRef.current.title, items);
      setTimeout(() => { wasDraggingRef.current = false; }, 100);
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  };

  const setRevealed = (id: string | null) => { revealedItemIdRef.current = id; setRevealedItemId(id); };

  useEffect(() => {
    if (!isExpanded) return;
    const container = normalItemsListRef.current;
    if (!container) return;
    const onTS = (e: TouchEvent) => {
      const target = e.target as Element;
      if (revealedItemIdRef.current) {
        const touched = target.closest('[data-item-id]') as HTMLElement | null;
        if (touched?.dataset.itemId !== revealedItemIdRef.current) setRevealed(null);
        return;
      }
      if (target.closest('button') || target.closest('input')) return;
      const itemEl = target.closest('[data-item-id]') as HTMLElement | null;
      if (!itemEl) return;
      const itemId = itemEl.dataset.itemId!;
      const itemIdx = parseInt(itemEl.dataset.itemIdx ?? '', 10);
      const touch = e.touches[0];
      const focusedEl = document.activeElement as HTMLElement | null;
      const hadFocusedInput = !!(focusedEl && (focusedEl.tagName === 'INPUT' || focusedEl.tagName === 'TEXTAREA'));
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        swipeGestureRef.current = null;
        if (navigator.vibrate) navigator.vibrate(30);
        setDragPreviewId(itemId);
        setTimeout(() => {
          startDragRef.current(itemId, itemIdx);
          if (hadFocusedInput && focusedEl) focusedEl.focus({ preventScroll: true });
        }, 50);
      }, LONG_PRESS_MS);
      swipeGestureRef.current = { startX: touch.clientX, startY: touch.clientY, itemId, deltaX: 0, direction: null };
    };
    const onTM = (e: TouchEvent) => {
      const g = swipeGestureRef.current;
      if (!g) return;
      const dx = e.touches[0].clientX - g.startX;
      const dy = e.touches[0].clientY - g.startY;
      if (g.direction === null) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
        g.direction = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      }
      if (g.direction === 'vertical' || dx > 10) { swipeGestureRef.current = null; return; }
      e.preventDefault();
      g.deltaX = Math.max(dx, -(REVEAL_WIDTH + 20));
      setSwipeTransition(false);
      setSwipeDelta({ itemId: g.itemId, deltaX: g.deltaX });
    };
    const onTE = () => {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
      const g = swipeGestureRef.current;
      swipeGestureRef.current = null;
      setSwipeTransition(true);
      setSwipeDelta(null);
      setDragPreviewId(null);
      if (!g || g.direction !== 'horizontal') return;
      if (g.deltaX < -REVEAL_THRESHOLD) setRevealed(g.itemId);
    };
    const onMD = (e: MouseEvent) => {
      if (!(e.target as Element).closest('[data-grip-handle]')) return;
      e.preventDefault();
      const itemEl = (e.target as Element).closest('[data-item-id]') as HTMLElement | null;
      if (!itemEl) return;
      const itemId = itemEl.dataset.itemId!;
      const itemIdx = parseInt(itemEl.dataset.itemIdx ?? '', 10);
      const items = [...cardRef.current.items];
      setEditItems(items);
      setDraggingItemId(itemId);
      wasDraggingRef.current = true;
      let currentIdx = itemIdx;
      let rafId: number | null = null;
      const onMM = (e: MouseEvent) => {
        const cx = e.clientX, cy = e.clientY;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const el = document.elementFromPoint(cx, cy);
          const wrapper = el?.closest('[data-item-id]') as HTMLElement | null;
          if (!wrapper) return;
          const targetId = wrapper.dataset.itemId;
          if (!targetId) return;
          const targetIdx = items.findIndex(i => i.id === targetId);
          if (targetIdx === -1 || targetIdx === currentIdx) return;
          const [moved] = items.splice(currentIdx, 1);
          items.splice(targetIdx, 0, moved);
          currentIdx = targetIdx;
          setDraggingItemId(moved.id);
          setEditItems([...items]);
        });
      };
      const onMU = () => {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        document.removeEventListener('mousemove', onMM);
        document.removeEventListener('mouseup', onMU);
        document.body.style.cursor = '';
        setDraggingItemId(null);
        setDragPreviewId(null);
        onUpdateCardRef.current(cardRef.current.title, items);
        setTimeout(() => { wasDraggingRef.current = false; }, 100);
      };
      document.body.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMM);
      document.addEventListener('mouseup', onMU);
    };
    container.addEventListener('touchstart', onTS, { passive: true });
    container.addEventListener('touchmove', onTM, { passive: false });
    container.addEventListener('touchend', onTE);
    container.addEventListener('mousedown', onMD);
    return () => {
      container.removeEventListener('touchstart', onTS);
      container.removeEventListener('touchmove', onTM);
      container.removeEventListener('touchend', onTE);
      container.removeEventListener('mousedown', onMD);
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, [isExpanded]);

  const isDragging = !!draggingItemId;
  const itemsToRender = (isDragging ? editItems : card.items).filter(i => !deletedItems.has(i.id));
  const completedCount = itemsToRender.filter(i => getCompleted(i)).length;
  const totalCount = itemsToRender.length;

  const startItemEdit = (item: CardItem) => {
    setEditingItemDefault(item.text);
    setEditingItemId(item.id);
  };
  const commitItemEdit = async (andAdd = false) => {
    const value = itemInputRef.current?.value?.trim() || '';
    if (editingItemId && value) await onSaveItemText(editingItemId, value);
    setEditingItemId(null);
    setEditingItemDefault('');
    if (andAdd) { setIsAdding(true); setTimeout(() => addInputRef.current?.focus(), 0); }
  };
  const cancelItemEdit = () => { setEditingItemId(null); setEditingItemDefault(''); };

  const handleAddItem = () => {
    const value = addInputRef.current?.value?.trim() || '';
    if (value) {
      onAddItem(value);
      if (addInputRef.current) addInputRef.current.value = '';
      setTimeout(() => addInputRef.current?.focus(), 0);
    }
  };

  const confirmDeleteItem = (itemId: string) => {
    setRevealed(null);
    setDeletedItems(prev => new Set(prev).add(itemId));
    onUpdateCard(card.title, card.items.filter(i => i.id !== itemId));
  };

  const inputStyle = { userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties;

  return (
    <div className={`bg-white rounded-xl shadow-sm overflow-hidden ${isAI ? 'border border-amber-400' : 'border border-slate-100'}`}>
      <div className="px-4 pt-3 pb-2 flex items-center gap-1.5">
        {isEditingTitle ? (
          <input
            ref={titleInputRef}
            defaultValue={card.title}
            onBlur={saveTitle}
            onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setIsEditingTitle(false); }}
            autoFocus
            className="flex-1 font-semibold text-slate-900 text-sm bg-transparent border-0 border-b border-slate-400 focus:border-slate-900 focus:outline-none py-0.5"
            style={inputStyle}
          />
        ) : (
          <h3
            className="flex-1 font-semibold text-slate-900 text-sm cursor-text select-none leading-snug"
            onClick={() => setIsEditingTitle(true)}
          >
            {card.title}
          </h3>
        )}
        <button onClick={() => setIsExpanded(v => !v)} className="p-1 hover:bg-slate-100 rounded transition-colors flex-shrink-0">
          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform duration-150 ${isExpanded ? '' : '-rotate-90'}`} />
        </button>
        <button onClick={e => { e.stopPropagation(); onDelete(); }} className="p-1 hover:bg-slate-100 rounded transition-colors flex-shrink-0">
          <X className="w-3.5 h-3.5 text-slate-400" />
        </button>
      </div>

      {totalCount > 0 && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <div className="flex-1 bg-slate-100 rounded-full h-1 overflow-hidden">
            <div className="bg-slate-900 h-full transition-all" style={{ width: `${(completedCount / totalCount) * 100}%` }} />
          </div>
          <span className="text-xs text-slate-400">{completedCount}/{totalCount}</span>
        </div>
      )}

      {isExpanded && (
        <div
          ref={normalItemsListRef}
          className="border-t border-slate-100 p-3 space-y-0.5"
          style={isDragging ? { WebkitUserSelect: 'none', userSelect: 'none' } as React.CSSProperties : undefined}
        >
          {itemsToRender.map((item, idx) => {
            const isThisDragging = draggingItemId === item.id;
            const isPreview = dragPreviewId === item.id && !draggingItemId;
            const isRevealed = !isDragging && revealedItemId === item.id;
            const isSwiping = !isDragging && swipeDelta?.itemId === item.id;
            const translateX = isRevealed ? -REVEAL_WIDTH : (isSwiping ? swipeDelta!.deltaX : 0);
            const useSwipeTransition = isRevealed || (swipeTransition && !isSwiping);
            const swipeW = isSwiping ? Math.max(Math.abs(swipeDelta!.deltaX), 0) : 0;
            return (
              <div key={item.id} data-item-id={item.id} data-item-idx={idx} className="relative" style={{ zIndex: isThisDragging ? 10 : 1 }}>
                {!isDragging && isRevealed && (
                  <button onClick={() => confirmDeleteItem(item.id)}
                    className="absolute inset-y-0 right-0 bg-red-500 flex items-center justify-center active:bg-red-600 rounded-r-lg"
                    style={{ width: REVEAL_WIDTH }}>
                    <Trash2 className="w-5 h-5 text-white" />
                  </button>
                )}
                {!isDragging && isSwiping && swipeW > 8 && (
                  <div className="absolute inset-y-0 right-0 bg-red-500 flex items-center justify-center rounded-r-lg" style={{ width: swipeW }}>
                    {swipeW > 28 && <Trash2 className="w-4 h-4 text-white" style={{ opacity: Math.min(swipeW / REVEAL_WIDTH, 1) }} />}
                  </div>
                )}
                <div
                  className="relative flex items-start gap-3 p-2 rounded-lg group/item"
                  style={{
                    transform: isThisDragging ? 'scale(1.03)' : isPreview ? 'scale(0.97)' : `translateX(${translateX}px)`,
                    transition: isThisDragging ? 'transform 0.08s ease-out, box-shadow 0.08s ease-out' : isPreview ? 'transform 0.06s ease-out' : useSwipeTransition ? 'transform 0.22s ease-out' : 'none',
                    boxShadow: isThisDragging ? '0 6px 20px rgba(0,0,0,0.14)' : 'none',
                    backgroundColor: isThisDragging ? 'white' : isPreview ? '#f1f5f9' : 'transparent',
                    borderRadius: '0.5rem',
                  }}
                >
                  <div data-grip-handle="true" className="hidden md:flex w-4 items-center self-center opacity-0 group-hover/item:opacity-100 transition-opacity cursor-grab flex-shrink-0 touch-none">
                    <GripVertical className="w-3.5 h-3.5 text-slate-300 pointer-events-none" />
                  </div>
                  <button onClick={() => handleToggleOptimistic(item.id)}
                    className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${getCompleted(item) ? 'bg-slate-900 border-slate-900' : 'border-slate-300 hover:border-slate-400'}`}>
                    {getCompleted(item) && <Check className="w-3 h-3 text-white" />}
                  </button>
                  {editingItemId === item.id ? (
                    <input
                      ref={itemInputRef}
                      defaultValue={editingItemDefault}
                      onBlur={() => commitItemEdit(false)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); commitItemEdit(true); }
                        if (e.key === 'Escape') cancelItemEdit();
                      }}
                      autoFocus
                      className="flex-1 text-sm border-0 border-b border-slate-400 focus:border-slate-900 focus:outline-none bg-transparent pb-0.5"
                      style={inputStyle}
                    />
                  ) : (
                    <span
                      className={`flex-1 text-sm ${getCompleted(item) ? 'text-slate-400 line-through' : 'text-slate-700'}`}
                      style={{ cursor: isDragging ? 'grabbing' : 'text' }}
                      onClick={() => { if (!wasDraggingRef.current) startItemEdit(item); }}
                    >
                      {item.text}
                    </span>
                  )}
                  {!isDragging && editingItemId !== item.id && (
                    <button
                      onClick={e => { e.stopPropagation(); confirmDeleteItem(item.id); }}
                      className="opacity-0 group-hover/item:opacity-100 p-1 rounded hover:bg-red-50 transition-all flex-shrink-0"
                      title="Delete item"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-400" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {!isDragging && (isAdding ? (
            <div className="flex gap-2 mt-2">
              <input
                ref={addInputRef}
                type="text"
                onKeyDown={e => {
                  if (e.key === 'Enter') handleAddItem();
                  if (e.key === 'Escape') setIsAdding(false);
                }}
                placeholder="Add item..."
                autoFocus
                className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                style={inputStyle}
              />
              <button onClick={handleAddItem} className="px-3 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors"><Check className="w-4 h-4" /></button>
              <button onClick={() => setIsAdding(false)} className="px-3 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"><X className="w-4 h-4" /></button>
            </div>
          ) : (
            <button onClick={() => setIsAdding(true)} className="w-full mt-2 px-3 py-2 text-sm text-slate-500 hover:text-slate-900 hover:bg-slate-50 rounded-lg transition-colors flex items-center gap-2">
              <Plus className="w-4 h-4" />Add item
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
