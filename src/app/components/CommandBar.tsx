/**
 * CommandBar — Multi-tab AI command bar
 *
 * A floating ✨ button sits in the bottom-right corner of every deck view.
 * The user types a natural-language instruction that can target any tab in
 * the deck — or multiple tabs at once.
 *
 * Example: "Add 4pm Nobu into the timeline and itinerary tab.
 *           Also add eggs to the shopping list."
 *
 * The instruction is sent to the `executeCommand` Firebase Function along
 * with the full list of custom tabs in the deck.  Claude returns an array
 * of typed action objects (one per target tab).  The component dispatches
 * all Firestore writes in parallel and refreshes the UI.
 */

import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db, functions } from '../../lib/firebase';
import {
  collection, addDoc, doc as fsDoc, updateDoc,
  getDocs, serverTimestamp,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  Sparkles, X, Loader2, Check, ChevronDown, AlertTriangle,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────

export type CommandBarTemplate =
  | 'timeline' | 'todo' | 'shopping' | 'contacts' | 'notes'
  | 'budget' | 'links' | 'inventory' | 'eventlog' | 'itinerary';

/** One entry in the available-tabs list sent to Claude */
export interface AvailableTab {
  tabId: string;
  tabName: string;
  template: CommandBarTemplate;
}

export interface CommandBarProps {
  /** All custom tabs in the current deck (used to build Claude's context) */
  availableTabs: AvailableTab[];
  /** The tab currently visible — used as default target for ambiguous instructions */
  activeTabId: string | null;
  /** Deck-level metadata */
  deckTitle: string;
  chapterId: string;
  ownerUid?: string;
  /** Called after writes complete so the parent can reload the active tab */
  onRefresh: () => void;
  /** Hide the button entirely (e.g. on built-in tabs with no writable template) */
  visible: boolean;
}

// ── Firestore write dispatcher (per action object from Claude) ─────────────

async function dispatchAction(
  action: any,
  tab: AvailableTab,
  chapterId: string,
  ownerUid: string,
): Promise<number> {
  const base = `users/${ownerUid}/chapters/${chapterId}/customTabs/${tab.tabId}`;
  if (!action || action.action === 'none') return 0;

  // ── timeline ──────────────────────────────────────────────────────────────
  if (tab.template === 'timeline' && action.action === 'add_items') {
    const items: any[] = action.items ?? [];
    for (const it of items) {
      if (!it.title?.trim()) continue;
      await addDoc(collection(db, `${base}/events`), {
        date: (it.date ?? '').trim(),
        title: it.title.trim(),
        description: (it.description ?? '').trim(),
        createdAt: serverTimestamp(),
      });
    }
    return items.filter(i => i.title?.trim()).length;
  }

  // ── todo ──────────────────────────────────────────────────────────────────
  if (tab.template === 'todo' && action.action === 'add_items') {
    const items: any[] = action.items ?? [];
    const existing = await getDocs(collection(db, `${base}/items`));
    let order = existing.size;
    for (const it of items) {
      if (!it.text?.trim()) continue;
      await addDoc(collection(db, `${base}/items`), {
        text: it.text.trim(), completed: false, order: order++, createdAt: serverTimestamp(),
      });
    }
    return items.filter(i => i.text?.trim()).length;
  }

  // ── shopping ──────────────────────────────────────────────────────────────
  if (tab.template === 'shopping' && action.action === 'add_items') {
    const items: any[] = action.items ?? [];
    const existing = await getDocs(collection(db, `${base}/items`));
    let order = existing.size;
    for (const it of items) {
      if (!it.text?.trim()) continue;
      await addDoc(collection(db, `${base}/items`), {
        text: it.text.trim(),
        quantity: (it.quantity ?? '').trim(),
        category: (it.category ?? '').trim(),
        completed: false,
        order: order++,
        createdAt: serverTimestamp(),
      });
    }
    return items.filter(i => i.text?.trim()).length;
  }

  // ── contacts ──────────────────────────────────────────────────────────────
  if (tab.template === 'contacts' && action.action === 'add_items') {
    const items: any[] = action.items ?? [];
    for (const it of items) {
      if (!it.name?.trim()) continue;
      await addDoc(collection(db, `${base}/contacts`), {
        name: it.name.trim(),
        role: (it.role ?? '').trim(),
        phone: (it.phone ?? '').trim(),
        email: (it.email ?? '').trim(),
        createdAt: serverTimestamp(),
      });
    }
    return items.filter(i => i.name?.trim()).length;
  }

  // ── notes ─────────────────────────────────────────────────────────────────
  if (tab.template === 'notes' && (action.action === 'add_note' || action.action === 'set_notes')) {
    const text = action.text ?? '';
    const title = (action.title ?? '').trim() || 'Note';
    const snap = await getDocs(collection(db, `${base}/note`));
    const order = snap.size;
    await addDoc(collection(db, `${base}/note`), {
      title, text, order, createdAt: serverTimestamp(),
    });
    return 1;
  }

  // ── budget ────────────────────────────────────────────────────────────────
  if (tab.template === 'budget' && action.action === 'add_items') {
    const items: any[] = action.items ?? [];
    for (const it of items) {
      if (!it.description?.trim()) continue;
      await addDoc(collection(db, `${base}/items`), {
        description: it.description.trim(),
        type: it.type === 'income' ? 'income' : 'expense',
        amount: typeof it.amount === 'number' ? it.amount : parseFloat(it.amount) || 0,
        category: (it.category ?? '').trim(),
        date: (it.date ?? '').trim(),
        status: ['paid', 'unpaid', 'estimated'].includes(it.status) ? it.status : 'unpaid',
        note: (it.note ?? '').trim(),
        createdAt: serverTimestamp(),
      });
    }
    return items.filter(i => i.description?.trim()).length;
  }

  // ── links ─────────────────────────────────────────────────────────────────
  if (tab.template === 'links' && action.action === 'add_items') {
    const items: any[] = action.items ?? [];
    for (const it of items) {
      if (!it.url?.trim()) continue;
      const url = /^https?:\/\//i.test(it.url.trim()) ? it.url.trim() : `https://${it.url.trim()}`;
      await addDoc(collection(db, `${base}/items`), {
        url,
        title: (it.title ?? url).trim(),
        tag: (it.tag ?? '').trim(),
        note: (it.note ?? '').trim(),
        createdAt: serverTimestamp(),
      });
    }
    return items.filter(i => i.url?.trim()).length;
  }

  // ── inventory ─────────────────────────────────────────────────────────────
  if (tab.template === 'inventory' && action.action === 'add_items') {
    const items: any[] = action.items ?? [];
    for (const it of items) {
      if (!it.name?.trim()) continue;
      await addDoc(collection(db, `${base}/items`), {
        name: it.name.trim(),
        category: (it.category ?? '').trim(),
        quantity: parseInt(it.quantity, 10) || 1,
        condition: ['Excellent','Good','Fair','Poor'].includes(it.condition) ? it.condition : 'Good',
        location: (it.location ?? '').trim(),
        value: (it.value ?? '').trim(),
        notes: (it.notes ?? '').trim(),
        createdAt: serverTimestamp(),
      });
    }
    return items.filter(i => i.name?.trim()).length;
  }

  // ── eventlog ──────────────────────────────────────────────────────────────
  if (tab.template === 'eventlog' && action.action === 'add_items') {
    const items: any[] = action.items ?? [];
    const existing = await getDocs(collection(db, `${base}/entries`));
    let order = existing.size;
    for (const it of items) {
      if (!it.text?.trim()) continue;
      await addDoc(collection(db, `${base}/entries`), {
        date: (it.date ?? '').trim(),
        time: (it.time ?? '').trim(),
        text: it.text.trim(),
        order: order++,
        createdAt: serverTimestamp(),
      });
    }
    return items.filter(i => i.text?.trim()).length;
  }

  // ── itinerary ─────────────────────────────────────────────────────────────
  if (tab.template === 'itinerary' && action.action === 'add_items') {
    const items: any[] = action.items ?? [];
    const existing = await getDocs(collection(db, `${base}/segments`));
    let order = existing.size;
    const VALID_CATS = ['flight','hotel','car','activity','transfer','note'];
    for (const it of items) {
      if (!it.title?.trim()) continue;
      await addDoc(collection(db, `${base}/segments`), {
        title: it.title.trim(),
        category: VALID_CATS.includes(it.category) ? it.category : 'note',
        date: (it.date ?? '').trim(),
        address: (it.address ?? '').trim(),
        details: Array.isArray(it.details) ? it.details.filter(Boolean).slice(0, 8) : [],
        manuallyAdded: true,
        order: order++,
        createdAt: serverTimestamp(),
      });
    }
    return items.filter(i => i.title?.trim()).length;
  }

  return 0;
}

// ── Placeholder text ───────────────────────────────────────────────────────

const GLOBAL_PLACEHOLDER =
  'e.g. Add milk to the shopping list, and add LAX flight 504 on August 1 2026 to my itinerary.';

// ── Component ──────────────────────────────────────────────────────────────

export function CommandBar({
  availableTabs,
  activeTabId,
  deckTitle,
  chapterId,
  ownerUid,
  onRefresh,
  visible,
}: CommandBarProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ tabName: string; count: number }[]>([]);
  const [error, setError] = useState('');
  const [showTabs, setShowTabs] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setResults([]);
      setError('');
      setShowTabs(false);
      setTimeout(() => textareaRef.current?.focus(), 80);
    }
  }, [open]);

  if (!visible || availableTabs.length === 0) return null;

  const handleSubmit = async () => {
    if (!user || !instruction.trim() || loading) return;
    setLoading(true);
    setError('');
    setResults([]);

    try {
      const executeCommand = httpsCallable(functions, 'executeCommand');
      const response = await executeCommand({
        instruction: instruction.trim(),
        context: {
          deckTitle,
          availableTabs,
          activeTabId: activeTabId ?? '',
        },
      }) as any;

      const actions: any[] = response.data?.actions ?? [];

      if (!actions.length || (actions.length === 1 && actions[0].action === 'none')) {
        setError(actions[0]?.message ?? 'Claude couldn\'t interpret that. Try rephrasing.');
        return;
      }

      // Dispatch all writes in parallel
      const ownerUidResolved = ownerUid ?? user.uid;
      const writeResults = await Promise.all(
        actions
          .filter(a => a.action !== 'none' && a.tabId)
          .map(async (action) => {
            const tab = availableTabs.find(t => t.tabId === action.tabId);
            if (!tab) return null;
            const count = await dispatchAction(action, tab, chapterId, ownerUidResolved);
            return { tabName: tab.tabName, count };
          })
      );

      const successful = writeResults.filter(r => r && r.count > 0) as { tabName: string; count: number }[];

      if (successful.length === 0) {
        setError('No items were added. Try being more specific.');
        return;
      }

      setResults(successful);
      setInstruction('');
      onRefresh();

      setTimeout(() => {
        setOpen(false);
        setResults([]);
      }, 2200);

    } catch (err: any) {
      console.error('[CommandBar] error:', err);
      setError(err?.message?.replace('Firebase: ', '') ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <>
      {/* ── Floating trigger button ── */}
      <button
        onClick={() => setOpen(true)}
        title="AI Command Bar — talk to your deck"
        className="fixed bottom-6 right-6 z-40 w-12 h-12 rounded-full bg-slate-900 text-white shadow-xl hover:bg-slate-700 active:scale-95 transition-all flex items-center justify-center"
        style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.28)' }}
      >
        <Sparkles className="w-5 h-5" />
      </button>

      {/* ── Modal ── */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-slate-900 flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">ARKstamp AI</p>
                  <p className="text-xs text-slate-400">{deckTitle}</p>
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {/* Textarea */}
            <div className="px-5 pb-3">
              <textarea
                ref={textareaRef}
                value={instruction}
                onChange={e => { setInstruction(e.target.value); setError(''); setResults([]); }}
                onKeyDown={handleKeyDown}
                placeholder={GLOBAL_PLACEHOLDER}
                rows={3}
                className="w-full px-4 py-3 rounded-2xl border border-slate-200 text-sm text-slate-800 placeholder-slate-400 resize-none focus:outline-none focus:border-slate-900 transition-colors leading-relaxed"
              />
              <p className="text-[11px] text-slate-400 mt-1.5 text-right">⌘ Enter to send</p>
            </div>

            {/* Error */}
            {error && (
              <div className="mx-5 mb-3 flex items-start gap-2 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
                <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-red-600 leading-snug">{error}</p>
              </div>
            )}

            {/* Success — show per-tab summary */}
            {results.length > 0 && (
              <div className="mx-5 mb-3 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2.5 space-y-1">
                {results.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                    <p className="text-xs text-emerald-700 font-medium">
                      {r.count} {r.count === 1 ? 'item' : 'items'} added to <span className="font-semibold">{r.tabName}</span>
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Available tabs hint */}
            <div className="px-5 pb-3">
              <button
                onClick={() => setShowTabs(v => !v)}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-700 transition-colors"
              >
                <ChevronDown className={`w-3 h-3 transition-transform ${showTabs ? 'rotate-180' : ''}`} />
                {showTabs ? 'Hide' : 'Show'} available tabs ({availableTabs.length})
              </button>
              {showTabs && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {availableTabs.map(t => (
                    <span
                      key={t.tabId}
                      className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                        t.tabId === activeTabId
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {t.tabName}
                      <span className="ml-1 opacity-50">({t.template})</span>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 pb-5 flex items-center gap-3">
              <button
                onClick={handleSubmit}
                disabled={!instruction.trim() || loading}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-slate-900 text-white text-sm font-semibold rounded-2xl hover:bg-slate-800 disabled:opacity-30 transition-colors"
              >
                {loading
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Working…</>
                  : <><Sparkles className="w-4 h-4" />Run Command</>
                }
              </button>
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2.5 text-sm text-slate-500 hover:text-slate-900 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
