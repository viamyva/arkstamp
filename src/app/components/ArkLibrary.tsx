import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useDeckDrag } from '../hooks/useDeckDrag';
import { useDeckGridDrag } from '../hooks/useDeckGridDrag';
import { useAuth } from '../contexts/AuthContext';
import { db, functions } from '../../lib/firebase';
import {
  collection, getDocs, doc, addDoc, getDoc,
  updateDoc, deleteDoc, writeBatch, serverTimestamp,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Plus, Sparkles, LayoutGrid, List, Search, X, Ghost, Pencil, Trash2, ArrowUpToLine, Camera } from 'lucide-react';

// Ark icon: peaked roof + cabin + boat hull
function ArkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 3L4 8h16L12 3z"/>
      <rect x="4" y="8" width="16" height="7.5" rx="0.5"/>
      <path d="M2 15.5C2 15.5 5.5 20.5 12 20.5C18.5 20.5 22 15.5 22 15.5H2Z"/>
    </svg>
  );
}
import { UserAvatar } from './UserAvatar';
import { ChapterCard } from './ChapterCard';
import { CreateChapterModal } from './CreateChapterModal';
import { ChapterDetail } from './ChapterDetail';
import { UploadModal } from './UploadModal';
import { LunchCountPage } from './LunchCountPage';

interface Chapter { id: string; title: string; icon: string; description: string; updatedAt: string | null; isGhostPanel?: boolean; sharedOwnerUid?: string; }

interface PendingShare { ownerUid: string; chapterId: string; }

const HINT_KEY = 'ark-swipe-hint-count';

interface ArkLibraryProps {
  pendingShare?: PendingShare | null;
}

export function ArkLibrary({ pendingShare }: ArkLibraryProps = {}) {
  const { user, ghostEmail, isGhostMode, exitGhost } = useAuth();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const shareAcceptedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [selectedOwnerUid, setSelectedOwnerUid] = useState<string | null>(null);
  const [freshDeck, setFreshDeck] = useState(false);
  const hiddenFocusRef = useRef<HTMLTextAreaElement>(null);
  const [pendingDeletes, setPendingDeletes] = useState<Map<string, { title: string; timer: ReturnType<typeof setTimeout> }>>(new Map());
  const [renamingChapterId, setRenamingChapterId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [menuChapterId, setMenuChapterId] = useState<string | null>(null);
  const [showLunchCount, setShowLunchCount] = useState(false);

  // ---- VIEW / SEARCH STATE ----
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(() =>
    (localStorage.getItem('ark-view-mode') as 'list' | 'grid') || 'list'
  );
  const beforeRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState<Map<string, string>>(new Map());
  const searchIndexBuilt = useRef(false);

  const [displayChapters, setDisplayChapters] = useState<Chapter[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // ---- DRAG REORDER (via hooks) ----
  const { draggingId, dragDelta, startDrag, getCardShift, justDraggedRef } = useDeckDrag({
    items: displayChapters,
    listRef,
    onReorder: (reordered) => {
      setDisplayChapters(reordered);
      saveOrder(reordered);
    },
    onLongPressWithoutMove: (id) => setMenuChapterId(id),
  });

  const {
    draggingId: gridDraggingId,
    dragDeltaX: gridDragDeltaX,
    dragDeltaY: gridDragDeltaY,
    startDrag: startGridDrag,
    getCardShift: getGridCardShift,
    justDraggedRef: gridJustDraggedRef,
  } = useDeckGridDrag({
    items: displayChapters,
    gridRef,
    onReorder: (reordered) => {
      setDisplayChapters(reordered);
      saveOrder(reordered);
    },
    onLongPressWithoutMove: (id) => setMenuChapterId(id),
  });

  // ---- HINT ----
  const [hintChapterId, setHintChapterId] = useState<string | null>(null);
  const hintChecked = useRef(false);

  const loadChaptersRef = useRef<() => void>(() => {});

  // ---- LOAD ----
  const loadChapters = async () => {
    if (!user) return;
    try {
      // Own decks
      const snapshot = await getDocs(collection(db, 'users', user.uid, 'chapters'));
      type Raw = Chapter & { _order?: number; _createdMs: number };
      const raw: Raw[] = snapshot.docs.map(d => {
        const data = d.data();
        const ts = data.updatedAt ?? data.createdAt;
        return {
          id: d.id,
          title: data.title || 'Untitled',
          icon: data.icon || '📌',
          description: data.description || '',
          isGhostPanel: data.isGhostPanel ?? false,
          updatedAt: ts?.toDate?.()?.toISOString() ?? null,
          _order: data.order,
          _createdMs: data.createdAt?.toMillis?.() ?? 0,
        };
      });
      raw.sort((a, b) => {
        const aH = a._order !== undefined, bH = b._order !== undefined;
        if (aH && bH) return a._order! - b._order!;
        if (aH) return -1; if (bH) return 1;
        return b._createdMs - a._createdMs;
      });
      const ownDecks = raw.map(({ _order, _createdMs, ...rest }) => rest);

      // Shared decks — pointer docs live at users/{uid}/sharedDecks/{ownerUid}_{chapterId}
      // The Firestore rule allows reading users/{ownerUid}/chapters/{chapterId} when
      // that pointer doc exists, so the getDoc below will succeed.
      let sharedDecks: Chapter[] = [];
      try {
        const sharedSnap = await getDocs(collection(db, 'users', user.uid, 'sharedDecks'));
        const sharedRaw = await Promise.all(
          sharedSnap.docs.map(async sd => {
            const { ownerUid, chapterId } = sd.data() as { ownerUid: string; chapterId: string };
            if (!ownerUid || !chapterId) return null;
            try {
              const chSnap = await getDoc(doc(db, 'users', ownerUid, 'chapters', chapterId));
              if (!chSnap.exists()) return null;
              const d = chSnap.data();
              const ts = d.updatedAt ?? d.createdAt;
              return {
                id: chapterId,
                title: d.title || 'Untitled',
                icon: d.icon || '📌',
                description: d.description || '',
                isGhostPanel: false,
                updatedAt: ts?.toDate?.()?.toISOString() ?? null,
                sharedOwnerUid: ownerUid,
              } as Chapter;
            } catch (e) {
              console.warn('[ArkLibrary] could not load shared deck:', ownerUid, chapterId, e);
              return null;
            }
          })
        );
        sharedDecks = sharedRaw.filter(Boolean) as Chapter[];
      } catch (e) {
        console.warn('[ArkLibrary] could not load sharedDecks collection:', e);
      }

      // Deduplicate shared decks. A user might have multiple pointer docs for the same shared deck.
      const uniqueSharedDecks = Array.from(new Map(sharedDecks.map(d => [d.id, d])).values());
      setChapters([...ownDecks, ...uniqueSharedDecks]);
    } catch (err) {
      console.error('Error loading decks:', err);
    } finally {
      setLoading(false);
    }
  };

  // ---- ACCEPT PENDING SHARE ----
  // Delegates to the acceptSharedDeck Cloud Function which runs with admin
  // privileges and can safely read/write across user boundaries.
  useEffect(() => {
    if (!user || !pendingShare || shareAcceptedRef.current) return;
    shareAcceptedRef.current = true;
    const { ownerUid, chapterId } = pendingShare;
    if (ownerUid === user.uid) return; // don't share with yourself
    const accept = async () => {
      try {
        const acceptFn = httpsCallable(functions, 'acceptSharedDeck');
        await acceptFn({ ownerUid, chapterId });
        // Clean the URL so refreshing doesn't re-run the accept flow
        window.history.replaceState(null, '', window.location.pathname);
        loadChapters();
      } catch (err) {
        console.error('[ArkLibrary] share accept error:', err);
      }
    };
    accept();
  }, [user, pendingShare]);

  useEffect(() => { loadChaptersRef.current = loadChapters; });
  useEffect(() => { if (user) loadChapters(); }, [user]);

  // Auto-create ghost deck for admin, and clean up any duplicates.
  // A ref guard prevents concurrent writes when the effect fires multiple times.
  const ghostCreatingRef = useRef(false);
  useEffect(() => {
    if (user?.email !== 'edcrewguy@gmail.com' || loading || isGhostMode) return;

    const ghostDecks = chapters.filter(c => c.isGhostPanel);

    // Delete all duplicate ghost decks, keeping only the one with the lowest
    // Firestore doc id (a stable proxy for oldest, since ids are time-prefixed).
    if (ghostDecks.length > 1) {
      const sorted = [...ghostDecks].sort((a, b) => a.id.localeCompare(b.id));
      const [, ...duplicates] = sorted; // keep first, delete the rest
      const batch = writeBatch(db);
      duplicates.forEach(d => batch.delete(doc(db, 'users', user.uid, 'chapters', d.id)));
      batch.commit().then(() => loadChapters());
      return;
    }

    // Create the ghost deck exactly once
    if (ghostDecks.length === 0 && !ghostCreatingRef.current) {
      ghostCreatingRef.current = true;
      addDoc(collection(db, 'users', user.uid, 'chapters'), {
        title: 'Ghost', icon: '👻', description: 'Admin ghost panel',
        isGhostPanel: true, order: -9999999,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }).then(() => {
        ghostCreatingRef.current = false;
        loadChapters();
      }).catch(() => { ghostCreatingRef.current = false; });
    }
  }, [chapters, loading, user, isGhostMode]);

  // Sync displayChapters when chapters or pendingDeletes change (not when drag state changes)
  useEffect(() => {
    if (!draggingId) {
      setDisplayChapters(chapters.filter(c => !pendingDeletes.has(c.id)));
    }
  }, [chapters, pendingDeletes]); // draggingId intentionally excluded: we don't want drop to trigger a reset

  // Swipe hint: fire exactly once ever
  useEffect(() => {
    if (chapters.length === 0 || hintChecked.current) return;
    hintChecked.current = true;
    const count = parseInt(localStorage.getItem(HINT_KEY) ?? '0', 10);
    if (count >= 1) return;
    const t = setTimeout(() => {
      setHintChapterId(chapters[0].id);
      localStorage.setItem(HINT_KEY, '1');
    }, 1000);
    return () => clearTimeout(t);
  }, [chapters]);

  // Browser back button
  useEffect(() => {
    const handle = () => { setSelectedChapterId(null); loadChaptersRef.current(); };
    window.addEventListener('popstate', handle);
    return () => window.removeEventListener('popstate', handle);
  }, []);

  const handleSelectChapter = (id: string, ownerUid?: string) => {
    if (justDraggedRef.current || gridJustDraggedRef.current) return;
    window.history.pushState({ arkDeck: id }, '', '#deck');
    setFreshDeck(false);
    setSelectedChapterId(id);
    setSelectedOwnerUid(ownerUid ?? null);
  };

  const handleBackFromDeck = () => {
    setSelectedChapterId(null);
    setFreshDeck(false);
    setSelectedOwnerUid(null);
    loadChapters();
    window.history.replaceState(null, '', window.location.pathname);
  };

  // ---- DELETE ----
  const handleDeleteDeck = (chapterId: string) => {
    if (!user) return;
    const chapter = chapters.find(c => c.id === chapterId);
    if (!chapter) return;
    const existing = pendingDeletes.get(chapterId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(async () => {
      if (!user) return;
      try {
        const uid = user.uid;
        const base = `users/${uid}/chapters/${chapterId}`;
        for (const sub of ['cards', 'timeline', 'contacts', 'docs']) {
          const snap = await getDocs(collection(db, base, sub));
          if (snap.docs.length > 0) {
            const batch = writeBatch(db);
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
          }
        }
        await deleteDoc(doc(db, 'users', uid, 'chapters', chapterId));
      } catch (err) { console.error(err); }
      setPendingDeletes(prev => { const n = new Map(prev); n.delete(chapterId); return n; });
    }, 5000);
    setPendingDeletes(prev => new Map(prev).set(chapterId, { title: chapter.title, timer }));
  };

  const undoDeleteDeck = (chapterId: string) => {
    const p = pendingDeletes.get(chapterId);
    if (!p) return;
    clearTimeout(p.timer);
    setPendingDeletes(prev => { const n = new Map(prev); n.delete(chapterId); return n; });
  };

  // ---- RENAME ----
  const startRename = (chapterId: string) => {
    const c = chapters.find(c => c.id === chapterId);
    if (!c) return;
    setRenameValue(c.title);
    setRenamingChapterId(chapterId);
  };

  const handleRenameDeck = async () => {
    if (!user || !renamingChapterId || !renameValue.trim()) return;
    try {
      await updateDoc(doc(db, 'users', user.uid, 'chapters', renamingChapterId), {
        title: renameValue.trim(), updatedAt: serverTimestamp(),
      });
      setRenamingChapterId(null);
      setRenameValue('');
      loadChapters();
    } catch (err) { console.error(err); }
  };

  // ---- MOVE TO TOP ----
  const moveToTop = (chapterId: string) => {
    const idx = displayChapters.findIndex(c => c.id === chapterId);
    if (idx <= 0) return;
    const next = [...displayChapters];
    const [moved] = next.splice(idx, 1);
    next.unshift(moved);
    setDisplayChapters(next);
    saveOrder(next);
  };

  // ---- DRAG REORDER ----
  const saveOrder = async (ordered: Chapter[]) => {
    if (!user) return;
    try {
      const batch = writeBatch(db);
      ordered.forEach((c, i) => batch.update(doc(db, 'users', user.uid, 'chapters', c.id), { order: i }));
      await batch.commit();
    } catch (err) { console.error(err); }
  };

  // ---- FLIP ANIMATION ----
  const capturePositions = () => {
    const map = new Map<string, DOMRect>();
    document.querySelectorAll('[data-chapter-id]').forEach(el => {
      const id = el.getAttribute('data-chapter-id');
      if (id) map.set(id, el.getBoundingClientRect());
    });
    beforeRectsRef.current = map;
  };

  const toggleView = () => {
    capturePositions();
    setViewMode(prev => {
      const next = prev === 'list' ? 'grid' : 'list';
      localStorage.setItem('ark-view-mode', next);
      return next;
    });
  };

  // FLIP play: after DOM updates, animate each card from its old position to its new one
  useLayoutEffect(() => {
    const before = beforeRectsRef.current;
    if (before.size === 0) return;
    beforeRectsRef.current = new Map();

    const toAnimate: { el: HTMLElement; dx: number; dy: number }[] = [];
    document.querySelectorAll<HTMLElement>('[data-chapter-id]').forEach(el => {
      const id = el.getAttribute('data-chapter-id');
      if (!id || !before.has(id)) return;
      const b = before.get(id)!;
      const a = el.getBoundingClientRect();
      const dx = b.left - a.left;
      const dy = b.top - a.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      toAnimate.push({ el, dx, dy });
    });

    if (toAnimate.length === 0) return;

    // Snap to "before" positions instantly (before paint)
    toAnimate.forEach(({ el, dx, dy }) => {
      el.style.willChange = 'transform';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.style.transition = 'none';
    });

    // Play to natural positions: single RAF + forced reflow is more reliable on mobile
    // than double RAF, which can collapse on some iOS Safari versions
    requestAnimationFrame(() => {
      // Force the browser to acknowledge the inverse transform before we animate forward
      toAnimate.forEach(({ el }) => el.getBoundingClientRect());
      toAnimate.forEach(({ el }) => {
        el.style.transform = '';
        el.style.transition = 'transform 420ms cubic-bezier(0.4, 0, 0.2, 1)';
        el.addEventListener('transitionend', () => {
          el.style.transform = '';
          el.style.transition = '';
          el.style.willChange = '';
        }, { once: true });
      });
    });
  }, [viewMode]);

  // ---- SEARCH INDEX ----
  useEffect(() => {
    if (!searchOpen || !user || searchIndexBuilt.current || displayChapters.length === 0) return;
    searchIndexBuilt.current = true;
    const build = async () => {
      const idx = new Map<string, string>();
      await Promise.all(displayChapters.map(async c => {
        try {
          const snap = await getDocs(collection(db, 'users', user.uid, 'chapters', c.id, 'cards'));
          const text = snap.docs.map(d => {
            const data = d.data();
            const items = (data.items || [])
              .map((item: any) => typeof item === 'string' ? item : (item.text || ''))
              .join(' ');
            return `${data.title || ''} ${items}`;
          }).join(' ');
          idx.set(c.id, text);
        } catch { /* skip */ }
      }));
      setSearchIndex(idx);
    };
    build();
  }, [searchOpen, user, displayChapters]);

  // Invalidate index when decks change (new deck created, etc.)
  useEffect(() => {
    searchIndexBuilt.current = false;
  }, [chapters.length]);

  const closeSearch = () => { setSearchOpen(false); setSearchQuery(''); };
  const menuChapter = displayChapters.find(c => c.id === menuChapterId) ?? null;

  const visibleChapters = searchQuery.trim()
    ? (() => {
        const q = searchQuery.trim().toLowerCase();
        return displayChapters.filter(c =>
          c.title.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          (searchIndex.get(c.id) || '').toLowerCase().includes(q)
        );
      })()
    : displayChapters;

  if (selectedChapterId) {
    return <ChapterDetail chapterId={selectedChapterId} ownerUid={selectedOwnerUid ?? undefined} onBack={handleBackFromDeck} autoFocusNote={freshDeck} />;
  }

  if (showLunchCount) {
    return <LunchCountPage onBack={() => setShowLunchCount(false)} />;
  }

  return (
    <div className="min-h-screen bg-[#faf7f2]">
      {/* Ghost mode banner */}
      {isGhostMode && (
        <div className="fixed top-0 left-0 right-0 z-[200] bg-amber-500 shadow-lg">
          <div className="max-w-2xl mx-auto px-5 py-2.5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-white text-sm font-medium min-w-0">
              <Ghost className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">Ghosting <span className="font-bold">{ghostEmail}</span></span>
            </div>
            <button
              onClick={exitGhost}
              className="text-xs font-semibold text-amber-900 bg-white/90 hover:bg-white px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
            >
              Exit Ghost
            </button>
          </div>
        </div>
      )}
      <div className={isGhostMode ? 'pt-10' : ''}>
      <header className="pt-6 pb-4 px-5 max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 bg-slate-900 rounded-xl flex items-center justify-center shadow-sm flex-shrink-0">
              <ArkIcon className="w-6 h-6 text-white" />
            </div>
            {!searchOpen && (
              <div className="min-w-0">
                <h1 className="text-2xl font-bold text-slate-900 leading-tight">The Ark</h1>
                <p className="text-sm text-slate-500">Your decks</p>
              </div>
            )}
            {searchOpen && (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') closeSearch(); }}
                  placeholder="Search decks..."
                  className="flex-1 min-w-0 px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-900 transition-colors"
                />
                <button
                  onClick={closeSearch}
                  className="p-2 rounded-xl hover:bg-slate-100 transition-colors flex-shrink-0"
                >
                  <X className="w-4 h-4 text-slate-500" />
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {!searchOpen && (
              <button
                onClick={() => setSearchOpen(true)}
                className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors"
                title="Search decks"
              >
                <Search className="w-4 h-4 text-slate-500" />
              </button>
            )}
            {!searchOpen && (
              <button
                onClick={() => setShowLunchCount(true)}
                className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors"
                title="Lunch Count"
              >
                <Camera className="w-4 h-4 text-slate-500" />
              </button>
            )}
            <button
              onClick={toggleView}
              className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors"
              title={viewMode === 'list' ? 'Switch to grid' : 'Switch to list'}
            >
              {viewMode === 'list'
                ? <LayoutGrid className="w-4 h-4 text-slate-500" />
                : <List className="w-4 h-4 text-slate-500" />}
            </button>
            <UserAvatar />
          </div>
        </div>
      </header>

      <main className="px-5 pb-16 max-w-2xl mx-auto">
        <div className="grid grid-cols-2 gap-3 mb-5">
          <button onClick={() => setShowCreateModal(true)} className="bg-[#ede9de] rounded-2xl p-4 hover:bg-[#e6e1d6] transition-colors text-left">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-slate-900 rounded-xl flex items-center justify-center flex-shrink-0"><Plus className="w-4 h-4 text-white" /></div>
              <span className="text-sm font-semibold text-slate-900">Create New</span>
            </div>
          </button>
          <button onClick={() => setShowUploadModal(true)} className="bg-[#ede9de] rounded-2xl p-4 hover:bg-[#e6e1d6] transition-colors text-left">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-slate-900 rounded-xl flex items-center justify-center flex-shrink-0"><Sparkles className="w-4 h-4 text-white" /></div>
              <span className="text-sm font-semibold text-slate-900">Upload</span>
            </div>
          </button>
        </div>

        {loading ? (
          <div className="text-center py-16">
            <div className="inline-block animate-spin rounded-full h-7 w-7 border-b-2 border-slate-900" />
          </div>
        ) : displayChapters.length === 0 && pendingDeletes.size === 0 ? (
          <div className="text-center py-16">
            <ArkIcon className="w-14 h-14 text-slate-300 mx-auto mb-3" />
            <h3 className="text-lg font-semibold text-slate-700 mb-1">No decks yet</h3>
            <p className="text-sm text-slate-500">Create your first deck to get started</p>
          </div>
        ) : (
          <div>
            {viewMode === 'grid' ? (
              /* ── GRID VIEW ── */
              <div ref={gridRef} className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {visibleChapters.map((chapter, index) => {
                  const isDragging = gridDraggingId === chapter.id;
                  const shift = isDragging ? { x: 0, y: 0 } : getGridCardShift(index);
                  return (
                    <div
                      key={chapter.id}
                      data-chapter-id={chapter.id}
                      style={{
                        transform: isDragging
                          ? `translate(${gridDragDeltaX}px, ${gridDragDeltaY}px)`
                          : (shift.x !== 0 || shift.y !== 0) ? `translate(${shift.x}px, ${shift.y}px)` : undefined,
                        transition: isDragging
                          ? (gridDragDeltaX === 0 && gridDragDeltaY === 0 ? 'transform 160ms ease' : 'none')
                          : gridDraggingId ? 'transform 180ms ease' : 'none',
                        position: isDragging ? 'relative' : undefined,
                        zIndex: isDragging ? 50 : undefined,
                      }}
                    >
                      <ChapterCard
                        chapter={chapter}
                        onClick={() => handleSelectChapter(chapter.id, chapter.sharedOwnerUid)}
                        onEdit={chapter.sharedOwnerUid ? undefined : () => startRename(chapter.id)}
                        onDelete={chapter.sharedOwnerUid ? undefined : () => handleDeleteDeck(chapter.id)}
                        onLongPress={chapter.sharedOwnerUid || searchQuery ? undefined : (x, y) => startGridDrag(chapter.id, x, y)}
                        isDragging={isDragging}
                        isGrid
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              /* ── LIST VIEW ── */
              <div ref={listRef} className="flex flex-col gap-3">
                {visibleChapters.map((chapter, index) => {
                  const isDragging = draggingId === chapter.id;
                  const shift = isDragging ? 0 : getCardShift(index);
                  return (
                    <div
                      key={chapter.id}
                      data-chapter-id={chapter.id}
                      style={{
                        transform: isDragging
                          ? `translateY(${dragDelta}px)`
                          : shift !== 0 ? `translateY(${shift}px)` : undefined,
                        transition: isDragging
                          ? (dragDelta === 0 ? 'transform 160ms ease' : 'none')
                          : draggingId ? 'transform 180ms ease' : 'none',
                        position: isDragging ? 'relative' : undefined,
                        zIndex: isDragging ? 50 : undefined,
                      }}
                    >
                      <ChapterCard
                        chapter={chapter}
                        onClick={() => handleSelectChapter(chapter.id, chapter.sharedOwnerUid)}
                        onEdit={chapter.sharedOwnerUid ? undefined : () => startRename(chapter.id)}
                        onDelete={chapter.sharedOwnerUid ? undefined : () => handleDeleteDeck(chapter.id)}
                        onLongPress={chapter.sharedOwnerUid || searchQuery ? undefined : (x, y) => startDrag(chapter.id, y)}
                        isDragging={isDragging}
                        playHint={hintChapterId === chapter.id}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {visibleChapters.length === 0 && searchQuery && (
              <div className="text-center py-12">
                <p className="text-slate-500 text-sm">No decks match "{searchQuery}"</p>
              </div>
            )}
          </div>
        )}
      </main>

      {pendingDeletes.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none">
          {Array.from(pendingDeletes.entries()).map(([id, { title }]) => (
            <div key={id} className="pointer-events-auto flex items-center gap-4 bg-slate-900 text-white pl-4 pr-2 py-2.5 rounded-xl shadow-xl text-sm whitespace-nowrap">
              <span className="text-slate-300"><span className="text-white font-medium">"{title}"</span> deleted</span>
              <button onClick={() => undoDeleteDeck(id)} className="font-semibold text-amber-400 hover:text-amber-300 px-2 py-1 rounded-lg hover:bg-white/10 transition-colors">Undo</button>
            </div>
          ))}
        </div>
      )}

      {menuChapter && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center"
          onClick={() => setMenuChapterId(null)}
        >
          <div
            className="bg-white w-full max-w-sm rounded-t-3xl md:rounded-3xl p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <span className="text-xl leading-none">{menuChapter.icon}</span>
              <p className="text-sm font-semibold text-slate-900 truncate">{menuChapter.title}</p>
            </div>
            <div className="py-1">
              <button
                onClick={() => { setMenuChapterId(null); moveToTop(menuChapter.id); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-2xl transition-colors"
              >
                <ArrowUpToLine className="w-4 h-4 text-slate-400" /> Move to Top
              </button>
              <button
                onClick={() => { setMenuChapterId(null); startRename(menuChapter.id); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-2xl transition-colors"
              >
                <Pencil className="w-4 h-4 text-slate-400" /> Rename
              </button>
              <button
                onClick={() => { setMenuChapterId(null); handleDeleteDeck(menuChapter.id); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-red-500 hover:bg-red-50 rounded-2xl transition-colors"
              >
                <Trash2 className="w-4 h-4 text-red-400" /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {renamingChapterId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-5">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Rename Deck</h2>
            <input
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleRenameDeck(); if (e.key === 'Escape') setRenamingChapterId(null); }}
              autoFocus
              placeholder="Deck name"
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900 text-sm mb-4"
            />
            <div className="flex gap-3">
              <button onClick={() => setRenamingChapterId(null)} className="flex-1 px-4 py-2.5 border border-slate-300 rounded-xl text-sm text-slate-700 hover:bg-slate-50 transition-colors">Cancel</button>
              <button onClick={handleRenameDeck} className="flex-1 px-4 py-2.5 bg-slate-900 text-white rounded-xl text-sm font-medium hover:bg-slate-800 transition-colors">Save</button>
            </div>
          </div>
        </div>
      )}

      {showCreateModal && (
        <>
          {/* Hidden textarea — focused synchronously on Create tap so iOS opens the keyboard
              before navigation. The notes textarea mounts with autoFocus while keyboard is up. */}
          <textarea
            ref={hiddenFocusRef}
            aria-hidden="true"
            readOnly
            style={{
              position: 'fixed', opacity: 0, pointerEvents: 'none',
              width: 1, height: 1, top: 0, left: 0, fontSize: '16px',
            }}
          />
          <CreateChapterModal
            onClose={() => setShowCreateModal(false)}
            onRequestFocus={() => hiddenFocusRef.current?.focus()}
            onCreated={(chapterId) => { setShowCreateModal(false); setFreshDeck(true); setSelectedChapterId(chapterId); }}
          />
        </>
      )}
      {showUploadModal && (
        <UploadModal chapters={displayChapters} onClose={() => setShowUploadModal(false)} onUploaded={() => { setShowUploadModal(false); loadChapters(); }} />
      )}
      </div>
    </div>
  );
}
