import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { Plus, Trash2, Loader2 } from 'lucide-react';

interface NoteDoc { id: string; title: string; text: string; order: number; }

interface NotesTabProps {
  chapterId: string;
  tabId: string;
  ownerUid?: string;
  refreshKey?: number;
  autoFocusNote?: boolean;
}

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
    </div>
  );
}

export function NotesContent({ chapterId, tabId, ownerUid, refreshKey = 0, autoFocusNote = false }: NotesTabProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [notes, setNotes] = useState<NoteDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const debounceRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const firstTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Notes with an unsaved edit in flight (typed locally, not yet written to
  // Firestore) or mid-rename, so an incoming realtime update never overwrites
  // what the user is actively doing.
  const dirtyTextIds = useRef<Set<string>>(new Set());
  const renamingIdRef = useRef<string | null>(null);
  useEffect(() => { renamingIdRef.current = renamingId; }, [renamingId]);

  const colPath = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/note`;

  // Live listener: any change here (this window, another window, or another
  // user on a shared deck) pushes straight into state, no refresh needed.
  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(
      collection(db, colPath()),
      snap => {
        const incoming = snap.docs
          .map(d => ({ id: d.id, title: d.data().title ?? 'Note', text: d.data().text ?? '', order: d.data().order ?? 0 } as NoteDoc))
          .sort((a, b) => a.order - b.order);

        setNotes(prev => incoming.map(n => {
          const local = prev.find(p => p.id === n.id);
          if (!local) return n;
          if (dirtyTextIds.current.has(n.id)) return { ...n, text: local.text };
          if (renamingIdRef.current === n.id) return { ...n, title: local.title };
          return n;
        }));
        setLoading(false);
      },
      err => {
        console.error(err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  useEffect(() => {
    if (autoFocusNote && !loading && notes.length > 0) {
      firstTextareaRef.current?.focus({ preventScroll: true });
    }
  }, [autoFocusNote, loading]);

  const saveText = (note: NoteDoc, val: string) => {
    setNotes(prev => prev.map(n => n.id === note.id ? { ...n, text: val } : n));
    dirtyTextIds.current.add(note.id);
    const existing = debounceRefs.current.get(note.id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      if (!user) return;
      setSavingId(note.id);
      await updateDoc(fsDoc(db, colPath(), note.id), { text: val, updatedAt: serverTimestamp() }).catch(console.error);
      dirtyTextIds.current.delete(note.id);
      setSavingId(null);
    }, 1000);
    debounceRefs.current.set(note.id, t);
  };

  const addNote = async () => {
    if (!user) return;
    const order = notes.length;
    await addDoc(collection(db, colPath()), {
      title: `Note ${order + 1}`,
      text: '',
      order,
      createdAt: serverTimestamp(),
    });
  };

  const deleteNote = async (id: string) => {
    if (!user) return;
    await deleteDoc(fsDoc(db, colPath(), id)).catch(console.error);
  };

  const startRename = (note: NoteDoc) => {
    setRenamingId(note.id);
    setRenameValue(note.title);
  };

  const saveRename = async (id: string) => {
    const val = renameValue.trim();
    if (!val || !user) { setRenamingId(null); return; }
    setNotes(prev => prev.map(n => n.id === id ? { ...n, title: val } : n));
    setRenamingId(null);
    await updateDoc(fsDoc(db, colPath(), id), { title: val }).catch(console.error);
  };

  if (loading) return <Spinner />;

  return (
    <div className="max-w-5xl">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {notes.map((note, index) => (
          <div key={note.id} className="relative group">
            <div className="flex items-center justify-between mb-1.5 px-1">
              {renamingId === note.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={() => saveRename(note.id)}
                  onKeyDown={e => { if (e.key === 'Enter') saveRename(note.id); if (e.key === 'Escape') setRenamingId(null); }}
                  className="text-xs font-semibold text-slate-700 bg-transparent border-b border-slate-400 focus:outline-none w-40"
                />
              ) : (
                <button
                  onClick={() => startRename(note)}
                  className="text-xs font-semibold text-slate-500 hover:text-slate-900 transition-colors"
                  title="Click to rename"
                >
                  {note.title}
                </button>
              )}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {savingId === note.id && (
                  <span className="flex items-center gap-1 text-xs text-slate-400">
                    <Loader2 className="w-3 h-3 animate-spin" />Saving
                  </span>
                )}
                {notes.length > 1 && (
                  <button
                    onClick={() => deleteNote(note.id)}
                    className="p-1 rounded hover:bg-red-50 transition-colors"
                    title="Delete note"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  </button>
                )}
              </div>
            </div>
            <div className="relative">
              <textarea
                ref={index === 0 ? firstTextareaRef : undefined}
                value={note.text}
                onChange={e => saveText(note, e.target.value)}
                placeholder="Start writing..."
                autoFocus={autoFocusNote && index === 0}
                style={{ fontSize: '16px' }}
                className="w-full min-h-[400px] bg-white rounded-2xl border border-slate-100 shadow-sm px-6 py-5 text-slate-800 placeholder-slate-400 resize-none focus:outline-none focus:border-slate-300 leading-relaxed transition-colors"
              />
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={addNote}
        className="flex items-center gap-2 mt-4 text-sm text-slate-500 hover:text-slate-900 transition-colors"
      >
        <Plus className="w-4 h-4" />Add note
      </button>

      {notes.length === 0 && (
        <button
          onClick={addNote}
          className="w-full bg-white rounded-2xl border border-dashed border-slate-200 px-6 py-8 text-sm text-slate-400 hover:border-slate-400 hover:text-slate-600 transition-colors mt-4"
        >
          + Start your first note
        </button>
      )}
    </div>
  );
}
