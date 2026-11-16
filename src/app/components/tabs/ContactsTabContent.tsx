import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc,
  onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { Plus, Trash2, Loader2, X } from 'lucide-react';

interface ContactItem { id: string; name: string; role: string; phone: string; email: string; }
const EMPTY_CONTACT = { name: '', role: '', phone: '', email: '' };

interface ContactsTabContentProps {
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

export function ContactsContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: ContactsTabContentProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_CONTACT);
  const [saving, setSaving] = useState(false);

  const colPath = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/contacts`;

  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(collection(db, colPath()), snap => {
      setContacts(snap.docs.map(d => ({ id: d.id, ...d.data() } as ContactItem)));
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  const setField = (field: keyof typeof EMPTY_CONTACT) =>
    (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleAdd = async () => {
    if (!user || !form.name.trim()) return;
    setSaving(true);
    await addDoc(collection(db, colPath()), { ...form, createdAt: serverTimestamp() });
    setForm(EMPTY_CONTACT);
    setShowForm(false);
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!user) return;
    await deleteDoc(fsDoc(db, colPath(), id));
  };

  const initials = (name: string) => name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

  if (loading) return <Spinner />;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {contacts.map(c => (
          <div key={c.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-start gap-3 group">
            <div className="w-10 h-10 rounded-full bg-slate-900 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
              {initials(c.name)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-slate-900 text-sm">{c.name}</p>
              {c.role && <p className="text-xs text-slate-500 mt-0.5">{c.role}</p>}
              {c.phone && <a href={`tel:${c.phone}`} className="text-xs text-slate-600 hover:text-slate-900 block mt-1">{c.phone}</a>}
              {c.email && <a href={`mailto:${c.email}`} className="text-xs text-slate-600 hover:text-slate-900 block">{c.email}</a>}
            </div>
            <button onClick={() => handleDelete(c.id)} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-50 transition-all flex-shrink-0">
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
            </button>
          </div>
        ))}
      </div>
      {showForm ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">New Contact</p>
            <button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-slate-100 transition-colors"><X className="w-4 h-4 text-slate-400" /></button>
          </div>
          <input placeholder="Name *" value={form.name} onChange={setField('name')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
          <input placeholder="Role" value={form.role} onChange={setField('role')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
          <input placeholder="Phone" value={form.phone} onChange={setField('phone')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
          <input placeholder="Email" value={form.email} onChange={setField('email')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
          <button onClick={handleAdd} disabled={!form.name.trim() || saving} className="w-full py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 transition-colors disabled:opacity-30">
            {saving ? 'Adding...' : 'Add Contact'}
          </button>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 transition-colors">
          <Plus className="w-4 h-4" />Add contact
        </button>
      )}
      {contacts.length === 0 && !showForm && <p className="text-center text-sm text-slate-400 pt-4">No contacts yet</p>}
    </div>
  );
}
