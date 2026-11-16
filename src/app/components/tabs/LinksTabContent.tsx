import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc,
  onSnapshot, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { Plus, Trash2, Loader2, X, Link2, ExternalLink, Hash } from 'lucide-react';

interface LinkItem { id: string; title: string; url: string; note: string; tag: string; }
const EMPTY_LINK = { title: '', url: '', note: '', tag: '' };

interface LinksTabContentProps {
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

export function LinksContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: LinksTabContentProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_LINK);
  const [saving, setSaving] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  const col = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/items`;

  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(query(collection(db, col()), orderBy('createdAt', 'desc')), snap => {
      setLinks(snap.docs.map(d => ({ id: d.id, ...d.data() } as LinkItem)));
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  const sf = (f: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(p => ({ ...p, [f]: e.target.value }));

  const norm = (u: string) => { const t = u.trim(); return /^https?:\/\//i.test(t) ? t : 'https://' + t; };

  const handleAdd = async () => {
    if (!user || !form.url.trim()) return;
    setSaving(true);
    const url = norm(form.url);
    await addDoc(collection(db, col()), {
      title: form.title.trim() || url,
      url,
      note: form.note.trim(),
      tag: form.tag.trim(),
      createdAt: serverTimestamp(),
    });
    setForm(EMPTY_LINK);
    setShowForm(false);
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!user) return;
    await deleteDoc(fsDoc(db, col(), id));
  };

  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const tags = [...new Set(links.map(l => l.tag || ''))].sort();

  if (loading) return <Spinner />;

  return (
    <div className="max-w-2xl space-y-5">
      {tags.map(tag => (
        <div key={tag || '__untagged'} className="space-y-2">
          {tag && (
            <div className="flex items-center gap-2 px-1">
              <Hash className="w-3 h-3 text-slate-400" />
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{tag}</p>
            </div>
          )}
          {links.filter(l => (l.tag || '') === tag).map(link => (
            <div key={link.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm px-4 py-3.5 flex items-start gap-3 group">
              <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Link2 className="w-3.5 h-3.5 text-slate-500" />
              </div>
              <div className="flex-1 min-w-0">
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 group/link">
                  <p className="text-sm font-semibold text-slate-900 group-hover/link:text-slate-600 transition-colors leading-snug truncate">{link.title}</p>
                  <ExternalLink className="w-3 h-3 text-slate-400 flex-shrink-0" />
                </a>
                <p className="text-xs text-slate-400 mt-0.5 truncate">{host(link.url)}</p>
                {link.note && <p className="text-xs text-slate-500 mt-1 leading-snug">{link.note.slice(0, 120)}</p>}
              </div>
              <button onClick={() => handleDelete(link.id)} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-50 transition-all flex-shrink-0">
                <Trash2 className="w-3.5 h-3.5 text-red-400" />
              </button>
            </div>
          ))}
        </div>
      ))}

      {showForm ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Add a Link</p>
            <button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4 text-slate-400" /></button>
          </div>
          <input ref={urlRef} placeholder="URL *" value={form.url} onChange={sf('url')} onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          <input placeholder="Title (optional)" value={form.title} onChange={sf('title')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Tag (optional)" value={form.tag} onChange={sf('tag')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            <input placeholder="Note (optional)" value={form.note} onChange={sf('note')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          </div>
          <button onClick={handleAdd} disabled={!form.url.trim() || saving} className="w-full py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 disabled:opacity-30 transition-colors">
            {saving ? 'Saving...' : 'Save Link'}
          </button>
        </div>
      ) : (
        <button onClick={() => { setShowForm(true); setTimeout(() => urlRef.current?.focus(), 50); }} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 transition-colors">
          <Plus className="w-4 h-4" />Add link
        </button>
      )}
      {links.length === 0 && !showForm && <p className="text-center text-sm text-slate-400 pt-4">No links yet</p>}
    </div>
  );
}
