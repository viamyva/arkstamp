import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db, functions } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  getDocs, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  Users, UserPlus, UserMinus, UserCheck, Trash2, Loader2,
  X, Check, Clock, Shield, Eye, Edit3, CalendarClock,
  AlertTriangle, Activity, ChevronDown, Mail, ShieldCheck,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

type Role = 'viewer' | 'editor' | 'admin';
type CollabStatus = 'pending' | 'active';
type ExpiryPreset = 'none' | '7d' | '30d' | '90d' | 'custom';

interface Collaborator {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  tabAccess: string[] | 'all';
  expiresAt: any | null;
  invitedAt: any;
  status: CollabStatus;
}

interface ActivityEntry {
  id: string;
  type: 'invited' | 'revoked' | 'role_changed' | 'access_changed' | 'note';
  description: string;
  timestamp: any;
}

export interface TabInfo {
  id: string;
  label: string;
  isBuiltIn: boolean;
}

interface ContactSuggestion {
  name: string;
  email: string;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface SharedAccessTabProps {
  chapterId: string;
  deckTitle: string;
  allTabs: TabInfo[];
  ownerUid?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: any): string {
  if (!ts) return '';
  const date: Date = ts?.toDate?.() ?? new Date(ts);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDate(ts: any): string {
  if (!ts) return '';
  const date: Date = ts?.toDate?.() ?? new Date(ts);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function isExpired(ts: any): boolean {
  if (!ts) return false;
  const date: Date = ts?.toDate?.() ?? new Date(ts);
  return date.getTime() < Date.now();
}

function expiresInDays(preset: ExpiryPreset): Date | null {
  if (preset === 'none') return null;
  const d = new Date();
  if (preset === '7d')  { d.setDate(d.getDate() + 7);  return d; }
  if (preset === '30d') { d.setDate(d.getDate() + 30); return d; }
  if (preset === '90d') { d.setDate(d.getDate() + 90); return d; }
  return null;
}

function initials(name: string, email: string): string {
  const src = name?.trim() || email;
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('');
}

const ROLE_CONFIG: Record<Role, { label: string; description: string; color: string; Icon: React.ComponentType<{ className?: string }> }> = {
  viewer: { label: 'Viewer', description: 'Can only view content',            color: 'text-blue-600 bg-blue-50',   Icon: Eye },
  editor: { label: 'Editor', description: 'Can make changes to content',      color: 'text-amber-600 bg-amber-50', Icon: Edit3 },
  admin:  { label: 'Admin',  description: 'Can delete deck and control sharing', color: 'text-violet-600 bg-violet-50', Icon: Shield },
};

const AVATAR_COLORS = [
  'bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-amber-500',
  'bg-rose-500',   'bg-cyan-500', 'bg-indigo-500',  'bg-teal-500',
];

function avatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  invited:        UserPlus,
  revoked:        UserMinus,
  role_changed:   Edit3,
  access_changed: ShieldCheck,
  note:           Activity,
};

// ── Spinner ──────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
    </div>
  );
}

// ── Role badge ───────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: Role }) {
  const cfg = ROLE_CONFIG[role];
  const Icon = cfg.Icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${cfg.color}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

// ── Grant Access Modal ───────────────────────────────────────────────────────

interface GrantModalProps {
  chapterId: string;
  deckTitle: string;
  allTabs: TabInfo[];
  suggestions: ContactSuggestion[];
  existingEmails: string[];
  onClose: () => void;
  onGranted: (collab: Omit<Collaborator, 'id'>) => Promise<void>;
}

function GrantModal({ chapterId, deckTitle, allTabs, suggestions, existingEmails, onClose, onGranted }: GrantModalProps) {
  const [email, setEmail]             = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole]               = useState<Role>('editor');
  const [tabAccess, setTabAccess]     = useState<string[]>(allTabs.map(t => t.id));
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>('none');
  const [customDate, setCustomDate]   = useState('');
  const [saving, setSaving]           = useState(false);
  const [emailError, setEmailError]   = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const allTabIds = allTabs.map(t => t.id);
  const allChecked = allTabIds.every(id => tabAccess.includes(id));

  const toggleAll = () => {
    setTabAccess(allChecked ? [] : [...allTabIds]);
  };

  const toggleTab = (id: string) => {
    setTabAccess(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const filteredSuggestions = suggestions.filter(s =>
    s.email && !existingEmails.includes(s.email) &&
    (s.email.toLowerCase().includes(email.toLowerCase()) ||
     s.name.toLowerCase().includes(email.toLowerCase()))
  ).slice(0, 5);

  const handleSuggestionPick = (s: ContactSuggestion) => {
    setEmail(s.email);
    setDisplayName(s.name);
    setShowSuggestions(false);
  };

  const validate = (): boolean => {
    if (!email.trim()) { setEmailError('Email is required'); return false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError('Enter a valid email address'); return false;
    }
    if (existingEmails.includes(email.trim().toLowerCase())) {
      setEmailError('This person already has access'); return false;
    }
    setEmailError('');
    return true;
  };

  const handleConfirm = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      let expiresAt: Date | null = null;
      if (expiryPreset === 'custom' && customDate) {
        expiresAt = new Date(customDate);
      } else {
        expiresAt = expiresInDays(expiryPreset);
      }

      await onGranted({
        email:        email.trim().toLowerCase(),
        displayName:  displayName.trim(),
        role,
        tabAccess:    allChecked ? 'all' : tabAccess,
        expiresAt,
        invitedAt:    serverTimestamp(),
        status:       'pending',
      } as any);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-t-3xl md:rounded-3xl shadow-2xl max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100 flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-900 tracking-wide">Grant Access</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* Email input */}
          <div className="relative">
            <input
              ref={emailRef}
              type="email"
              placeholder="Enter email address"
              value={email}
              onChange={e => { setEmail(e.target.value); setEmailError(''); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              autoFocus
              className={`w-full px-4 py-3 rounded-xl border text-sm focus:outline-none transition-colors ${emailError ? 'border-red-400 bg-red-50' : 'border-slate-200 focus:border-slate-900'}`}
            />
            {emailError && <p className="text-xs text-red-500 mt-1.5">{emailError}</p>}

            {/* Suggestions dropdown */}
            {showSuggestions && filteredSuggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-lg z-10 overflow-hidden">
                {filteredSuggestions.map(s => (
                  <button
                    key={s.email}
                    onMouseDown={() => handleSuggestionPick(s)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-left"
                  >
                    <div className={`w-7 h-7 rounded-full ${avatarColor(s.email)} flex items-center justify-center text-white text-xs font-semibold flex-shrink-0`}>
                      {initials(s.name, s.email)}
                    </div>
                    <div className="min-w-0">
                      {s.name && <p className="text-sm font-medium text-slate-900 truncate">{s.name}</p>}
                      <p className="text-xs text-slate-500 truncate">{s.email}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Optional display name */}
          <input
            type="text"
            placeholder="Name (optional)"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors"
          />

          {/* Role picker */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Role</p>
            <div className="space-y-2">
              {(Object.entries(ROLE_CONFIG) as [Role, typeof ROLE_CONFIG[Role]][]).map(([id, cfg]) => {
                const Icon = cfg.Icon;
                const isSelected = role === id;
                return (
                  <button
                    key={id}
                    onClick={() => setRole(id)}
                    className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl border-2 text-left transition-all ${
                      isSelected ? 'border-slate-900 bg-slate-50' : 'border-slate-100 bg-white hover:border-slate-200'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isSelected ? 'bg-slate-900' : 'bg-slate-100'}`}>
                      <Icon className={`w-4 h-4 ${isSelected ? 'text-white' : 'text-slate-500'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold ${isSelected ? 'text-slate-900' : 'text-slate-700'}`}>{cfg.label}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{cfg.description}</p>
                    </div>
                    {isSelected && (
                      <div className="w-5 h-5 bg-slate-900 rounded-full flex items-center justify-center flex-shrink-0">
                        <Check className="w-3 h-3 text-white" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tab access */}
          {allTabs.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Tab Access</p>
              <div className="bg-slate-50 rounded-2xl overflow-hidden">
                {/* Select all */}
                <button
                  onClick={toggleAll}
                  className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-slate-100 transition-colors border-b border-slate-100"
                >
                  <div className={`w-4.5 h-4.5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${allChecked ? 'bg-slate-900 border-slate-900' : 'border-slate-300 bg-white'}`}>
                    {allChecked && <Check className="w-3 h-3 text-white" />}
                  </div>
                  <p className="text-sm font-semibold text-slate-900">{deckTitle}</p>
                  <span className="text-xs text-slate-400 ml-auto">All tabs</span>
                </button>
                {/* Individual tabs */}
                {allTabs.map(tab => {
                  const checked = tabAccess.includes(tab.id);
                  return (
                    <button
                      key={tab.id}
                      onClick={() => toggleTab(tab.id)}
                      className="w-full flex items-center gap-3 pl-9 pr-4 py-3 hover:bg-slate-100 transition-colors border-b border-slate-100 last:border-0"
                    >
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${checked ? 'bg-slate-900 border-slate-900' : 'border-slate-300 bg-white'}`}>
                        {checked && <Check className="w-2.5 h-2.5 text-white" />}
                      </div>
                      <p className="text-sm text-slate-700">{tab.label}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Expiry */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Access Duration</p>
            <div className="grid grid-cols-2 gap-2">
              {([
                { id: 'none', label: 'No expiry' },
                { id: '7d',   label: '7 days' },
                { id: '30d',  label: '30 days' },
                { id: '90d',  label: '90 days' },
              ] as { id: ExpiryPreset; label: string }[]).map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setExpiryPreset(opt.id)}
                  className={`py-2.5 px-3 rounded-xl border-2 text-sm font-medium transition-all ${
                    expiryPreset === opt.id
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-100 bg-white text-slate-600 hover:border-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setExpiryPreset('custom')}
              className={`w-full mt-2 py-2.5 px-3 rounded-xl border-2 text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                expiryPreset === 'custom'
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-100 bg-white text-slate-600 hover:border-slate-200'
              }`}
            >
              <CalendarClock className="w-4 h-4" />
              Custom date
            </button>
            {expiryPreset === 'custom' && (
              <input
                type="date"
                value={customDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setCustomDate(e.target.value)}
                className="w-full mt-2 px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors text-slate-700"
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-8 pt-4 border-t border-slate-100 flex-shrink-0 space-y-2">
          <button
            onClick={handleConfirm}
            disabled={!email.trim() || saving}
            className="w-full py-3 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving ? (
              <><Loader2 className="w-4 h-4 animate-spin" />Granting access...</>
            ) : (
              <><UserCheck className="w-4 h-4" />Confirm Access</>
            )}
          </button>
          <button onClick={onClose} className="w-full py-2.5 text-sm text-slate-500 hover:text-slate-900 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Collaborator Row ─────────────────────────────────────────────────────────

interface CollaboratorRowProps {
  collab: Collaborator;
  onRoleChange: (id: string, role: Role) => void;
  onRemove: (id: string) => void;
}

function CollaboratorRow({ collab, onRoleChange, onRemove }: CollaboratorRowProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const expired = isExpired(collab.expiresAt);

  const expiresDate = collab.expiresAt
    ? (collab.expiresAt?.toDate?.() ?? new Date(collab.expiresAt))
    : null;

  return (
    <div className={`flex items-center gap-3 px-4 py-3.5 rounded-2xl border transition-all ${expired ? 'border-slate-100 bg-slate-50 opacity-60' : 'border-slate-100 bg-white shadow-sm'} group`}>
      {/* Avatar */}
      <div className={`w-9 h-9 rounded-full ${avatarColor(collab.email)} flex items-center justify-center text-white text-xs font-semibold flex-shrink-0`}>
        {initials(collab.displayName, collab.email)}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {collab.displayName && (
            <p className="text-sm font-semibold text-slate-900 truncate">{collab.displayName}</p>
          )}
          <p className={`text-xs truncate ${collab.displayName ? 'text-slate-400' : 'text-sm font-medium text-slate-900'}`}>
            {collab.email}
          </p>
        </div>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {/* Status badge */}
          {expired ? (
            <span className="text-xs text-red-500 font-medium">Expired {formatDate(collab.expiresAt)}</span>
          ) : collab.status === 'pending' ? (
            <span className="text-xs text-amber-500 font-medium flex items-center gap-1">
              <Mail className="w-3 h-3" />Invite pending
            </span>
          ) : (
            <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />Active
            </span>
          )}
          {/* Expiry info */}
          {collab.expiresAt && !expired && (
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />Expires {formatDate(collab.expiresAt)}
            </span>
          )}
          {/* Tab access */}
          {collab.tabAccess !== 'all' && Array.isArray(collab.tabAccess) && (
            <span className="text-xs text-slate-400">
              {collab.tabAccess.length} tab{collab.tabAccess.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Role dropdown */}
      {!confirmRemove && (
        <div className="relative flex-shrink-0">
          <select
            value={collab.role}
            onChange={e => onRoleChange(collab.id, e.target.value as Role)}
            className="appearance-none pr-6 pl-3 py-1.5 rounded-xl border border-slate-200 text-xs font-medium text-slate-700 bg-white focus:outline-none focus:border-slate-900 transition-colors cursor-pointer"
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
        </div>
      )}

      {/* Remove */}
      {confirmRemove ? (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => onRemove(collab.id)}
            className="text-xs text-white bg-red-500 hover:bg-red-600 px-2.5 py-1.5 rounded-xl font-medium transition-colors"
          >Remove</button>
          <button
            onClick={() => setConfirmRemove(false)}
            className="text-xs text-slate-500 hover:text-slate-900 px-2 py-1.5 transition-colors"
          >Cancel</button>
        </div>
      ) : (
        <button
          onClick={() => setConfirmRemove(true)}
          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-xl hover:bg-red-50 transition-all flex-shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5 text-red-400" />
        </button>
      )}
    </div>
  );
}

// ── Activity Feed ────────────────────────────────────────────────────────────

function ActivityFeed({ entries, loading }: { entries: ActivityEntry[]; loading: boolean }) {
  if (loading) return <Spinner />;
  if (entries.length === 0) {
    return <p className="text-center text-sm text-slate-400 py-6">No activity yet</p>;
  }

  return (
    <div className="space-y-1">
      {entries.map((entry, i) => {
        const Icon = ACTIVITY_ICONS[entry.type] ?? Activity;
        const isLast = i === entries.length - 1;
        return (
          <div key={entry.id} className="flex items-start gap-3 relative">
            {/* Vertical line */}
            {!isLast && (
              <div className="absolute left-3.5 top-7 bottom-0 w-px bg-slate-100" />
            )}
            <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0 mt-0.5 z-10">
              <Icon className="w-3.5 h-3.5 text-slate-500" />
            </div>
            <div className="flex-1 py-1 min-w-0">
              <p className="text-sm text-slate-700 leading-snug">{entry.description}</p>
              <p className="text-xs text-slate-400 mt-0.5">{timeAgo(entry.timestamp)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function SharedAccessTab({ chapterId, deckTitle, allTabs, ownerUid }: SharedAccessTabProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [collabs, setCollabs]         = useState<Collaborator[]>([]);
  const [activity, setActivity]       = useState<ActivityEntry[]>([]);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [loading, setLoading]         = useState(true);
  const [activityLoading, setActivityLoading] = useState(true);
  const [showGrantModal, setShowGrantModal]   = useState(false);

  const collabPath  = () => `users/${effectiveUid}/chapters/${chapterId}/collaborators`;
  const logPath     = () => `users/${effectiveUid}/chapters/${chapterId}/activityLog`;
  const customTabPath = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs`;

  // Load collaborators
  const loadCollabs = async () => {
    if (!user) return;
    try {
      const snap = await getDocs(query(collection(db, collabPath()), orderBy('invitedAt', 'desc')));
      setCollabs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Collaborator)));
    } catch {
      try {
        const snap = await getDocs(collection(db, collabPath()));
        setCollabs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Collaborator)));
      } catch {
        // Non-admin collaborators (viewer/editor) can't read the collaborator
        // list per Firestore rules -- fail quietly to an empty list rather
        // than throwing an unhandled rejection.
        setCollabs([]);
      }
    } finally {
      setLoading(false);
    }
  };

  // Load activity log
  const loadActivity = async () => {
    if (!user) return;
    setActivityLoading(true);
    try {
      const snap = await getDocs(query(collection(db, logPath()), orderBy('timestamp', 'desc')));
      const entries = snap.docs.map(d => ({ id: d.id, ...d.data() } as ActivityEntry));
      setActivity(entries.slice(0, 20));
    } catch {
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  };

  // Load contact suggestions from any Contacts-template tabs
  const loadSuggestions = async () => {
    if (!user) return;
    try {
      const tabsSnap = await getDocs(collection(db, customTabPath()));
      const contactTabIds = tabsSnap.docs
        .filter(d => d.data().template === 'contacts')
        .map(d => d.id);

      const allContacts: ContactSuggestion[] = [];
      await Promise.all(contactTabIds.map(async tabId => {
        const contSnap = await getDocs(
          collection(db, `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/contacts`)
        );
        contSnap.docs.forEach(d => {
          const data = d.data();
          if (data.email) allContacts.push({ name: data.name ?? '', email: data.email });
        });
      }));
      setSuggestions(allContacts);
    } catch {
      setSuggestions([]);
    }
  };

  useEffect(() => {
    if (user) {
      loadCollabs();
      loadActivity();
      loadSuggestions();
    }
  }, [chapterId, user]);

  // Write activity log entry
  const logActivity = async (type: ActivityEntry['type'], description: string) => {
    if (!user) return;
    try {
      await addDoc(collection(db, logPath()), { type, description, timestamp: serverTimestamp() });
    } catch {}
  };

  // Grant access
  const handleGrant = async (data: Omit<Collaborator, 'id'>) => {
    if (!user) return;
    await addDoc(collection(db, collabPath()), {
      ...data,
      invitedAt: serverTimestamp(),
    });

    // Send invite email (non-blocking -- grant always succeeds even if email fails)
    try {
      const sendEmail = httpsCallable(functions, 'sendInviteEmail');
      await sendEmail({
        toEmail: data.email,
        toName: data.displayName || '',
        inviterEmail: user.email || '',
        deckTitle,
        role: data.role,
        tabAccess: data.tabAccess,
        expiresAt: data.expiresAt instanceof Date ? data.expiresAt.toISOString() : null,
        ownerUid: effectiveUid,
        chapterId,
      });
    } catch (emailErr) {
      console.warn('[SharedAccessTab] invite email failed:', emailErr);
    }

    const name = (data.displayName || data.email).split('@')[0];
    await logActivity(
      'invited',
      `${name} was invited as ${ROLE_CONFIG[data.role].label}${data.expiresAt ? ` (expires ${formatDate(data.expiresAt)})` : ''}.`
    );
    await loadCollabs();
    await loadActivity();
  };

  // Change role
  const handleRoleChange = async (id: string, newRole: Role) => {
    if (!user) return;
    const collab = collabs.find(c => c.id === id);
    if (!collab) return;
    // Update the collaborator record in the owner's chapter
    await updateDoc(fsDoc(db, collabPath(), id), { role: newRole });
    setCollabs(prev => prev.map(c => c.id === id ? { ...c, role: newRole } : c));
    // Also update the role in the recipient's sharedDecks pointer doc so
    // Firestore security rules immediately reflect the new permission level.
    try {
      const updateRoleFn = httpsCallable(functions, 'updateSharedDeckRole');
      await updateRoleFn({ collaboratorEmail: collab.email, chapterId, newRole });
    } catch (err) {
      console.warn('[SharedAccessTab] updateSharedDeckRole failed (non-fatal):', err);
    }
    const name = (collab.displayName || collab.email).split('@')[0];
    await logActivity('role_changed', `${name}'s role changed to ${ROLE_CONFIG[newRole].label}.`);
    loadActivity();
  };

  // Remove collaborator
  const handleRemove = async (id: string) => {
    if (!user) return;
    const collab = collabs.find(c => c.id === id);
    if (!collab) return;
    await deleteDoc(fsDoc(db, collabPath(), id));
    setCollabs(prev => prev.filter(c => c.id !== id));
    const name = (collab.displayName || collab.email).split('@')[0];
    await logActivity('revoked', `${name}'s access was removed.`);
    loadActivity();
    // Remove the sharedDecks pointer from the recipient's library (non-blocking)
    try {
      const revokeFn = httpsCallable(functions, 'revokeSharedDeck');
      await revokeFn({ collaboratorEmail: collab.email, chapterId });
    } catch (err) {
      console.warn('[SharedAccessTab] revokeSharedDeck failed (non-fatal):', err);
    }
  };

  const existingEmails = collabs.map(c => c.email.toLowerCase());

  // Summary counts
  const roleCount = (r: Role) => collabs.filter(c => c.role === r && !isExpired(c.expiresAt)).length;
  const totalActive = collabs.filter(c => !isExpired(c.expiresAt)).length;
  const expiredCount = collabs.filter(c => isExpired(c.expiresAt)).length;

  // Tabs for the modal (exclude 'shared' tab itself)
  const grantableTabs = allTabs.filter(t => t.id !== 'shared');

  if (loading) return <Spinner />;

  return (
    <div className="max-w-2xl space-y-6">

      {/* Overview card */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 pt-5 pb-4 border-b border-slate-50">
          <h3 className="text-sm font-semibold text-slate-900">Shared Access Overview</h3>
        </div>

        {/* Summary banner */}
        {totalActive > 0 && (
          <div className="mx-5 mt-4 flex items-center gap-2 bg-slate-50 rounded-xl px-4 py-3">
            <Users className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <p className="text-sm text-slate-600">
              This deck is shared with <span className="font-semibold text-slate-900">{totalActive}</span> {totalActive === 1 ? 'person' : 'people'}
              {roleCount('editor') > 0 && <> ({roleCount('editor')} Editor{roleCount('editor') > 1 ? 's' : ''}</>}
              {roleCount('viewer') > 0 && <>, {roleCount('viewer')} Viewer{roleCount('viewer') > 1 ? 's' : ''}</>}
              {roleCount('admin') > 0 && <>, {roleCount('admin')} Admin{roleCount('admin') > 1 ? 's' : ''}</>}
              {totalActive > 0 && <span>)</span>}.
            </p>
          </div>
        )}

        {/* Collaborator list */}
        <div className="px-5 py-4 space-y-2">
          {collabs.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <Users className="w-5 h-5 text-slate-400" />
              </div>
              <p className="text-sm text-slate-500">Only you have access to this deck.</p>
              <p className="text-xs text-slate-400 mt-1">Grant access to collaborate with others.</p>
            </div>
          ) : (
            collabs.map(c => (
              <CollaboratorRow
                key={c.id}
                collab={c}
                onRoleChange={handleRoleChange}
                onRemove={handleRemove}
              />
            ))
          )}
        </div>

        {/* Grant button */}
        <div className="px-5 pb-5">
          <button
            onClick={() => setShowGrantModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all"
          >
            <UserPlus className="w-4 h-4 text-slate-400" />
            Add a Collaborator
          </button>
        </div>
      </div>

      {/* Expired collaborators notice */}
      {expiredCount > 0 && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-amber-700">
            <span className="font-semibold">{expiredCount}</span> {expiredCount === 1 ? 'person' : 'people'} with expired access {expiredCount === 1 ? 'is' : 'are'} shown above. Remove them to clean up your list.
          </p>
        </div>
      )}

      {/* Access info card */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm px-6 py-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">About Access Roles</h3>
        <div className="space-y-2.5">
          {(Object.entries(ROLE_CONFIG) as [Role, typeof ROLE_CONFIG[Role]][]).map(([id, cfg]) => {
            const Icon = cfg.Icon;
            return (
              <div key={id} className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${cfg.color}`}>
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div>
                  <span className="text-sm font-medium text-slate-900">{cfg.label}</span>
                  <span className="text-xs text-slate-400 ml-2">{cfg.description}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Activity log */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm px-6 py-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-4">Activity Log</h3>
        <ActivityFeed entries={activity} loading={activityLoading} />
      </div>

      {/* Grant modal */}
      {showGrantModal && (
        <GrantModal
          chapterId={chapterId}
          deckTitle={deckTitle}
          allTabs={grantableTabs}
          suggestions={suggestions}
          existingEmails={existingEmails}
          onClose={() => setShowGrantModal(false)}
          onGranted={handleGrant}
        />
      )}
    </div>
  );
}
