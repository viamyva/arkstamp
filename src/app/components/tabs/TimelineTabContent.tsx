import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { Plus, Trash2, Loader2, X, Check, Edit2, Calendar as CalendarIcon } from 'lucide-react';
import { CalendarSidebar } from './CalendarSidebar';

interface EventItem { id: string; date: string; title: string; description?: string; }
const EMPTY_EVENT = { date: '', title: '', description: '' };

interface TimelineTabContentProps {
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

export function TimelineContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: TimelineTabContentProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_EVENT);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_EVENT);
  const [editSaving, setEditSaving] = useState(false);

  const colPath = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/events`;

  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(collection(db, colPath()), snap => {
      setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() } as EventItem)).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()));
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  const setField = (field: keyof typeof EMPTY_EVENT) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm(f => ({ ...f, [field]: e.target.value }));

  const setEditField = (field: keyof typeof EMPTY_EVENT) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setEditForm(f => ({ ...f, [field]: e.target.value }));

  const handleAdd = async () => {
    if (!user || !form.date || !form.title.trim()) return;
    setSaving(true);
    await addDoc(collection(db, colPath()), { ...form, createdAt: serverTimestamp() });
    setForm(EMPTY_EVENT);
    setShowForm(false);
    setSaving(false);
  };

  const openEdit = (event: EventItem) => {
    setEditingId(event.id);
    setEditForm({ date: event.date, title: event.title, description: event.description ?? '' });
    setShowForm(false);
  };

  const saveEdit = async () => {
    if (!user || !editingId || !editForm.date || !editForm.title.trim()) return;
    setEditSaving(true);
    await updateDoc(fsDoc(db, colPath(), editingId), {
      date: editForm.date,
      title: editForm.title.trim(),
      description: editForm.description.trim(),
    });
    setEditingId(null);
    setEditSaving(false);
  };

  if (loading) return <Spinner />;

  return (
    <div className="max-w-[1400px] mx-auto px-4">
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Left Column: Timeline */}
        <div className="flex-1 min-w-0 space-y-4">
          {events.length > 0 && (
            <div className="relative pl-10">
              <div className="absolute left-4 top-2 bottom-2 w-px bg-slate-200" />
              <div className="space-y-3">
                {events.map(event => (
                  <div key={event.id} className="relative flex items-start gap-3 group">
                    <div className="absolute -left-6 top-3 w-5 h-5 rounded-full bg-white border-2 border-slate-200 flex items-center justify-center">
                      <CalendarIcon className="w-2.5 h-2.5 text-slate-400" />
                    </div>
                    {editingId === event.id ? (
                      <div className="flex-1 bg-white rounded-xl border border-slate-300 shadow-sm px-4 py-3 space-y-2">
                        <input
                          type="date"
                          value={editForm.date}
                          onChange={setEditField('date')}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors"
                        />
                        <input
                          placeholder="Event title *"
                          value={editForm.title}
                          onChange={setEditField('title')}
                          autoFocus
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors"
                        />
                        <textarea
                          placeholder="Notes (optional)"
                          value={editForm.description}
                          onChange={setEditField('description')}
                          rows={8}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors resize-none"
                        />
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={saveEdit}
                            disabled={!editForm.date || !editForm.title.trim() || editSaving}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-30 transition-colors"
                          >
                            <Check className="w-3 h-3" />{editSaving ? 'Saving...' : 'Save'}
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-900 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex-1 bg-white rounded-xl border border-slate-100 shadow-sm px-4 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-xs text-slate-400 mb-0.5">
                              {new Date(event.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                            </p>
                            <p className="text-sm font-semibold text-slate-900">{event.title}</p>
                            {event.description && <p className="text-xs text-slate-500 mt-0.5 leading-relaxed whitespace-pre-wrap">{event.description}</p>}
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                            <button onClick={() => openEdit(event)} className="p-1 rounded hover:bg-slate-100 transition-colors">
                              <Edit2 className="w-3.5 h-3.5 text-slate-400" />
                            </button>
                            <button onClick={() => deleteDoc(fsDoc(db, colPath(), event.id))} className="p-1 rounded hover:bg-red-50 transition-colors">
                              <Trash2 className="w-3.5 h-3.5 text-red-400" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {showForm ? (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">New Event</p>
                <button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-slate-100 transition-colors"><X className="w-4 h-4 text-slate-400" /></button>
              </div>
              <input type="date" value={form.date} onChange={setField('date')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
              <input placeholder="Event title *" value={form.title} onChange={setField('title')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors" />
              <textarea placeholder="Notes (optional)" value={form.description} onChange={setField('description')} rows={8} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors resize-none" />
              <button onClick={handleAdd} disabled={!form.date || !form.title.trim() || saving} className="w-full py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 transition-colors disabled:opacity-30">
                {saving ? 'Adding...' : 'Add Event'}
              </button>
            </div>
          ) : (
            <button onClick={() => { setShowForm(true); setEditingId(null); }} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 transition-colors">
              <Plus className="w-4 h-4" />Add event
            </button>
          )}
          {events.length === 0 && !showForm && <p className="text-center text-sm text-slate-400 pt-4">No events yet</p>}
        </div>

        {/* Right Column: Google Calendar Sidebar */}
        <div className="w-full lg:w-[350px] flex-shrink-0">
          <CalendarSidebar />
        </div>
      </div>
    </div>
  );
}
