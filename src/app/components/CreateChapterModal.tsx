import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db, functions } from '../../lib/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { X, Sparkles, Loader2, Zap } from 'lucide-react';

// Seed a default Notes tab + one empty note doc for a newly created deck
async function seedNotesTab(uid: string, chapterId: string) {
  const tabsRef = collection(db, 'users', uid, 'chapters', chapterId, 'customTabs');
  const tabDoc = await addDoc(tabsRef, {
    name: 'Notes',
    template: 'notes',
    order: 0,
    createdAt: serverTimestamp(),
  });
  // Pre-create one note so the user lands straight into a writable textarea
  const noteRef = collection(db, 'users', uid, 'chapters', chapterId, 'customTabs', tabDoc.id, 'note');
  await addDoc(noteRef, {
    title: 'Note 1',
    text: '',
    order: 0,
    createdAt: serverTimestamp(),
  });
  return tabDoc.id;
}

interface CreateChapterModalProps {
  onClose: () => void;
  onCreated: (chapterId: string) => void;
  onRequestFocus?: () => void;
}

export function CreateChapterModal({ onClose, onCreated, onRequestFocus }: CreateChapterModalProps) {
  const [aiMode, setAiMode] = useState(false);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { user } = useAuth();

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !user) return;
    // Call synchronously inside the gesture handler — iOS will open the keyboard
    onRequestFocus?.();
    setLoading(true);
    setError('');
    try {
      const quickRef = await addDoc(collection(db, 'users', user.uid, 'chapters'), {
        title: title.trim(),
        description: '',
        icon: '📌',
        order: -Date.now(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await seedNotesTab(user.uid, quickRef.id);
      onCreated(quickRef.id);
    } catch (err: any) {
      setError(err.message || 'Failed to create deck');
    } finally {
      setLoading(false);
    }
  };

  const handleAiBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !user) return;
    // Call synchronously inside the gesture handler — iOS will open the keyboard
    onRequestFocus?.();
    setLoading(true);
    setError('');
    try {
      let deckTitle = prompt.trim();
      let deckDescription = '';
      let deckIcon = '📌';
      let cards: any[] = [];

      try {
        const generateChapter = httpsCallable(functions, 'generateChapter');
        const result = await generateChapter({ prompt: prompt.trim() });
        const data = result.data as any;
        const chapter = data?.chapter || data;
        deckTitle = chapter?.name || chapter?.title || prompt.trim();
        deckDescription = chapter?.description || '';
        deckIcon = chapter?.icon || '📌';
        cards = chapter?.cards || [];
      } catch (fnError) {
        console.warn('AI generation unavailable, creating basic deck:', fnError);
      }

      const chapterDoc = await addDoc(collection(db, 'users', user.uid, 'chapters'), {
        title: deckTitle,
        description: deckDescription,
        icon: deckIcon,
        order: -Date.now(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (cards.length > 0) {
        const cardsRef = collection(db, 'users', user.uid, 'chapters', chapterDoc.id, 'cards');
        await Promise.all(
          cards.map((card: any, index: number) =>
            addDoc(cardsRef, {
              category: card.category || '',
              title: card.title || '',
              items: (card.items || []).map((item: any) => ({
                id: crypto.randomUUID(),
                text: typeof item === 'string' ? item : (item.text || ''),
                completed: false,
              })),
              order: index,
              createdAt: serverTimestamp(),
            })
          )
        );
      }
      await seedNotesTab(user.uid, chapterDoc.id);
      onCreated(chapterDoc.id);
    } catch (err: any) {
      setError(err.message || 'Failed to create deck');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full p-8 relative">
        <button onClick={onClose} disabled={loading} className="absolute top-4 right-4 p-2 hover:bg-slate-100 rounded-lg transition-colors">
          <X className="w-5 h-5 text-slate-600" />
        </button>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${aiMode ? 'bg-slate-900' : 'bg-slate-200'}`}>
              {aiMode
                ? <Sparkles className="w-5 h-5 text-white" />
                : <Zap className="w-5 h-5 text-slate-600" />
              }
            </div>
            <h2 className="text-2xl font-bold text-slate-900">New Deck</h2>
          </div>

          {/* Toggle */}
          <div className="flex items-center gap-3">
            <span className={`text-sm font-medium transition-colors ${!aiMode ? 'text-slate-900' : 'text-slate-400'}`}>
              Quick Add
            </span>
            <button
              type="button"
              onClick={() => { setAiMode((v) => !v); setError(''); }}
              className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none ${aiMode ? 'bg-slate-900' : 'bg-slate-200'}`}
              aria-label="Toggle AI mode"
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${aiMode ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
            <span className={`text-sm font-medium transition-colors ${aiMode ? 'text-slate-900' : 'text-slate-400'}`}>
              AI Build
            </span>
          </div>
        </div>

        {/* Quick Add form */}
        {!aiMode && (
          <form onSubmit={handleQuickAdd} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Deck name</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Moving Mom, Wedding 2025, New House..."
                className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900"
                required
                autoFocus
              />
            </div>
            {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
            <div className="flex gap-3">
              <button type="button" onClick={onClose} disabled={loading} className="flex-1 px-6 py-3 border border-slate-300 rounded-xl font-medium text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={loading || !title.trim()} className="flex-1 px-6 py-3 bg-slate-900 text-white rounded-xl font-medium hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                {loading ? <><Loader2 className="w-4 h-4 animate-spin" /><span>Creating...</span></> : <><Zap className="w-4 h-4" /><span>Create</span></>}
              </button>
            </div>
          </form>
        )}

        {/* AI Build form */}
        {aiMode && (
          <form onSubmit={handleAiBuild} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Deck name</label>
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. Moving Mom, Wedding 2025, New House..."
                className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900"
                required
                autoFocus
              />
            </div>
            {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
            <div className="flex gap-3">
              <button type="button" onClick={onClose} disabled={loading} className="flex-1 px-6 py-3 border border-slate-300 rounded-xl font-medium text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={loading || !prompt.trim()} className="flex-1 px-6 py-3 bg-slate-900 text-white rounded-xl font-medium hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                {loading ? <><Loader2 className="w-4 h-4 animate-spin" /><span>Building your deck...</span></> : <><Sparkles className="w-4 h-4" /><span>Build</span></>}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
