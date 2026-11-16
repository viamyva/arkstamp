import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  getDocs, serverTimestamp,
} from 'firebase/firestore';
import {
  X, Pencil, Trash2, Check, ArrowLeft, GripVertical,
  ListChecks, AlignLeft, Users, Calendar, Folder, Plane,
  Loader2,
  DollarSign, Link2, Package, ScrollText,
  LayoutGrid, FileText, Lightbulb, ShoppingCart, Image, UtensilsCrossed,
} from 'lucide-react';

export type Template = 'todo' | 'notes' | 'contacts' | 'timeline' | 'docs' | 'itinerary' | 'budget' | 'links' | 'inventory' | 'eventlog' | 'shopping' | 'photos' | 'mealplanner';

// Built-in tab IDs that can be hidden/restored (not 'shared' — that's always present)
export const HIDEABLE_BUILTINS = ['overview', 'docs', 'suggestions'] as const;
export type HideableBuiltin = typeof HIDEABLE_BUILTINS[number];

export interface TabConfigEntry { label: string; order: number; hidden?: boolean; }
export type TabConfig = Partial<Record<string, TabConfigEntry>>;

export interface CustomTab {
  id: string;
  name: string;
  template: Template;
  order: number;
}

export interface TabEntry {
  id: string;
  label: string;
  order: number;
  isBuiltIn: boolean;
  template?: Template;
  hidden?: boolean;
}

interface ManageTabsProps {
  chapterId: string;
  ownerUid?: string;
  customTabs: CustomTab[];
  tabConfig: TabConfig;
  onClose: () => void;
  onSaved: () => void;
  onTabCreated?: (tabId: string) => void;
}

export const TEMPLATES: {
  id: Template;
  label: string;
  description: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'todo',       label: 'To-do',        description: 'Tasks and action items',          Icon: ListChecks  },
  { id: 'notes',      label: 'Notes',        description: 'Freeform writing and ideas',      Icon: AlignLeft   },
  { id: 'contacts',   label: 'Contacts',     description: 'Names, roles, and info',          Icon: Users       },
  { id: 'timeline',   label: 'Timeline',     description: 'Dates and milestones',            Icon: Calendar    },
  { id: 'docs',       label: 'Documents',    description: 'Files and attachments',           Icon: Folder      },
  { id: 'itinerary',  label: 'Itinerary',    description: 'AI-powered travel planner',       Icon: Plane       },
  { id: 'budget',     label: 'Budget',       description: 'Expenses, income, and tracking',  Icon: DollarSign  },
  { id: 'links',      label: 'Links',        description: 'Bookmarks and web resources',     Icon: Link2       },
  { id: 'inventory',  label: 'Inventory',    description: 'Items, assets, and catalogs',     Icon: Package     },
  { id: 'eventlog',   label: 'Event Logger', description: 'Date and time log of events',     Icon: ScrollText  },
  { id: 'shopping',   label: 'Shopping List', description: 'Grocery and shopping checklist',  Icon: ShoppingCart },
  { id: 'photos',      label: 'Photos',        description: 'Photo albums and galleries',       Icon: Image           },
  { id: 'mealplanner', label: 'Meal Planner',  description: 'Weekly breakfast, lunch & dinner',  Icon: UtensilsCrossed },
];

// Built-in tabs that can be re-added from the Add view
const BUILTIN_TEMPLATES: {
  id: HideableBuiltin;
  label: string;
  description: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'overview',    label: 'To Do',       description: 'Checklist cards and AI summary',  Icon: LayoutGrid  },
  { id: 'docs',        label: 'Docs',        description: 'Files and attachments',           Icon: FileText    },
  { id: 'suggestions', label: 'Suggestions', description: 'AI-generated ideas for this deck', Icon: Lightbulb  },
];

function buildAllTabs(customTabs: CustomTab[], _tabConfig: TabConfig): TabEntry[] {
  const customs: TabEntry[] = customTabs.map(t => ({
    id: t.id,
    label: t.name,
    order: t.order,
    isBuiltIn: false,
    template: t.template,
    hidden: false,
  }));
  return customs.sort((a, b) => a.order - b.order);
}

export function ManageTabs({
  chapterId, ownerUid, customTabs, tabConfig, onClose, onSaved, onTabCreated,
}: ManageTabsProps) {
  const { user } = useAuth();

  // ---- VIEW STATE ----
  const [view, setView] = useState<'list' | 'add'>('list');

  // ---- TAB LIST ----
  const [displayTabs, setDisplayTabs] = useState<TabEntry[]>(() =>
    buildAllTabs(customTabs, tabConfig)
  );
  const displayTabsRef = useRef<TabEntry[]>(displayTabs);
  const draggingRef = useRef(false);

  useEffect(() => { displayTabsRef.current = displayTabs; }, [displayTabs]);

  useEffect(() => {
    if (!draggingRef.current) {
      setDisplayTabs(buildAllTabs(customTabs, tabConfig));
    }
  }, [customTabs, tabConfig]);

  // ---- DRAG ----
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const startDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    e.preventDefault();
    draggingRef.current = true;
    setDraggingId(id);
    setRenamingId(null);
    setPendingDeleteId(null);

    const handleMove = (ev: PointerEvent) => {
      if (!listRef.current) return;
      const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-row-id]'));
      let newIndex = rows.length - 1;
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) { newIndex = i; break; }
      }
      setDisplayTabs(prev => {
        const oldIndex = prev.findIndex(t => t.id === id);
        if (oldIndex === newIndex) return prev;
        const next = [...prev];
        const [item] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, item);
        return next;
      });
    };

    const handleEnd = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleEnd);
      document.removeEventListener('pointercancel', handleEnd);
      draggingRef.current = false;
      setDraggingId(null);
      saveOrder(displayTabsRef.current);
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleEnd);
    document.addEventListener('pointercancel', handleEnd);
  }, []);

  // ---- SAVE ORDER ----
  const saveOrder = async (tabs: TabEntry[]) => {
    if (!user) return;
    const newTabConfig: Record<string, TabConfigEntry> = {};
    const promises: Promise<void>[] = [];

    tabs.forEach((tab, i) => {
      if (tab.isBuiltIn) {
        newTabConfig[tab.id] = {
          label: tab.label,
          order: i,
          ...(tab.hidden ? { hidden: true } : {}),
        };
      } else {
        promises.push(
          updateDoc(
            fsDoc(db, `users/${ownerUid ?? user.uid}/chapters/${chapterId}/customTabs`, tab.id),
            { order: i }
          )
        );
      }
    });

    promises.push(
      updateDoc(fsDoc(db, 'users', ownerUid ?? user.uid, 'chapters', chapterId), { tabConfig: newTabConfig })
    );

    await Promise.all(promises).catch(console.error);
    onSaved();
  };

  // ---- RENAME ----
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const startRename = (id: string) => {
    setRenamingId(id);
    setPendingDeleteId(null);
    setTimeout(() => { renameRef.current?.focus(); renameRef.current?.select(); }, 50);
  };

  const saveRename = async (tab: TabEntry) => {
    const value = renameRef.current?.value?.trim();
    if (!value || !user) { setRenamingId(null); return; }

    if (tab.isBuiltIn) {
      const newTabConfig: Record<string, TabConfigEntry> = {};
      displayTabs.forEach((t, i) => {
        if (t.isBuiltIn) {
          newTabConfig[t.id] = {
            label: t.id === tab.id ? value : t.label,
            order: i,
            ...(t.hidden ? { hidden: true } : {}),
          };
        }
      });
      await updateDoc(
        fsDoc(db, 'users', ownerUid ?? user.uid, 'chapters', chapterId),
        { tabConfig: newTabConfig }
      ).catch(console.error);
    } else {
      await updateDoc(
        fsDoc(db, `users/${ownerUid ?? user.uid}/chapters/${chapterId}/customTabs`, tab.id),
        { name: value }
      ).catch(console.error);
    }

    setDisplayTabs(prev => prev.map(t => t.id === tab.id ? { ...t, label: value } : t));
    setRenamingId(null);
    onSaved();
  };

  // ---- DELETE / HIDE with UNDO ----
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingDeleteTab, setPendingDeleteTab] = useState<TabEntry | null>(null);
  const deleteUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDeleteRequest = async (tab: TabEntry) => {
    setRenamingId(null);
    
    // Immediately remove from display
    setDisplayTabs(prev => prev.filter(t => t.id !== tab.id));
    setPendingDeleteId(tab.id);
    setPendingDeleteTab(tab);

    // Clear any existing undo timer
    if (deleteUndoTimerRef.current) clearTimeout(deleteUndoTimerRef.current);

    // Set 5-second undo window
    const timer = setTimeout(async () => {
      if (!user) return;
      try {
        if (tab.isBuiltIn) {
          const newTabConfig: Record<string, TabConfigEntry> = {};
          // Rebuild config with hidden flag
          const allTabs = buildAllTabs(customTabs, tabConfig);
          allTabs.forEach((t, i) => {
            if (t.isBuiltIn) {
              newTabConfig[t.id] = {
                label: t.label,
                order: i,
                hidden: t.id === tab.id ? true : (t.hidden ?? false),
              };
            }
          });
          await updateDoc(
            fsDoc(db, 'users', ownerUid ?? user.uid, 'chapters', chapterId),
            { tabConfig: newTabConfig }
          ).catch(console.error);
        } else {
          await deleteDoc(fsDoc(db, `users/${ownerUid ?? user.uid}/chapters/${chapterId}/customTabs`, tab.id));
        }
      } catch (err) {
        console.error('Delete failed:', err);
      }
      setPendingDeleteId(null);
      setPendingDeleteTab(null);
      deleteUndoTimerRef.current = null;
      onSaved();
    }, 5000);
    deleteUndoTimerRef.current = timer;
  };

  const handleUndoDelete = () => {
    if (deleteUndoTimerRef.current) clearTimeout(deleteUndoTimerRef.current);
    if (pendingDeleteTab) {
      // Restore the tab to displayTabs in the correct order
      setDisplayTabs(prev => {
        const restored = [...prev, pendingDeleteTab].sort((a, b) => a.order - b.order);
        return restored;
      });
    }
    setPendingDeleteId(null);
    setPendingDeleteTab(null);
    deleteUndoTimerRef.current = null;
  };

  // ---- CREATE / RESTORE ----
  type AddTarget = Template | HideableBuiltin;
  const [selectedTemplate, setSelectedTemplate] = useState<AddTarget | null>(null);
  const [tabName, setTabName] = useState('');
  const [saving, setSaving] = useState(false);

  // Which built-ins are currently hidden (available to re-add)
  const hiddenBuiltins = BUILTIN_TEMPLATES.filter(bt =>
    displayTabs.find(t => t.id === bt.id)?.hidden === true ||
    !displayTabs.find(t => t.id === bt.id)
  );

  const handleSelectTemplate = (id: AddTarget) => {
    setSelectedTemplate(id);
    const bt = BUILTIN_TEMPLATES.find(t => t.id === id);
    if (bt) { setTabName(bt.label); return; }
    const t = TEMPLATES.find(t => t.id === id);
    setTabName(t?.label ?? '');
  };

  const createTab = async () => {
    if (!user || !selectedTemplate || !tabName.trim()) return;
    setSaving(true);
    try {
      // Restoring a hidden built-in
      const isBuiltinRestore = HIDEABLE_BUILTINS.includes(selectedTemplate as HideableBuiltin);
      if (isBuiltinRestore) {
        const builtinId = selectedTemplate as HideableBuiltin;
        const newTabConfig: Record<string, TabConfigEntry> = {};
        // Rebuild tabConfig, clearing hidden flag for the restored tab
        const allForConfig = buildAllTabs(customTabs, tabConfig);
        allForConfig.forEach((t, i) => {
          if (t.isBuiltIn) {
            newTabConfig[t.id] = {
              label: t.id === builtinId ? tabName.trim() : t.label,
              order: t.id === builtinId ? displayTabs.filter(x => !x.hidden).length : i,
              hidden: t.id === builtinId ? false : (t.hidden ?? false),
            };
          }
        });
        await updateDoc(
          fsDoc(db, 'users', ownerUid ?? user.uid, 'chapters', chapterId),
          { tabConfig: newTabConfig }
        );
        if (onTabCreated) {
          onSaved();
          onClose();
          onTabCreated(builtinId);
        } else {
          setView('list');
          setSelectedTemplate(null);
          setTabName('');
          onSaved();
        }
        return;
      }

      // Creating a new custom tab
      const newRef = await addDoc(
        collection(db, `users/${ownerUid ?? user.uid}/chapters/${chapterId}/customTabs`),
        {
          name: tabName.trim(),
          template: selectedTemplate,
          order: displayTabs.length,
          createdAt: serverTimestamp(),
        }
      );
      if (onTabCreated) {
        onSaved();
        onClose();
        onTabCreated(newRef.id);
      } else {
        setView('list');
        setSelectedTemplate(null);
        setTabName('');
        onSaved();
      }
    } finally {
      setSaving(false);
    }
  };

  const resetAdd = () => {
    setView('list');
    setSelectedTemplate(null);
    setTabName('');
  };

  // Visible tabs in the list (non-hidden only)
  const visibleTabs = displayTabs.filter(t => !t.hidden);

  // ---- RENDER ----
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-t-3xl md:rounded-3xl shadow-2xl max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          {view === 'add' ? (
            <button
              onClick={resetAdd}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          ) : (
            <div className="w-16" />
          )}
          <h2 className="text-sm font-semibold text-slate-900 tracking-wide">
            {view === 'list' ? 'Customize Tabs' : 'Add a Tab'}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* LIST VIEW */}
          {view === 'list' && (
            <div className="px-6 py-5">
              <p className="text-xs text-slate-400 mb-4">Drag to reorder. Tap the pencil to rename. Tap the trash to delete.</p>
              <div ref={listRef} className="space-y-2">
                {visibleTabs.map(tab => {
                  const tmpl = TEMPLATES.find(t => t.id === tab.template);
                  const isDragging = draggingId === tab.id;
                  const isDeletableBuiltin = HIDEABLE_BUILTINS.includes(tab.id as HideableBuiltin);
                  const canDelete = !tab.isBuiltIn || isDeletableBuiltin;

                  return (
                    <div
                      key={tab.id}
                      data-row-id={tab.id}
                      className={`rounded-2xl transition-all duration-150 select-none ${
                        isDragging
                          ? 'bg-white shadow-xl ring-1 ring-slate-200 scale-[1.02] opacity-75 z-10 relative'
                          : 'bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-2 px-3 py-3.5">
                        <button
                          className="p-1.5 touch-none cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 transition-colors flex-shrink-0"
                          onPointerDown={e => startDrag(e, tab.id)}
                        >
                          <GripVertical className="w-4 h-4" />
                        </button>
                        <div className="flex-1 min-w-0">
                          {renamingId === tab.id ? (
                            <input
                              ref={renameRef}
                              defaultValue={tab.label}
                              onBlur={() => saveRename(tab)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveRename(tab);
                                if (e.key === 'Escape') setRenamingId(null);
                              }}
                              className="w-full text-sm font-medium text-slate-900 bg-transparent border-0 border-b border-slate-400 focus:outline-none focus:border-slate-900"
                              style={{ userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
                            />
                          ) : (
                            <p className="text-sm font-medium text-slate-900 truncate">{tab.label}</p>
                          )}
                          <p className="text-xs text-slate-400 mt-0.5">
                            {tab.isBuiltIn ? 'Default' : (tmpl?.label ?? '')}
                          </p>
                        </div>
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <button
                            onClick={() => startRename(tab.id)}
                            className="p-1.5 rounded-xl hover:bg-white transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5 text-slate-400" />
                          </button>
                          {canDelete && (
                            <button
                              onClick={() => handleDeleteRequest(tab)}
                              className="p-1.5 rounded-xl hover:bg-red-50 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-red-400" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ADD VIEW */}
          {view === 'add' && (
            <div className="px-6 py-5 space-y-5">

              {/* Custom templates */}
              <div className="grid grid-cols-3 gap-2">
                {TEMPLATES.map(({ id, label, description, Icon }) => {
                  const isSelected = selectedTemplate === id;
                  return (
                    <button
                      key={id}
                      onClick={() => handleSelectTemplate(id)}
                      className={`relative flex flex-col items-center gap-1.5 p-3 rounded-2xl border-2 text-center transition-all ${
                        isSelected
                          ? 'border-slate-900 bg-slate-50'
                          : 'border-slate-100 bg-white hover:border-slate-200'
                      }`}
                    >
                      {isSelected && (
                        <div className="absolute top-2 right-2 w-4 h-4 bg-slate-900 rounded-full flex items-center justify-center">
                          <Check className="w-2.5 h-2.5 text-white" />
                        </div>
                      )}
                      <Icon className={`w-5 h-5 mt-1 ${isSelected ? 'text-slate-900' : 'text-slate-400'}`} />
                      <p className={`text-xs font-semibold leading-tight ${isSelected ? 'text-slate-900' : 'text-slate-700'}`}>{label}</p>
                    </button>
                  );
                })}
              </div>

              {selectedTemplate && (
                <div className="space-y-2 pt-1">
                  <label className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Tab Name
                  </label>
                  <input
                    value={tabName}
                    onChange={e => setTabName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') createTab(); }}
                    placeholder="Name your tab..."
                    autoFocus
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-900 transition-colors bg-white"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-8 pt-3 border-t border-slate-100 flex gap-3">
          {view === 'list' ? (
            <button
              onClick={() => setView('add')}
              className="flex-1 py-3 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 transition-colors"
            >
              + Add a Tab
            </button>
          ) : (
            <button
              onClick={createTab}
              disabled={!selectedTemplate || !tabName.trim() || saving}
              className="flex-1 py-3 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : HIDEABLE_BUILTINS.includes(selectedTemplate as HideableBuiltin) ? 'Restore Tab' : 'Create Tab'}
            </button>
          )}
          <button
            onClick={onClose}
            className="py-3 px-5 border border-slate-200 text-slate-600 text-sm font-medium rounded-xl hover:bg-slate-50 transition-colors"
          >
            Done
          </button>
        </div>

        {/* Undo toast for delete */}
        {pendingDeleteId && pendingDeleteTab && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-slate-900 text-white px-4 py-3 rounded-xl shadow-lg pointer-events-auto">
            <span className="text-sm"><span className="font-semibold">"{pendingDeleteTab.label}"</span> deleted</span>
            <button
              onClick={handleUndoDelete}
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
