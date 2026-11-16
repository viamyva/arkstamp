import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../../lib/firebase';
import {
  doc, getDoc, collection, getDocs, query, orderBy,
  updateDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';
import {
  ArrowLeft,
  ListChecks, AlignLeft, Users, Calendar, Folder, Settings, X, Plane,
  DollarSign, Link2, Package, ScrollText, Ghost, ShoppingCart, Image, UtensilsCrossed,
  Search,
} from 'lucide-react';

import { ALL_EMOJIS } from '../emojiData';

// Group the full Unicode emoji set (~1,900 emojis) into the 9 official
// categories, preserving the dataset's natural ordering within each group.
const DECK_EMOJI_GROUPS: { label: string; emojis: string[] }[] = (() => {
  const order: string[] = [];
  const byGroup = new Map<string, string[]>();
  for (const e of ALL_EMOJIS) {
    if (!byGroup.has(e.group)) { byGroup.set(e.group, []); order.push(e.group); }
    byGroup.get(e.group)!.push(e.emoji);
  }
  return order.map(label => ({ label, emojis: byGroup.get(label)! }));
})();

import { UserAvatar } from './UserAvatar';
import { ManageTabs, CustomTab, TabConfig } from './tabs/ManageTabs';
import { CustomTabContent } from './tabs/CustomTabContent';
import { OverviewTab } from './tabs/OverviewTab';
import { SharedAccessTab } from './tabs/SharedAccessTab';
import { GhostPanel } from './GhostPanel';
import { DraggableTabBar } from './DraggableTabBar';
import { CommandBar, CommandBarTemplate } from './CommandBar';
import { AddTabSheet } from './AddTabSheet';

interface ChapterDetailProps {
  chapterId: string;
  ownerUid?: string;  // set when viewing a shared deck owned by someone else
  onBack: () => void;
  autoFocusNote?: boolean; // true when deck was just created — focuses the first note textarea
}

interface ChapterData {
  chapter: any;
  cards: any[];
  documents: any[];
  customTabs: CustomTab[];
}

// Icons for custom tab templates
const TEMPLATE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  todo:       ListChecks,
  notes:      AlignLeft,
  contacts:   Users,
  timeline:   Calendar,
  docs:       Folder,
  itinerary:  Plane,
  budget:     DollarSign,
  links:      Link2,
  inventory:  Package,
  eventlog:   ScrollText,
  shopping:    ShoppingCart,
  photos:      Image,
  mealplanner: UtensilsCrossed,
};

export function ChapterDetail({ chapterId, ownerUid: propOwnerUid, onBack, autoFocusNote = false }: ChapterDetailProps) {
  const [activeTab, setActiveTab] = useState<string>('');
  const [data, setData] = useState<ChapterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tabRefreshKey, setTabRefreshKey] = useState(0);

  const refreshCards = async () => {
    const uid = propOwnerUid ?? user?.uid;
    if (!uid) return;
    const base = `users/${uid}/chapters/${chapterId}`;
    try {
      const snap = await getDocs(collection(db, base, 'cards'));
      const freshCards = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      setData(prev => prev ? { ...prev, cards: freshCards } : prev);
    } catch { /* ignore */ }
  };

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleEditValue, setTitleEditValue] = useState('');
  const [showManageTabs, setShowManageTabs] = useState(false);
  const [showAddTabSheet, setShowAddTabSheet] = useState(false);
  const [showSharedAccess, setShowSharedAccess] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiSearch, setEmojiSearch] = useState('');
  const { user, ghostEmail, isGhostMode, exitGhost } = useAuth();

  // Quick-delete undo toast (tab bar tap menu)
  const [pendingDeleteTabId, setPendingDeleteTabId] = useState<string | null>(null);
  const [pendingDeleteTabLabel, setPendingDeleteTabLabel] = useState<string>('');
  const deleteTabUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (deleteTabUndoTimerRef.current) clearTimeout(deleteTabUndoTimerRef.current);
    };
  }, []);

  // Persist a new tab order after a drag-drop reorder
  const saveTabOrder = useCallback(async (orderedIds: string[]) => {
    if (!user || !data) return;
    const cfg: TabConfig = data.chapter.tabConfig ?? {};
    const newTabConfig: Record<string, any> = {};
    const customUpdates: Promise<void>[] = [];
    const BUILTIN_IDS = ['shared', 'overview'];
    const deckOwnerUid = propOwnerUid ?? user.uid;

    // First, carry over ALL existing built-in config entries (preserving hidden flags
    // for tabs that are hidden and therefore absent from orderedIds)
    BUILTIN_IDS.forEach(id => {
      if (cfg[id]) {
        newTabConfig[id] = { ...cfg[id] };
      }
    });

    // Then apply the new order for tabs that ARE in orderedIds
    orderedIds.forEach((id, i) => {
      const isBuiltIn = BUILTIN_IDS.includes(id);
      if (isBuiltIn) {
        newTabConfig[id] = {
          label: cfg[id]?.label ?? id,
          order: i,
          ...(cfg[id]?.hidden ? { hidden: true } : {}),
        };
      } else {
        customUpdates.push(
          updateDoc(
            doc(db, `users/${deckOwnerUid}/chapters/${chapterId}/customTabs`, id),
            { order: i }
          ).catch(console.error)
        );
      }
    });

    await Promise.all([
      updateDoc(doc(db, 'users', deckOwnerUid, 'chapters', chapterId), { tabConfig: newTabConfig }),
      ...customUpdates,
    ]).catch(console.error);

    // Update local data so allTabs re-sorts correctly without a full reload
    setData(prev => {
      if (!prev) return prev;
      const updatedCustomTabs = prev.customTabs.map(t => {
        const idx = orderedIds.indexOf(t.id);
        return idx !== -1 ? { ...t, order: idx } : t;
      });
      return {
        ...prev,
        chapter: { ...prev.chapter, tabConfig: newTabConfig },
        customTabs: updatedCustomTabs,
      };
    });
  }, [user, data, chapterId]);

  // Quick rename from the tab bar's tap menu
  const handleRenameTab = useCallback(async (tabId: string, newName: string) => {
    if (!user) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    const deckOwnerUid = propOwnerUid ?? user.uid;
    try {
      await updateDoc(
        doc(db, `users/${deckOwnerUid}/chapters/${chapterId}/customTabs`, tabId),
        { name: trimmed }
      );
      setData(prev => prev
        ? { ...prev, customTabs: prev.customTabs.map(t => t.id === tabId ? { ...t, name: trimmed } : t) }
        : prev
      );
    } catch (err) {
      console.error('Error renaming tab:', err);
    }
  }, [user, chapterId, propOwnerUid]);

  useEffect(() => {
    if (user) loadChapterData();
  }, [chapterId, user]);

  const loadChapterData = async () => {
    if (!user) return;
    try {
      // For shared decks, read from the original owner's path; for own decks use user.uid
      const uid = propOwnerUid ?? user.uid;
      const base = `users/${uid}/chapters/${chapterId}`;

      const [chapterSnap, customTabsSnap, cardsSnap] = await Promise.all([
        getDoc(doc(db, 'users', uid, 'chapters', chapterId)),
        getDocs(query(collection(db, base, 'customTabs'), orderBy('order', 'asc'))).catch(() =>
          getDocs(collection(db, base, 'customTabs'))
        ),
        getDocs(collection(db, base, 'cards')).catch(() => ({ docs: [] })),
      ]);

      if (!chapterSnap.exists()) { setData(null); return; }

      const newCustomTabs: CustomTab[] = customTabsSnap.docs.map(d => ({
        id: d.id,
        ...(d.data() as Omit<CustomTab, 'id'>),
      }));

      const validIds = ['shared', 'overview', ...newCustomTabs.map(t => t.id)];

      // Compute the first visible tab in sorted order to use as default
      const chapterData = chapterSnap.data() as any;
      const loadedCfg = chapterData?.tabConfig ?? {};
      const overviewEntry = loadedCfg['overview'];
      const builtinDefaults = overviewEntry && !overviewEntry.hidden
        ? [{ id: 'overview', order: overviewEntry.order ?? -1, hidden: false }]
        : [];
      const sortedForDefault = [
        ...builtinDefaults,
        ...newCustomTabs.map(t => ({ id: t.id, order: t.order ?? 99, hidden: false })),
      ].filter(t => !t.hidden).sort((a, b) => a.order - b.order);
      const firstTabId = sortedForDefault[0]?.id ?? '';

      setActiveTab(prev => validIds.includes(prev) ? prev : firstTabId);

      setData({
        chapter: { id: chapterSnap.id, ...chapterSnap.data() },
        cards: cardsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() })),
        documents: [],
        customTabs: newCustomTabs,
      });
    } catch (error) {
      console.error('Error loading deck:', error);
    } finally {
      setLoading(false);
    }
  };

  const startTitleEdit = () => {
    if (!data) return;
    setTitleEditValue(data.chapter.title);
    setIsEditingTitle(true);
  };

  const handleEmojiSelect = async (emoji: string) => {
    if (!user) return;
    setShowEmojiPicker(false);
    setEmojiSearch('');
    try {
      await updateDoc(doc(db, 'users', propOwnerUid ?? user.uid, 'chapters', chapterId), { icon: emoji });
      setData(prev => prev ? { ...prev, chapter: { ...prev.chapter, icon: emoji } } : prev);
    } catch (err) { console.error(err); }
  };

  const saveTitleEdit = async () => {
    if (!user || !titleEditValue.trim()) { setIsEditingTitle(false); return; }
    try {
      await updateDoc(doc(db, 'users', propOwnerUid ?? user.uid, 'chapters', chapterId), {
        title: titleEditValue.trim(),
        updatedAt: serverTimestamp(),
      });
      setData(prev =>
        prev ? { ...prev, chapter: { ...prev.chapter, title: titleEditValue.trim() } } : prev
      );
    } catch (err) {
      console.error('Error renaming deck:', err);
    }
    setIsEditingTitle(false);
  };

  // Build sorted tab list: custom tabs only (shared is handled as a button, not a tab)
  const allTabs = useMemo(() => {
    if (!data) return [];
    const cfg: TabConfig = data.chapter.tabConfig ?? {};
    const overviewCfg = cfg['overview'];
    const builtInTabs = overviewCfg && !overviewCfg.hidden && pendingDeleteTabId !== 'overview'
      ? [{ id: 'overview', label: overviewCfg.label ?? 'Overview', order: overviewCfg.order ?? -1, isBuiltIn: true, template: 'overview', hidden: false }]
      : [];
    const customTabs = data.customTabs
      .filter(t => t.id !== pendingDeleteTabId)
      .map(t => ({
        id: t.id,
        label: t.name,
        order: t.order,
        isBuiltIn: false,
        template: t.template,
        hidden: false,
      }));
    return [...builtInTabs, ...customTabs].sort((a, b) => a.order - b.order);
  }, [data, pendingDeleteTabId]);

  // Quick delete from the tab bar's tap menu — optimistic hide + 5s undo window
  const handleDeleteTab = useCallback((tabId: string) => {
    const isBuiltIn = tabId === 'overview';
    const tab = isBuiltIn
      ? allTabs.find(t => t.id === tabId)
      : data?.customTabs.find(t => t.id === tabId);
    if (!tab) return;

    const tabLabel = isBuiltIn ? (tab as { label: string }).label : (tab as CustomTab).name;

    if (deleteTabUndoTimerRef.current) clearTimeout(deleteTabUndoTimerRef.current);

    setPendingDeleteTabId(tabId);
    setPendingDeleteTabLabel(tabLabel);

    // Move off the tab being deleted right away
    setActiveTab(prev => {
      if (prev !== tabId) return prev;
      const remaining = allTabs.filter(t => t.id !== tabId);
      return remaining[0]?.id ?? '';
    });

    deleteTabUndoTimerRef.current = setTimeout(async () => {
      if (!user || !data) return;
      const deckOwnerUid = propOwnerUid ?? user.uid;
      try {
        if (isBuiltIn) {
          const cfg: TabConfig = data.chapter.tabConfig ?? {};
          const newTabConfig: Record<string, any> = {
            ...cfg,
            [tabId]: { ...(cfg[tabId] ?? {}), label: cfg[tabId]?.label ?? tabId, order: cfg[tabId]?.order ?? -1, hidden: true },
          };
          await updateDoc(doc(db, 'users', deckOwnerUid, 'chapters', chapterId), { tabConfig: newTabConfig });
          setData(prev => prev ? { ...prev, chapter: { ...prev.chapter, tabConfig: newTabConfig } } : prev);
        } else {
          await deleteDoc(doc(db, `users/${deckOwnerUid}/chapters/${chapterId}/customTabs`, tabId));
          setData(prev => prev
            ? { ...prev, customTabs: prev.customTabs.filter(t => t.id !== tabId) }
            : prev
          );
        }
      } catch (err) {
        console.error('Error deleting tab:', err);
      }
      setPendingDeleteTabId(null);
      setPendingDeleteTabLabel('');
      deleteTabUndoTimerRef.current = null;
    }, 5000);
  }, [user, data, chapterId, propOwnerUid, allTabs]);

  const handleUndoDeleteTab = useCallback(() => {
    if (deleteTabUndoTimerRef.current) {
      clearTimeout(deleteTabUndoTimerRef.current);
      deleteTabUndoTimerRef.current = null;
    }
    setPendingDeleteTabId(null);
    setPendingDeleteTabLabel('');
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-slate-900" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-600 mb-4">Deck not found</p>
          <button onClick={onBack} className="text-slate-900 underline">Go back</button>
        </div>
      </div>
    );
  }

  const activeCustomTab = data.customTabs.find(t => t.id === activeTab);
  const isGhostDeck = data.chapter.isGhostPanel === true;

  // Build CommandBar props — available tabs list + active tab hint
  const COMMAND_BAR_TEMPLATES: CommandBarTemplate[] = [
    'timeline', 'todo', 'shopping', 'contacts', 'notes',
    'budget', 'links', 'inventory', 'eventlog', 'itinerary',
  ];
  const commandBarAvailableTabs = data.customTabs
    .filter(t => COMMAND_BAR_TEMPLATES.includes(t.template as CommandBarTemplate))
    .map(t => ({ tabId: t.id, tabName: t.name, template: t.template as CommandBarTemplate }));
  // Show the button whenever the deck has at least one commandable tab
  const commandBarVisible = commandBarAvailableTabs.length > 0 && !isGhostDeck;

  // Ghost deck: render the panel UI instead of normal tabs
  if (isGhostDeck) {
    return (
      <div className="min-h-screen bg-[#faf7f2]">
        {isGhostMode && (
          <div className="fixed top-0 left-0 right-0 z-[200] bg-amber-500 shadow-lg">
            <div className="max-w-7xl mx-auto px-6 py-2.5 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-white text-sm font-medium min-w-0">
                <Ghost className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">Ghosting <span className="font-bold">{ghostEmail}</span></span>
              </div>
              <button onClick={exitGhost} className="text-xs font-semibold text-amber-900 bg-white/90 hover:bg-white px-3 py-1.5 rounded-lg transition-colors flex-shrink-0">
                Exit Ghost
              </button>
            </div>
          </div>
        )}
        <div className={isGhostMode ? 'pt-10' : ''}>
          <header className="bg-[#faf7f2] border-b border-stone-200">
            <div className="max-w-7xl mx-auto px-6 py-4">
              <button onClick={onBack} className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors">
                <ArrowLeft className="w-4 h-4" />
                <span className="text-sm">Back to The Ark</span>
              </button>
            </div>
          </header>
          <main className="max-w-7xl mx-auto px-6 py-8">
            <GhostPanel deckTitle={data.chapter.title} onBack={onBack} />
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf7f2]">
      {/* Ghost mode banner when ghosting but viewing a normal deck */}
      {isGhostMode && (
        <div className="fixed top-0 left-0 right-0 z-[200] bg-amber-500 shadow-lg">
          <div className="max-w-7xl mx-auto px-6 py-2.5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-white text-sm font-medium min-w-0">
              <Ghost className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">Ghosting <span className="font-bold">{ghostEmail}</span></span>
            </div>
            <button onClick={exitGhost} className="text-xs font-semibold text-amber-900 bg-white/90 hover:bg-white px-3 py-1.5 rounded-lg transition-colors flex-shrink-0">
              Exit Ghost
            </button>
          </div>
        </div>
      )}
      <div className={isGhostMode ? 'pt-10' : ''}>
      <header className="bg-[#faf7f2] border-b border-stone-200">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={onBack}
              className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="text-sm">Back to The Ark</span>
            </button>
            <UserAvatar />
          </div>
          <div>
            <div className="flex items-start gap-3 mb-1">
              {/* Tappable emoji */}
              <button
                onClick={() => setShowEmojiPicker(true)}
                className="text-3xl leading-none mt-1 flex-shrink-0 hover:scale-110 transition-transform active:scale-95"
                title="Change icon"
              >
                {data.chapter.icon}
              </button>

              {/* Title */}
              {isEditingTitle ? (
                <input
                  value={titleEditValue}
                  onChange={e => setTitleEditValue(e.target.value)}
                  onBlur={saveTitleEdit}
                  onKeyDown={e => {
                    if (e.key === 'Enter') saveTitleEdit();
                    if (e.key === 'Escape') setIsEditingTitle(false);
                  }}
                  autoFocus
                  className="text-3xl font-bold text-slate-900 bg-transparent border-0 border-b-2 border-slate-900 focus:outline-none flex-1 mb-1"
                />
              ) : (
                <h1
                  className="text-3xl font-bold text-slate-900 cursor-pointer hover:opacity-70 transition-opacity leading-tight"
                  onClick={startTitleEdit}
                  title="Tap to rename"
                >
                  {data.chapter.title}
                </h1>
              )}
            </div>
            <p className="text-slate-600">{data.chapter.description}</p>
          </div>
        </div>

        {/* Tab bar */}
        <div className="max-w-7xl mx-auto px-6">
          <DraggableTabBar
            tabs={allTabs.map(tab => ({
              id: tab.id,
              label: tab.label,
              isBuiltIn: tab.isBuiltIn,
              template: (tab as any).template,
              Icon: TEMPLATE_ICONS[(tab as any).template ?? ''],
            }))}
            activeTab={activeTab}
            onTabClick={setActiveTab}
            onReorder={saveTabOrder}
            onManage={() => setShowManageTabs(true)}
            showManage={showManageTabs}
            onAddTab={() => setShowAddTabSheet(true)}
            onSharedAccess={() => setShowSharedAccess(true)}
            onRenameTab={handleRenameTab}
            onDeleteTab={handleDeleteTab}
          />
        </div>
      </header>

      <main className={activeCustomTab?.template === 'itinerary' ? 'w-full' : 'max-w-7xl mx-auto px-6 py-8'}>
        {activeTab === 'overview' && (
          <OverviewTab
            chapterId={chapterId}
            ownerUid={propOwnerUid}
            cards={data.cards}
            customTabs={data.customTabs}
            chapterTitle={data.chapter.title}
            onRefresh={refreshCards}
          />
        )}
        {activeCustomTab && activeTab !== 'overview' && (
          <CustomTabContent
            chapterId={chapterId}
            tabId={activeCustomTab.id}
            template={activeCustomTab.template}
            chapterTitle={data.chapter.title}
            tabName={activeCustomTab.name}
            ownerUid={propOwnerUid}
            refreshKey={tabRefreshKey}
            autoFocusNote={autoFocusNote && activeCustomTab.template === 'notes'}
          />
        )}
      </main>

      {showEmojiPicker && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center"
          onClick={() => { setShowEmojiPicker(false); setEmojiSearch(''); }}
        >
          <div
            className="bg-white w-full max-w-sm rounded-t-3xl md:rounded-3xl p-5 shadow-2xl flex flex-col"
            style={{ maxHeight: '80vh' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <h3 className="text-sm font-semibold text-slate-900">Change Icon</h3>
              <button
                onClick={() => { setShowEmojiPicker(false); setEmojiSearch(''); }}
                className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="relative mb-3 flex-shrink-0">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                autoFocus
                value={emojiSearch}
                onChange={e => setEmojiSearch(e.target.value)}
                placeholder="Search emoji..."
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors"
              />
            </div>
            <div className="overflow-y-auto flex-1 space-y-4 pr-1">
              {emojiSearch.trim() ? (
                (() => {
                  const q = emojiSearch.trim().toLowerCase();
                  const results = ALL_EMOJIS.filter(e => e.name.includes(q));
                  return results.length > 0 ? (
                    <div className="grid grid-cols-8 gap-1">
                      {results.map(({ emoji, name }) => (
                        <button
                          key={emoji}
                          title={name}
                          onClick={() => handleEmojiSelect(emoji)}
                          className={`text-xl p-1.5 rounded-xl hover:bg-slate-100 transition-colors leading-none ${
                            data.chapter.icon === emoji ? 'bg-slate-100 ring-2 ring-slate-900' : ''
                          }`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400 text-center py-8">No emoji found for "{emojiSearch.trim()}"</p>
                  );
                })()
              ) : (
                DECK_EMOJI_GROUPS.map(group => (
                  <div key={group.label}>
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5 px-0.5">{group.label}</p>
                    <div className="grid grid-cols-8 gap-1">
                      {group.emojis.map(emoji => (
                        <button
                          key={emoji}
                          onClick={() => handleEmojiSelect(emoji)}
                          className={`text-xl p-1.5 rounded-xl hover:bg-slate-100 transition-colors leading-none ${
                            data.chapter.icon === emoji ? 'bg-slate-100 ring-2 ring-slate-900' : ''
                          }`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showManageTabs && (
        <ManageTabs
          chapterId={chapterId}
          ownerUid={propOwnerUid ?? user?.uid}
          customTabs={data.customTabs}
          tabConfig={data.chapter.tabConfig ?? {}}
          onClose={() => setShowManageTabs(false)}
          onSaved={loadChapterData}
          onTabCreated={(tabId) => {
            setShowManageTabs(false);
            setActiveTab(tabId);
            loadChapterData();
          }}
        />
      )}

      {showAddTabSheet && (
        <AddTabSheet
          chapterId={chapterId}
          ownerUid={propOwnerUid ?? user?.uid}
          existingTabCount={data.customTabs.length}
          onClose={() => setShowAddTabSheet(false)}
          onTabCreated={(tabId) => {
            setShowAddTabSheet(false);
            setActiveTab(tabId);
            loadChapterData();
          }}
        />
      )}

      {showSharedAccess && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-end"
          onClick={() => setShowSharedAccess(false)}
        >
          <div
            className="bg-white w-full rounded-t-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-slate-200 rounded-full" />
            </div>
            <SharedAccessTab
              chapterId={chapterId}
              deckTitle={data.chapter.title}
              allTabs={allTabs.map(t => ({ id: t.id, label: t.label, isBuiltIn: t.isBuiltIn }))}
              ownerUid={propOwnerUid}
            />
          </div>
        </div>
      )}

      {/* Global AI command bar — floats bottom-right when the deck has commandable tabs */}
      <CommandBar
        availableTabs={commandBarAvailableTabs}
        activeTabId={activeCustomTab?.id ?? null}
        deckTitle={data.chapter.title}
        chapterId={chapterId}
        ownerUid={propOwnerUid}
        onRefresh={() => {
          // Increment the key so the active CustomTabContent re-fetches immediately
          setTabRefreshKey(k => k + 1);
          // Also reload deck-level metadata in the background
          loadChapterData();
        }}
        visible={commandBarVisible}
      />

      {/* Undo toast for quick tab delete — matches ManageTabs' delete-undo toast style */}
      {pendingDeleteTabId && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-slate-900 text-white px-4 py-3 rounded-xl shadow-lg pointer-events-auto">
          <span className="text-sm"><span className="font-semibold">"{pendingDeleteTabLabel}"</span> deleted</span>
          <button
            onClick={handleUndoDeleteTab}
            className="font-semibold text-amber-400 hover:text-amber-300 px-2 py-1 rounded-lg hover:bg-white/10 transition-colors text-sm"
          >
            Undo
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
