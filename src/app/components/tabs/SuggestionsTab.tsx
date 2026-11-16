import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db, functions } from '../../../lib/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Sparkles, X, Plus, Check, Loader2 } from 'lucide-react';

const BANNER_KEY = 'ark-suggestions-banner-dismissed';

interface Suggestion {
  id: string;
  title: string;
  category: string;
  items: string[];
}

interface SuggestionsTabProps {
  chapterId: string;
  ownerUid?: string;
  chapterTitle: string;
  cards: any[];
}

export function SuggestionsTab({ chapterId, ownerUid, chapterTitle, cards }: SuggestionsTabProps) {
  const { user } = useAuth();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(BANNER_KEY) === 'true');

  const existingTitles = cards.map(c => c.title).filter(Boolean).join(', ');

  const fetchSuggestions = async (isMore = false) => {
    isMore ? setLoadingMore(true) : setLoading(true);
    try {
      const generateChapter = httpsCallable(functions, 'generateChapter');
      const alreadyHas = existingTitles ? ` These sections already exist: ${existingTitles}. Suggest only NEW sections.` : '';
      const prompt = `Suggest 4 practical sections to add to a life planning deck called "${chapterTitle}".${alreadyHas} Each section should have 3-5 relevant, specific action items. Return cards with concise titles (4-6 words).`;
      const result = await generateChapter({ prompt });
      const data = result.data as any;
      const chapter = data?.chapter || data;
      const incoming: Suggestion[] = (chapter?.cards || [])
        .slice(0, 5)
        .map((c: any, i: number) => ({
          id: `${Date.now()}-${i}`,
          title: c.title || c.name || '',
          category: c.category || '',
          items: (c.items || [])
            .map((item: any) => typeof item === 'string' ? item : (item.text || ''))
            .filter(Boolean)
            .slice(0, 5),
        }))
        .filter((s: Suggestion) => s.title);
      isMore
        ? setSuggestions(prev => [...prev, ...incoming])
        : setSuggestions(incoming);
    } catch {
      if (!isMore) {
        setSuggestions([
          { id: 'f1', title: 'Key contacts list', category: 'People', items: ['Add attorney or legal contact', 'Add realtor or agent', 'Add moving company', 'Add utility contacts'] },
          { id: 'f2', title: 'Budget tracker', category: 'Finance', items: ['Set total budget', 'Log deposits paid', 'Track unexpected costs', 'Review final spend'] },
          { id: 'f3', title: 'Important documents', category: 'Admin', items: ['Gather ID documents', 'Collect insurance docs', 'Organize signed contracts', 'Save digital copies'] },
          { id: 'f4', title: 'Next steps', category: 'Planning', items: ['Confirm key dates', 'Assign responsibilities', 'Set follow-up reminders', 'Schedule progress check-in'] },
        ]);
      }
    } finally {
      isMore ? setLoadingMore(false) : setLoading(false);
    }
  };

  useEffect(() => { fetchSuggestions(); }, []);

  const addToOverview = async (suggestion: Suggestion) => {
    if (!user || addedIds.has(suggestion.id)) return;
    try {
      await addDoc(collection(db, 'users', ownerUid ?? user.uid, 'chapters', chapterId, 'cards'), {
        category: suggestion.category,
        title: suggestion.title,
        items: suggestion.items.map(text => ({
          id: crypto.randomUUID(),
          text,
          completed: false,
        })),
        order: cards.length + addedIds.size,
        createdAt: serverTimestamp(),
      });
      setAddedIds(prev => new Set(prev).add(suggestion.id));
    } catch (err) {
      console.error('Error adding section:', err);
    }
  };

  const dismissBanner = () => {
    localStorage.setItem(BANNER_KEY, 'true');
    setDismissed(true);
  };

  return (
    <div className="space-y-3">
      {/* Dismissable banner */}
      {!dismissed && (
        <div className="bg-[#ede9de] rounded-2xl p-5 flex items-start gap-3">
          <div className="w-9 h-9 bg-slate-900 rounded-xl flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-900">ARKstamp Intelligence</p>
            <p className="text-sm text-slate-600 mt-0.5">Tap any suggestion to add it as a section in your To Do tab.</p>
          </div>
          <button onClick={dismissBanner} className="p-1 hover:bg-black/10 rounded-lg transition-colors flex-shrink-0 mt-0.5">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center py-16 gap-3">
          <Loader2 className="w-7 h-7 text-slate-400 animate-spin" />
          <p className="text-sm text-slate-500">Generating suggestions...</p>
        </div>
      ) : (
        <>
          {suggestions.map(suggestion => {
            const added = addedIds.has(suggestion.id);
            return (
              <button
                key={suggestion.id}
                onClick={() => addToOverview(suggestion)}
                disabled={added}
                className={`w-full text-left bg-white rounded-xl border shadow-sm px-5 py-4 transition-all ${
                  added
                    ? 'border-green-200 opacity-60 cursor-default'
                    : 'border-slate-100 hover:shadow-md active:scale-[0.99]'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {suggestion.category && (
                      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">{suggestion.category}</p>
                    )}
                    <p className="font-semibold text-slate-900 leading-snug">{suggestion.title}</p>
                    {suggestion.items.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {suggestion.items.slice(0, 3).map((item, i) => (
                          <li key={i} className="text-xs text-slate-500 flex items-center gap-1.5">
                            <span className="w-1 h-1 bg-slate-300 rounded-full flex-shrink-0" />
                            {item}
                          </li>
                        ))}
                        {suggestion.items.length > 3 && (
                          <li className="text-xs text-slate-400 pl-2.5">+{suggestion.items.length - 3} more</li>
                        )}
                      </ul>
                    )}
                  </div>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${added ? 'bg-green-100' : 'bg-slate-100'}`}>
                    {added
                      ? <Check className="w-4 h-4 text-green-600" />
                      : <Plus className="w-4 h-4 text-slate-500" />
                    }
                  </div>
                </div>
              </button>
            );
          })}

          {/* More Suggestions */}
          <button
            onClick={() => fetchSuggestions(true)}
            disabled={loadingMore}
            className="w-full text-left bg-[#ede9de] rounded-xl px-5 py-4 hover:bg-[#e6e1d6] active:scale-[0.99] transition-all disabled:opacity-60"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-slate-900 rounded-xl flex items-center justify-center flex-shrink-0">
                {loadingMore
                  ? <Loader2 className="w-4 h-4 text-white animate-spin" />
                  : <Sparkles className="w-4 h-4 text-white" />
                }
              </div>
              <div>
                <p className="font-semibold text-slate-900 text-sm">{loadingMore ? 'Generating...' : 'More Suggestions'}</p>
                <p className="text-xs text-slate-600 mt-0.5">Generate more ideas for this deck</p>
              </div>
            </div>
          </button>
        </>
      )}
    </div>
  );
}
