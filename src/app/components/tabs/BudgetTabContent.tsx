import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc,
  onSnapshot, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { Plus, Trash2, Loader2, X, TrendingUp, TrendingDown } from 'lucide-react';

type BudgetType = 'income' | 'expense';
type BudgetStatus = 'paid' | 'unpaid' | 'estimated';

const BUDGET_CATS_EXPENSE = ['Vendor', 'Venue', 'Travel', 'Food', 'Legal', 'Medical', 'Housing', 'Misc'];
const BUDGET_CATS_INCOME  = ['Savings', 'Gift', 'Sale', 'Reimbursement', 'Other'];

interface BudgetItem { id: string; description: string; type: BudgetType; amount: number; category: string; date: string; status: BudgetStatus; note: string; }
const EMPTY_BUDGET = { description: '', type: 'expense' as BudgetType, amount: '', category: '', date: '', status: 'unpaid' as BudgetStatus, note: '' };
const STATUS_COLORS: Record<BudgetStatus, string> = { paid: 'bg-emerald-50 text-emerald-700', unpaid: 'bg-amber-50 text-amber-700', estimated: 'bg-slate-100 text-slate-500' };

interface BudgetTabContentProps {
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

export function BudgetContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: BudgetTabContentProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [items, setItems] = useState<BudgetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_BUDGET);
  const [saving, setSaving] = useState(false);

  const col = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/items`;

  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(query(collection(db, col()), orderBy('createdAt', 'desc')), snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() } as BudgetItem)));
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  const sf = (f: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(p => ({ ...p, [f]: e.target.value }));

  const handleAdd = async () => {
    if (!user || !form.description.trim() || !form.amount) return;
    setSaving(true);
    await addDoc(collection(db, col()), {
      description: form.description.trim(),
      type: form.type,
      amount: parseFloat(String(form.amount)) || 0,
      category: form.category.trim(),
      date: form.date,
      status: form.status,
      note: form.note.trim(),
      createdAt: serverTimestamp(),
    });
    setForm(EMPTY_BUDGET);
    setShowForm(false);
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!user) return;
    await deleteDoc(fsDoc(db, col(), id));
  };

  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
  const totalIn = items.filter(i => i.type === 'income').reduce((s, i) => s + (i.amount || 0), 0);
  const totalOut = items.filter(i => i.type === 'expense').reduce((s, i) => s + (i.amount || 0), 0);
  const cats = form.type === 'income' ? BUDGET_CATS_INCOME : BUDGET_CATS_EXPENSE;

  if (loading) return <Spinner />;

  return (
    <div className="max-w-2xl space-y-5">
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {([['Income', totalIn, 'text-emerald-600'], ['Expenses', totalOut, 'text-red-500'], ['Net', totalIn - totalOut, totalIn - totalOut >= 0 ? 'text-emerald-600' : 'text-red-500']] as [string, number, string][]).map(([l, v, c]) => (
            <div key={l} className="bg-white rounded-2xl border border-slate-100 shadow-sm px-4 py-3">
              <p className="text-xs text-slate-400 mb-1">{l}</p>
              <p className={`text-base font-semibold ${c}`}>{fmt(v)}</p>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm px-4 py-3.5 flex items-start gap-3 group">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${item.type === 'income' ? 'bg-emerald-50' : 'bg-red-50'}`}>
              {item.type === 'income' ? <TrendingUp className="w-4 h-4 text-emerald-600" /> : <TrendingDown className="w-4 h-4 text-red-500" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">{item.description}</p>
                <p className={`text-sm font-semibold flex-shrink-0 ${item.type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
                  {item.type === 'income' ? '+' : '-'}{fmt(item.amount)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                {item.category && <span className="text-xs text-slate-500 bg-slate-50 rounded-full px-2 py-0.5">{item.category}</span>}
                {item.date && <span className="text-xs text-slate-400">{item.date}</span>}
                <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${STATUS_COLORS[item.status as BudgetStatus] ?? STATUS_COLORS.estimated}`}>{item.status}</span>
              </div>
              {item.note && <p className="text-xs text-slate-400 mt-1">{item.note}</p>}
            </div>
            <button onClick={() => handleDelete(item.id)} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-50 transition-all flex-shrink-0">
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
            </button>
          </div>
        ))}
      </div>

      {showForm ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">New Entry</p>
            <button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4 text-slate-400" /></button>
          </div>
          <div className="flex rounded-xl border border-slate-200 overflow-hidden text-sm">
            {(['expense', 'income'] as BudgetType[]).map(t => (
              <button key={t} onClick={() => setForm(f => ({ ...f, type: t, category: '' }))} className={`flex-1 py-2.5 font-medium transition-colors ${form.type === t ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <input placeholder="Description *" value={form.description} onChange={sf('description')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          <div className="grid grid-cols-2 gap-3">
            <input type="number" min="0" step="0.01" placeholder="Amount *" value={form.amount} onChange={sf('amount')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
            <input type="date" value={form.date} onChange={sf('date')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 text-slate-700" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select value={form.category} onChange={sf('category')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 bg-white text-slate-700">
              <option value="">Category</option>
              {cats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={form.status} onChange={sf('status')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 bg-white text-slate-700">
              <option value="unpaid">Unpaid</option>
              <option value="paid">Paid</option>
              <option value="estimated">Estimated</option>
            </select>
          </div>
          <input placeholder="Note (optional)" value={form.note} onChange={sf('note')} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900" />
          <button onClick={handleAdd} disabled={!form.description.trim() || !form.amount || saving} className="w-full py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 disabled:opacity-30 transition-colors">
            {saving ? 'Adding...' : 'Add Entry'}
          </button>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 transition-colors">
          <Plus className="w-4 h-4" />Add entry
        </button>
      )}
      {items.length === 0 && !showForm && <p className="text-center text-sm text-slate-400 pt-4">No entries yet</p>}
    </div>
  );
}
