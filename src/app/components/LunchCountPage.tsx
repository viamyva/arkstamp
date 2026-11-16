import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db, functions } from '../../lib/firebase';
import { doc, getDoc, setDoc, collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { ArrowLeft, Camera, Settings, Loader2, X, Plus, FileText, Check, AlertTriangle } from 'lucide-react';

interface ColumnSetting {
  name: string;
  includeOnForm: boolean;
}

interface RosterEntry {
  name: string;
  color: string;
}

interface Settings {
  headerLine1: string;
  headerLine2: string;
  columns: ColumnSetting[];
  roster: RosterEntry[];
}

interface HistoryEntry {
  date: string;
  pdfUrl: string;
}

const DEFAULT_SETTINGS: Settings = {
  headerLine1: 'Grade 5',
  headerLine2: 'Teacher:',
  columns: [
    { name: 'Special', includeOnForm: true },
    { name: 'Pizza', includeOnForm: true },
    { name: 'PB & J', includeOnForm: true },
    { name: 'Bagel w/Cheese', includeOnForm: true },
    { name: 'Brought from Home', includeOnForm: false },
  ],
  roster: [
    { name: 'Jonathan', color: 'Green' },
    { name: 'Adrianna', color: 'Flaming pink' },
    { name: 'Gavin', color: 'Blue' },
    { name: 'Adrian', color: 'Brown' },
    { name: 'Savannah', color: 'Light pink' },
    { name: 'Joshua', color: 'Green' },
    { name: 'Elif', color: 'Blue' },
    { name: 'Matthew', color: 'Yellow' },
    { name: 'Antonio', color: 'Blue' },
    { name: 'Nina', color: 'Ivory' },
    { name: 'Hendrix', color: 'Grey' },
    { name: 'Harrison', color: 'Yellow' },
    { name: 'Juliana', color: 'Ivory' },
    { name: 'Alura', color: 'Flaming pink' },
    { name: 'Brandon', color: 'Blue' },
    { name: 'Anna', color: 'Pink' },
    { name: 'Ella', color: 'Light pink' },
    { name: 'Asher', color: 'Brown' },
    { name: 'Kamran', color: 'Ivory' },
  ],
};

function todayId(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the photo'));
    reader.readAsDataURL(file);
  });
}

export function LunchCountPage({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const uid = user?.uid;

  const [loadingSettings, setLoadingSettings] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [draftSettings, setDraftSettings] = useState<Settings>(DEFAULT_SETTINGS);

  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [reviewRows, setReviewRows] = useState<Record<string, string[]> | null>(null);
  const [unresolved, setUnresolved] = useState<{ name: string; reason: string }[]>([]);
  const [rowOrder, setRowOrder] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedUrl, setSavedUrl] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!uid) return;
    (async () => {
      setLoadingSettings(true);
      const snap = await getDoc(doc(db, `users/${uid}/lunchCount/settings`));
      if (snap.exists()) {
        const data = { roster: [], ...(snap.data() as Settings) };
        setSettings(data);
        setDraftSettings(data);
      } else {
        setDraftSettings(DEFAULT_SETTINGS);
      }
      setLoadingSettings(false);
    })();
  }, [uid]);

  useEffect(() => {
    if (!uid) return;
    (async () => {
      const q = query(collection(db, `users/${uid}/lunchCounts`), orderBy('date', 'desc'), limit(30));
      const snap = await getDocs(q);
      setHistory(snap.docs.map((d) => d.data() as HistoryEntry));
    })();
  }, [uid, savedUrl]);

  async function saveSettings() {
    if (!uid) return;
    const cleaned: Settings = {
      headerLine1: draftSettings.headerLine1.trim(),
      headerLine2: draftSettings.headerLine2.trim(),
      columns: draftSettings.columns
        .map((c) => ({ name: c.name.trim(), includeOnForm: c.includeOnForm }))
        .filter((c) => c.name.length > 0),
      roster: draftSettings.roster
        .map((r) => ({ name: r.name.trim(), color: r.color.trim() }))
        .filter((r) => r.name.length > 0),
    };
    await setDoc(doc(db, `users/${uid}/lunchCount/settings`), cleaned);
    setSettings(cleaned);
    setShowSettings(false);
  }

  function updateColumn(index: number, patch: Partial<ColumnSetting>) {
    setDraftSettings((prev) => ({
      ...prev,
      columns: prev.columns.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  }

  function addColumn() {
    setDraftSettings((prev) => ({
      ...prev,
      columns: [...prev.columns, { name: '', includeOnForm: true }],
    }));
  }

  function removeColumn(index: number) {
    setDraftSettings((prev) => ({
      ...prev,
      columns: prev.columns.filter((_, i) => i !== index),
    }));
  }

  function updateRosterEntry(index: number, patch: Partial<RosterEntry>) {
    setDraftSettings((prev) => ({
      ...prev,
      roster: prev.roster.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }

  function addRosterEntry() {
    setDraftSettings((prev) => ({
      ...prev,
      roster: [...prev.roster, { name: '', color: '' }],
    }));
  }

  function removeRosterEntry(index: number) {
    setDraftSettings((prev) => ({
      ...prev,
      roster: prev.roster.filter((_, i) => i !== index),
    }));
  }

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !settings) return;
    e.target.value = '';

    setProcessing(true);
    setError('');
    setSavedUrl('');
    try {
      const base64 = await fileToBase64(file);
      const readLunchBoard = httpsCallable(functions, 'readLunchBoard');
      const result = await readLunchBoard({
        imageBase64: base64,
        imageType: file.type || 'image/jpeg',
        columns: settings.columns,
        roster: settings.roster,
      });
      const data = result.data as { rows: Record<string, string[]>; unresolved: { name: string; reason: string }[] };

      const order = ['Breakfast', 'Milk', ...settings.columns.filter((c) => c.includeOnForm).map((c) => c.name)];
      setRowOrder(order);
      setReviewRows(data.rows);
      setUnresolved(data.unresolved || []);
      setDrafts({});
    } catch (err: any) {
      setError(err?.message || 'Could not read the photo. Try again with a clearer shot of the board.');
    } finally {
      setProcessing(false);
    }
  }

  function removeName(row: string, name: string) {
    setReviewRows((prev) => {
      if (!prev) return prev;
      return { ...prev, [row]: prev[row].filter((n) => n !== name) };
    });
  }

  function addName(row: string) {
    const value = (drafts[row] || '').trim();
    if (!value) return;
    setReviewRows((prev) => {
      if (!prev) return prev;
      const existing = prev[row] || [];
      if (existing.includes(value)) return prev;
      return { ...prev, [row]: [...existing, value] };
    });
    setDrafts((prev) => ({ ...prev, [row]: '' }));
  }

  // Drag-and-drop for moving a name chip between rows (or in from the
  // "needs your review" list). Built on pointer events rather than native
  // HTML5 drag-and-drop so it works reliably on touch phones, not just desktop.
  const UNRESOLVED_ZONE = '__unresolved__';
  const [dragging, setDragging] = useState<{ name: string; fromRow: string } | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dropTargetRow, setDropTargetRow] = useState<string | null>(null);
  const dragStateRef = useRef<{ name: string; fromRow: string } | null>(null);

  function rowUnderPoint(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y);
    const target = (el as HTMLElement | null)?.closest('[data-lunch-row]') as HTMLElement | null;
    return target?.dataset.lunchRow || null;
  }

  function handleDragMove(e: PointerEvent) {
    setDragPos({ x: e.clientX, y: e.clientY });
    setDropTargetRow(rowUnderPoint(e.clientX, e.clientY));
  }

  function handleDragEnd(e: PointerEvent) {
    window.removeEventListener('pointermove', handleDragMove);
    window.removeEventListener('pointerup', handleDragEnd);
    const current = dragStateRef.current;
    dragStateRef.current = null;
    setDragging(null);
    setDragPos(null);
    setDropTargetRow(null);
    if (!current) return;

    const toRow = rowUnderPoint(e.clientX, e.clientY);
    if (!toRow || toRow === current.fromRow) return;

    if (current.fromRow === UNRESOLVED_ZONE) {
      setUnresolved((prev) => prev.filter((u) => u.name !== current.name));
    }
    setReviewRows((prev) => {
      if (!prev) return prev;
      const fromList =
        current.fromRow === UNRESOLVED_ZONE
          ? undefined
          : (prev[current.fromRow] || []).filter((n) => n !== current.name);
      const toList = (prev[toRow] || []).includes(current.name)
        ? prev[toRow]
        : [...(prev[toRow] || []), current.name];
      return {
        ...prev,
        ...(fromList !== undefined ? { [current.fromRow]: fromList } : {}),
        [toRow]: toList,
      };
    });
  }

  function startDrag(e: React.PointerEvent, fromRow: string, name: string) {
    e.preventDefault();
    const state = { name, fromRow };
    dragStateRef.current = state;
    setDragging(state);
    setDragPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', handleDragMove);
    window.addEventListener('pointerup', handleDragEnd);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handleDragMove);
      window.removeEventListener('pointerup', handleDragEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generatePdf() {
    if (!uid || !reviewRows || !settings) return;
    setSaving(true);
    setError('');
    try {
      const generateLunchCountPdf = httpsCallable(functions, 'generateLunchCountPdf');
      const result = await generateLunchCountPdf({
        date: todayId(),
        headerLine1: settings.headerLine1,
        headerLine2: settings.headerLine2,
        rowOrder,
        rows: reviewRows,
      });
      const data = result.data as { url: string };
      setSavedUrl(data.url);
      setReviewRows(null);
      setUnresolved([]);
    } catch (err: any) {
      setError(err?.message || 'Could not generate the PDF. Try again.');
    } finally {
      setSaving(false);
    }
  }

  function startOver() {
    setReviewRows(null);
    setUnresolved([]);
    setError('');
  }

  if (loadingSettings) {
    return (
      <div className="size-full flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-slate-900" />
      </div>
    );
  }

  if (!settings || showSettings) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
        <header className="pt-6 pb-4 px-5 max-w-2xl mx-auto">
          <div className="flex items-center gap-3">
            <button
              onClick={() => (settings ? setShowSettings(false) : onBack())}
              className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors"
            >
              <ArrowLeft className="w-4 h-4 text-slate-500" />
            </button>
            <h1 className="text-xl font-bold text-slate-900">Lunch Count setup</h1>
          </div>
        </header>
        <main className="px-5 pb-16 max-w-2xl mx-auto">
          <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Header line 1</label>
              <input
                value={draftSettings.headerLine1}
                onChange={(e) => setDraftSettings((p) => ({ ...p, headerLine1: e.target.value }))}
                placeholder="Grade 5"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Header line 2</label>
              <input
                value={draftSettings.headerLine2}
                onChange={(e) => setDraftSettings((p) => ({ ...p, headerLine2: e.target.value }))}
                placeholder="Teacher: Kiriewsky"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                Lunch choice columns, in the order they appear on the board
              </label>
              <div className="space-y-2">
                {draftSettings.columns.map((col, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={col.name}
                      onChange={(e) => updateColumn(i, { name: e.target.value })}
                      placeholder="Column name"
                      className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-slate-600 flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={col.includeOnForm}
                        onChange={(e) => updateColumn(i, { includeOnForm: e.target.checked })}
                      />
                      On form
                    </label>
                    <button
                      onClick={() => removeColumn(i)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 flex-shrink-0"
                    >
                      <X className="w-4 h-4 text-slate-400" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={addColumn}
                className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-slate-700 hover:text-slate-900"
              >
                <Plus className="w-4 h-4" />
                Add column
              </button>
              <p className="mt-2 text-xs text-slate-500">
                Uncheck On form for a column that is not a cafeteria order, such as Brought from Home.
                Those names are dropped instead of being placed on a line.
              </p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                Class roster and clothespin colors
              </label>
              <div className="space-y-2">
                {draftSettings.roster.map((entry, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={entry.name}
                      onChange={(e) => updateRosterEntry(i, { name: e.target.value })}
                      placeholder="Student name"
                      className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900"
                    />
                    <input
                      value={entry.color}
                      onChange={(e) => updateRosterEntry(i, { color: e.target.value })}
                      placeholder="Pin color"
                      className="w-32 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900"
                    />
                    <button
                      onClick={() => removeRosterEntry(i)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 flex-shrink-0"
                    >
                      <X className="w-4 h-4 text-slate-400" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={addRosterEntry}
                className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-slate-700 hover:text-slate-900"
              >
                <Plus className="w-4 h-4" />
                Add student
              </button>
              <p className="mt-2 text-xs text-slate-500">
                Matching a pin's color to a name here helps the reading hold up even when the
                handwriting is hard to make out. Leave this empty to skip color matching.
              </p>
            </div>

            <button
              onClick={saveSettings}
              className="w-full py-2.5 bg-slate-900 text-white rounded-xl text-sm font-semibold hover:bg-slate-800 transition-colors"
            >
              Save settings
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <header className="pt-6 pb-4 px-5 max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onBack}
              className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors flex-shrink-0"
            >
              <ArrowLeft className="w-4 h-4 text-slate-500" />
            </button>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-900 leading-tight">Lunch Count</h1>
              <p className="text-sm text-slate-500">{todayLabel()}</p>
            </div>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors flex-shrink-0"
            title="Edit setup"
          >
            <Settings className="w-4 h-4 text-slate-500" />
          </button>
        </div>
      </header>

      <main className="px-5 pb-16 max-w-2xl mx-auto space-y-5">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-3">{error}</div>
        )}

        {!reviewRows && !processing && (
          <div className="bg-white rounded-2xl p-5 shadow-sm text-center">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handlePhoto}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mx-auto w-16 h-16 bg-slate-900 rounded-2xl flex items-center justify-center hover:bg-slate-800 transition-colors mb-3"
            >
              <Camera className="w-7 h-7 text-white" />
            </button>
            <p className="text-sm font-semibold text-slate-900">Take a photo of the board</p>
            <p className="text-xs text-slate-500 mt-1">Names will be sorted into the form for you to check</p>
          </div>
        )}

        {processing && (
          <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
            <Loader2 className="w-7 h-7 text-slate-400 animate-spin mx-auto mb-3" />
            <p className="text-sm text-slate-600">Reading the board</p>
          </div>
        )}

        {savedUrl && (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-4 flex items-center gap-3">
            <Check className="w-5 h-5 text-green-600 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-green-800">Saved</p>
              <a
                href={savedUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-green-700 underline"
              >
                Open today's PDF
              </a>
            </div>
          </div>
        )}

        {reviewRows && (
          <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
            <p className="text-sm font-semibold text-slate-900">Check the names before saving</p>

            {unresolved.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-amber-800 text-xs font-semibold">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Needs your review
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {unresolved.map((u, i) => (
                    <span
                      key={i}
                      onPointerDown={(e) => startDrag(e, UNRESOLVED_ZONE, u.name)}
                      title={u.reason}
                      style={{ touchAction: 'none' }}
                      className={
                        'inline-flex items-center gap-1 bg-amber-100 text-amber-900 text-xs font-medium px-2.5 py-1 rounded-full cursor-grab active:cursor-grabbing select-none' +
                        (dragging && dragging.fromRow === UNRESOLVED_ZONE && dragging.name === u.name ? ' opacity-30' : '')
                      }
                    >
                      {u.name}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-amber-700">Drag a name onto the correct line below, or add it yourself.</p>
              </div>
            )}

            {rowOrder.map((row) => (
              <div
                key={row}
                data-lunch-row={row}
                className={
                  'border-t border-slate-100 pt-3 first:border-t-0 first:pt-0 rounded-xl transition-colors' +
                  (dropTargetRow === row ? ' bg-slate-50 ring-2 ring-slate-300' : '')
                }
              >
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">{row}</p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {(reviewRows[row] || []).map((name) => (
                    <span
                      key={name}
                      onPointerDown={(e) => startDrag(e, row, name)}
                      style={{ touchAction: 'none' }}
                      className={
                        'inline-flex items-center gap-1 bg-slate-100 text-slate-800 text-xs font-medium px-2.5 py-1 rounded-full cursor-grab active:cursor-grabbing select-none' +
                        (dragging && dragging.fromRow === row && dragging.name === name ? ' opacity-30' : '')
                      }
                    >
                      {name}
                      <button onPointerDown={(e) => e.stopPropagation()} onClick={() => removeName(row, name)}>
                        <X className="w-3 h-3 text-slate-500" />
                      </button>
                    </span>
                  ))}
                  {(reviewRows[row] || []).length === 0 && (
                    <span className="text-xs text-slate-400">No names yet</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={drafts[row] || ''}
                    onChange={(e) => setDrafts((p) => ({ ...p, [row]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addName(row);
                    }}
                    placeholder="Add a name"
                    className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 text-xs focus:outline-none focus:border-slate-900"
                  />
                  <button
                    onClick={() => addName(row)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-100 hover:bg-slate-200 flex-shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5 text-slate-600" />
                  </button>
                </div>
              </div>
            ))}

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={startOver}
                className="flex-1 py-2.5 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-colors"
              >
                Retake photo
              </button>
              <button
                onClick={generatePdf}
                disabled={saving}
                className="flex-1 py-2.5 bg-slate-900 text-white rounded-xl text-sm font-semibold hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save PDF'}
              </button>
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="bg-white rounded-2xl p-5 shadow-sm">
            <p className="text-sm font-semibold text-slate-900 mb-3">Past days</p>
            <div className="space-y-1">
              {history.map((h) => (
                <a
                  key={h.date}
                  href={h.pdfUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2.5 py-2 px-2 rounded-xl hover:bg-slate-50 transition-colors"
                >
                  <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <span className="text-sm text-slate-700">{h.date}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </main>

      {dragging && dragPos && (
        <div
          style={{
            position: 'fixed',
            left: dragPos.x,
            top: dragPos.y,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
          className="inline-flex items-center bg-slate-900 text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg"
        >
          {dragging.name}
        </div>
      )}
    </div>
  );
}
