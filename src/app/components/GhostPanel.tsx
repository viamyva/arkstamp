import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db, functions } from '../../lib/firebase';
import { httpsCallable } from 'firebase/functions';
import {
  collection, addDoc, query, where, orderBy,
  onSnapshot, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import {
  Ghost, LogOut, Clock, AlertTriangle, Loader2,
  ChevronDown, Search, RefreshCw, Activity,
} from 'lucide-react';

const ADMIN_EMAIL = 'edcrewguy@gmail.com';
const RECENT_KEY = 'ark-ghost-recent';
const MAX_RECENT = 8;

// Firestore path: users/{adminUid}/ghostLog/{docId}
const GHOST_LOG_COLLECTION = 'ghostLog';

interface RecentTarget { uid: string; email: string; lastUsed: number; }
interface UserEntry { uid: string; email: string; displayName: string | null; }
interface LogEntry {
  id: string;
  targetEmail: string;
  targetUid: string;
  accessedAt: Date;
}

function getRecent(): RecentTarget[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

function saveRecent(uid: string, email: string) {
  const prev = getRecent().filter(r => r.uid !== uid);
  const next = [{ uid, email, lastUsed: Date.now() }, ...prev].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

function formatRelative(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function formatDateTime(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// Group log entries by day label
function groupByDay(entries: LogEntry[]): { label: string; items: LogEntry[] }[] {
  const groups: Map<string, LogEntry[]> = new Map();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);

  for (const entry of entries) {
    const d = entry.accessedAt;
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let label: string;
    if (dayStart.getTime() === today.getTime()) label = 'Today';
    else if (dayStart.getTime() === yesterday.getTime()) label = 'Yesterday';
    else label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

interface GhostPanelProps {
  deckTitle: string;
  onBack?: () => void;
}

export function GhostPanel({ deckTitle, onBack }: GhostPanelProps) {
  const { user, isGhostMode, ghostEmail, startGhost, exitGhost } = useAuth();

  // User list state
  const [allUsers, setAllUsers] = useState<UserEntry[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [usersError, setUsersError] = useState('');

  // Migration state
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState<{ migrated: any[]; skipped: any[]; empty: any[] } | null>(null);
  const [migrateError, setMigrateError] = useState('');

  const runMigration = async () => {
    if (!user) return;
    setMigrating(true);
    setMigrateResult(null);
    setMigrateError('');
    try {
      const fn = httpsCallable(functions, 'migrateOverviewToTodo');
      const res = await fn({}) as any;
      setMigrateResult(res.data ?? { migrated: [], skipped: [], empty: [] });
    } catch (err: any) {
      setMigrateError(err?.message ?? 'Migration failed.');
    } finally {
      setMigrating(false);
    }
  };

  // Dropdown state
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserEntry | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Enter ghost state
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState('');

  // Recent targets (localStorage)
  const [recent, setRecent] = useState<RecentTarget[]>([]);

  // Activity log (Firestore, past 7 days)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(true);

  useEffect(() => { setRecent(getRecent()); }, [isGhostMode]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Safety: only render for admin
  if (user?.email !== ADMIN_EMAIL && !isGhostMode) return null;

  // ── User list ────────────────────────────────────────────────
  const fetchUsers = async () => {
    setLoadingUsers(true);
    setUsersError('');
    try {
      const listUsers = httpsCallable(functions, 'adminListUsers');
      const result = await listUsers({}) as any;
      setAllUsers(result.data.users ?? []);
    } catch (err: any) {
      setUsersError(err?.message?.replace('Firebase: ', '') ?? 'Failed to load users.');
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    if (user?.email === ADMIN_EMAIL) fetchUsers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Activity log subscription ────────────────────────────────
  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) return;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const logRef = collection(db, 'users', user.uid, GHOST_LOG_COLLECTION);
    const q = query(
      logRef,
      where('accessedAt', '>=', Timestamp.fromDate(sevenDaysAgo)),
      orderBy('accessedAt', 'desc'),
    );

    const unsub = onSnapshot(q, (snap) => {
      const entries: LogEntry[] = snap.docs.map(d => ({
        id: d.id,
        targetEmail: d.data().targetEmail,
        targetUid: d.data().targetUid,
        accessedAt: (d.data().accessedAt as Timestamp).toDate(),
      }));
      setLogEntries(entries);
      setLogLoading(false);
    }, () => setLogLoading(false));

    return unsub;
  }, [user]);

  // ── Helpers ──────────────────────────────────────────────────
  const filteredUsers = allUsers.filter(u =>
    u.email.toLowerCase().includes(filterQuery.toLowerCase()) ||
    (u.displayName ?? '').toLowerCase().includes(filterQuery.toLowerCase())
  );

  const logAccess = async (adminUid: string, targetUid: string, targetEmail: string) => {
    try {
      await addDoc(collection(db, 'users', adminUid, GHOST_LOG_COLLECTION), {
        targetUid,
        targetEmail,
        accessedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('[GhostPanel] Failed to log ghost access:', err);
    }
  };

  const enterGhost = async (targetUid: string, targetEmail: string) => {
    if (!targetUid || !targetEmail) return;
    if (targetEmail === ADMIN_EMAIL) { setEnterError("That's you."); return; }
    setEntering(true);
    setEnterError('');
    try {
      // Log to Firestore before navigating away
      if (user) await logAccess(user.uid, targetUid, targetEmail);
      saveRecent(targetUid, targetEmail);
      setRecent(getRecent());
      startGhost(targetUid, targetEmail);
      setSelectedUser(null);
      setFilterQuery('');
      onBack?.();
    } catch (err: any) {
      setEnterError(err?.message?.replace('Firebase: ', '') ?? 'Failed to enter ghost mode.');
    } finally {
      setEntering(false);
    }
  };

  const handleDropdownSelect = (u: UserEntry) => {
    setSelectedUser(u);
    setDropdownOpen(false);
    setFilterQuery('');
    setEnterError('');
  };

  const grouped = groupByDay(logEntries);

  return (
    <div className="max-w-lg space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 bg-amber-500 rounded-2xl flex items-center justify-center text-2xl shadow-sm">
          👻
        </div>
        <div>
          <h2 className="text-xl font-bold text-slate-900">{deckTitle}</h2>
          <p className="text-sm text-slate-500">Soft-access any account for troubleshooting</p>
        </div>
      </div>

      {/* Active ghost session banner */}
      {isGhostMode && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Ghost className="w-5 h-5 text-amber-600 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-900">Active session</p>
              <p className="text-xs text-amber-700 truncate">{ghostEmail}</p>
            </div>
          </div>
          <button
            onClick={exitGhost}
            className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 bg-white border border-amber-300 hover:bg-amber-100 px-3 py-2 rounded-xl transition-colors flex-shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            Exit Ghost
          </button>
        </div>
      )}

      {/* User dropdown selector */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {isGhostMode ? 'Switch Target' : 'Select Target'}
          </p>
          <button
            onClick={fetchUsers}
            disabled={loadingUsers}
            title="Refresh user list"
            className="text-slate-400 hover:text-amber-600 transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingUsers ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => { setDropdownOpen(o => !o); setFilterQuery(''); }}
            disabled={loadingUsers}
            className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl border border-slate-200 text-sm bg-white hover:border-amber-400 focus:outline-none focus:border-amber-500 transition-colors disabled:opacity-50"
          >
            <span className={selectedUser ? 'text-slate-800' : 'text-slate-400'}>
              {loadingUsers ? 'Loading users…' : selectedUser ? selectedUser.email : 'Choose a user…'}
            </span>
            {loadingUsers
              ? <Loader2 className="w-4 h-4 text-slate-400 animate-spin flex-shrink-0" />
              : <ChevronDown className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
            }
          </button>

          {dropdownOpen && (
            <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
                <Search className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                <input
                  autoFocus
                  type="text"
                  value={filterQuery}
                  onChange={e => setFilterQuery(e.target.value)}
                  placeholder="Filter users…"
                  className="flex-1 text-sm outline-none text-slate-700 placeholder-slate-400 bg-transparent"
                />
              </div>
              <div className="max-h-60 overflow-y-auto">
                {usersError ? (
                  <div className="px-4 py-3 text-xs text-red-500 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{usersError}
                  </div>
                ) : filteredUsers.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-slate-400">
                    {filterQuery ? 'No users match your filter.' : 'No users found.'}
                  </div>
                ) : (
                  filteredUsers.map(u => (
                    <button
                      key={u.uid}
                      type="button"
                      onClick={() => handleDropdownSelect(u)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-amber-50 text-left transition-colors"
                    >
                      <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                        <Ghost className="w-3 h-3 text-amber-600" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm text-slate-800 truncate">{u.email}</p>
                        {u.displayName && (
                          <p className="text-xs text-slate-400 truncate">{u.displayName}</p>
                        )}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Enter button */}
        <button
          onClick={() => selectedUser && enterGhost(selectedUser.uid, selectedUser.email)}
          disabled={!selectedUser || entering}
          className="w-full px-4 py-2.5 bg-amber-500 text-white text-sm font-semibold rounded-xl hover:bg-amber-600 disabled:opacity-30 transition-colors flex items-center justify-center gap-1.5"
        >
          {entering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ghost className="w-4 h-4" />}
          {entering ? 'Entering…' : 'Enter Ghost Mode'}
        </button>

        {enterError && (
          <p className="text-xs text-red-500 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{enterError}
          </p>
        )}
      </div>

      {/* Recent targets */}
      {recent.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />Quick Access
          </p>
          <div className="space-y-1">
            {recent.map(r => (
              <button
                key={r.uid}
                onClick={() => enterGhost(r.uid, r.email)}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-slate-50 transition-colors text-left group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                    <Ghost className="w-3.5 h-3.5 text-amber-600" />
                  </div>
                  <p className="text-sm text-slate-700 truncate">{r.email}</p>
                </div>
                <span className="text-xs text-slate-400 group-hover:text-amber-600 transition-colors flex-shrink-0 ml-2">
                  Enter
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Activity feed — past 7 days */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4">
        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-slate-400" />
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Activity — Past 7 Days
          </p>
        </div>

        {logLoading ? (
          <div className="flex items-center gap-2 py-4 justify-center">
            <Loader2 className="w-4 h-4 text-slate-300 animate-spin" />
            <span className="text-xs text-slate-400">Loading log…</span>
          </div>
        ) : logEntries.length === 0 ? (
          <p className="text-xs text-slate-400 py-2 text-center">No ghost sessions in the past 7 days.</p>
        ) : (
          <div className="space-y-4">
            {grouped.map(({ label, items }) => (
              <div key={label}>
                {/* Day label */}
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 px-1">
                  {label}
                </p>
                {/* Entries for that day */}
                <div className="relative">
                  {/* Vertical timeline line */}
                  <div className="absolute left-[13px] top-2 bottom-2 w-px bg-slate-100" />
                  <div className="space-y-0">
                    {items.map((entry, i) => (
                      <div key={entry.id} className="flex items-start gap-3 py-2">
                        {/* Dot */}
                        <div className="w-[27px] flex-shrink-0 flex items-center justify-center pt-0.5">
                          <div className="w-2 h-2 rounded-full bg-amber-400 ring-2 ring-white" />
                        </div>
                        {/* Content */}
                        <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
                          <p className="text-sm text-slate-700 truncate">{entry.targetEmail}</p>
                          <span
                            className="text-[11px] text-slate-400 flex-shrink-0 whitespace-nowrap"
                            title={formatDateTime(entry.accessedAt)}
                          >
                            {formatRelative(entry.accessedAt)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Overview Migration */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl px-4 py-4 space-y-3">
        <p className="text-xs font-semibold text-slate-700 uppercase tracking-wider">Overview Migration</p>
        <p className="text-xs text-slate-500 leading-relaxed">
          Copies all card data from the old Overview tab into a new To-do tab for every deck. Safe to run more than once — items are appended, not duplicated if you re-run.
        </p>
        <button
          onClick={runMigration}
          disabled={migrating}
          className="px-4 py-2 bg-slate-900 text-white text-xs font-semibold rounded-xl hover:bg-slate-700 disabled:opacity-40 transition-colors"
        >
          {migrating ? 'Migrating...' : 'Run Migration'}
        </button>
        {migrateError && <p className="text-xs text-red-500">{migrateError}</p>}
        {migrateResult !== null && (
          <div className="space-y-2 pt-1">
            {migrateResult.migrated.length === 0 && migrateResult.skipped.length === 0
              ? <p className="text-xs text-slate-400">No decks had Overview card data to migrate.</p>
              : null
            }
            {migrateResult.migrated.length > 0 && (
              <div className="space-y-0.5">
                <p className="text-xs font-semibold text-green-700">Migrated:</p>
                {migrateResult.migrated.map((r: any) => (
                  <p key={r.chapterId} className="text-xs text-slate-600 pl-2">
                    <span className="font-medium">{r.chapterTitle}</span> — {r.itemsAdded} item{r.itemsAdded !== 1 ? 's' : ''} added{r.tabIsNew ? ' (new To-do tab created)' : ''}
                  </p>
                ))}
              </div>
            )}
            {migrateResult.skipped.length > 0 && (
              <div className="space-y-0.5">
                <p className="text-xs font-semibold text-amber-600">Skipped (already had items):</p>
                {migrateResult.skipped.map((r: any) => (
                  <p key={r.chapterId} className="text-xs text-slate-500 pl-2">{r.chapterTitle}</p>
                ))}
              </div>
            )}
            <p className="text-xs text-slate-400 pt-1">Hard-reload any open decks to see new tabs.</p>
          </div>
        )}
      </div>

      {/* Warning */}
      <div className="flex items-start gap-3 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3">
        <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-slate-500 leading-relaxed">
          Ghost actions are real. Edits, deletions, and uploads made while ghosting affect the user's actual data. Use for read-only troubleshooting when possible.
        </p>
      </div>
    </div>
  );
}
