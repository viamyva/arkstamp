import React, { useState, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db, storage, functions } from '../../lib/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { X, Upload, Sparkles, Check, Plus, Loader2, FileText, ImageIcon } from 'lucide-react';

// Seed the default Photos tab for a newly created deck
async function seedPhotosTab(uid: string, chapterId: string) {
  await addDoc(collection(db, 'users', uid, 'chapters', chapterId, 'customTabs'), {
    name: 'Photos',
    template: 'photos',
    order: 99,
    createdAt: serverTimestamp(),
  });
}

interface Chapter { id: string; title: string; }
interface UploadModalProps { chapters: Chapter[]; onClose: () => void; onUploaded: () => void; }
type Phase = 'select' | 'analyzing' | 'routing' | 'uploading' | 'done';

function fileIcon(type: string) {
  if (type.startsWith('image/')) return <ImageIcon className="w-5 h-5 text-slate-500" />;
  return <FileText className="w-5 h-5 text-slate-500" />;
}

function readAsText(file: File): Promise<string> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string) || '');
    reader.onerror = () => resolve('');
    reader.readAsText(file);
  });
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string) || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

// Resize image to a smaller JPEG so the Cloud Function payload stays under limits
function compressImage(dataUrl: string, maxDim = 1024): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const ratio = Math.min(1, maxDim / Math.max(img.width, img.height, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      } catch { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function UploadModal({ chapters, onClose, onUploaded }: UploadModalProps) {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>('select');
  const [file, setFile] = useState<File | null>(null);
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const [suggestedIds, setSuggestedIds] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newDeck, setNewDeck] = useState(false);
  const [analysisNote, setAnalysisNote] = useState('');
  const [suggestedDeckName, setSuggestedDeckName] = useState('');
  const [customDeckName, setCustomDeckName] = useState('');
  const [imageAnalysisFailed, setImageAnalysisFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const keywordMatch = (content: string): string[] =>
    chapters
      .filter(c => c.title.toLowerCase().split(/\s+/).filter(w => w.length > 3).some(w => content.toLowerCase().includes(w)))
      .slice(0, 2)
      .map(c => c.id);

  const analyzeFile = async (f: File) => {
    setPhase('analyzing');
    setSuggestedDeckName('');
    setAnalysisNote('');
    setCustomDeckName('');
    setImageAnalysisFailed(false);
    try {
      if (f.type.startsWith('image/')) {
        // ── Image path: use Claude Vision via the new analyzeImage Cloud Function ──
        const dataUrl = await readAsDataURL(f);
        setImgPreview(dataUrl);
        const compressed = await compressImage(dataUrl);

        let suggested: string[] = [];

        try {
          const analyzeImage = httpsCallable(functions, 'analyzeImage');
          const result = await analyzeImage({
            imageBase64: compressed,
            imageType: 'image/jpeg',
          });
          const data = result.data as any;

          const deckName = (data?.deckName || '').trim();
          const details = (data?.details || data?.note || '').trim();

          setSuggestedDeckName(deckName);
          setAnalysisNote(details);
          suggested = keywordMatch(details);
        } catch (imgErr) {
          // analyzeImage failed -- mark it so we can show UI fallback
          console.warn('analyzeImage failed:', imgErr);
          setImageAnalysisFailed(true);
          suggested = [];
        }

        setSuggestedIds(suggested);
        setSelectedIds(new Set(suggested));
      } else {
        // ── Text / PDF path: existing analyzeDocument flow ──
        const content = await readAsText(f);
        let suggested: string[] = [];
        let note = '';
        try {
          const analyzeDocument = httpsCallable(functions, 'analyzeDocument');
          const result = await analyzeDocument({
            content: content.slice(0, 3000),
            fileName: f.name,
            fileType: f.type,
            decks: chapters.map(c => ({ id: c.id, title: c.title })),
          });
          const data = result.data as any;
          suggested = Array.isArray(data?.suggestedDeckIds) ? data.suggestedDeckIds : [];
          note = data?.note || '';
        } catch {
          suggested = keywordMatch(content);
        }
        setAnalysisNote(note);
        setSuggestedIds(suggested);
        setSelectedIds(new Set(suggested));
      }

      setPhase('routing');
    } catch (err) {
      console.error('Analysis error:', err);
      setError('Could not read file. Select a deck manually.');
      setPhase('routing');
    }
  };

  const handleFileSelect = (f: File) => { setFile(f); analyzeFile(f); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f);
  };
  const toggleDeck = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const handleConfirm = async () => {
    if (!user || !file || (selectedIds.size === 0 && !newDeck)) return;
    setPhase('uploading');
    setError(null);
    try {
      const storageRef = ref(storage, `users/${user.uid}/docs/uploads/${Date.now()}-${file.name}`);
      await uploadBytes(storageRef, file);
      const fileUrl = await getDownloadURL(storageRef);

      const docPayload = { fileName: file.name, fileUrl, fileType: file.type, uploadedAt: serverTimestamp() };

      for (const chapterId of Array.from(selectedIds)) {
        await addDoc(collection(db, 'users', user.uid, 'chapters', chapterId, 'docs'), docPayload);
      }

      if (newDeck) {
        const baseName = file.name.replace(/\.[^.]+$/, '');

        // Priority: vision name > user-typed name > generateChapter > filename
        let deckTitle = suggestedDeckName || customDeckName.trim() || baseName;

        if (!suggestedDeckName && !customDeckName.trim() && analysisNote) {
          try {
            const generate = httpsCallable(functions, 'generateChapter');
            const res = await generate({
              prompt: `Suggest a short specific deck name (3-5 words) for organizing: ${analysisNote.slice(0, 250)}. Return only the deck title.`,
            });
            const d = res.data as any;
            const candidate = d?.chapter?.cards?.[0]?.title || d?.chapter?.title || d?.title;
            if (candidate && typeof candidate === 'string' && candidate.length < 80) {
              deckTitle = candidate;
            }
          } catch { /* keep baseName */ }
        }

        // Pick emoji from detected content keywords
        const ctx = (suggestedDeckName + ' ' + customDeckName + ' ' + analysisNote).toLowerCase();
        let icon = '📄';
        if (ctx.includes('wedding') || ctx.includes('married') || ctx.includes('save the date') || ctx.includes('bride') || ctx.includes('groom')) icon = '💍';
        else if (ctx.includes('flight') || ctx.includes('travel') || ctx.includes('hotel') || ctx.includes('trip') || ctx.includes('airport')) icon = '✈️';
        else if (ctx.includes('ticket') || ctx.includes('concert') || ctx.includes('show') || ctx.includes('event') || ctx.includes('performance')) icon = '🎟️';
        else if (ctx.includes('birthday') || ctx.includes('party') || ctx.includes('celebration') || ctx.includes('anniversary')) icon = '🎉';
        else if (file.type.startsWith('image/')) icon = '📷';

        const deckRef = await addDoc(collection(db, 'users', user.uid, 'chapters'), {
          title: deckTitle,
          description: '',
          icon,
          order: -Date.now(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        await addDoc(collection(db, 'users', user.uid, 'chapters', deckRef.id, 'docs'), docPayload);

        // Seed default Photos tab
        await seedPhotosTab(user.uid, deckRef.id);

        // Auto-create Itinerary tab pre-loaded with extracted context
        const itineraryTabRef = await addDoc(collection(db, 'users', user.uid, 'chapters', deckRef.id, 'customTabs'), {
          name: 'Itinerary',
          template: 'itinerary',
          order: 3,
          createdAt: serverTimestamp(),
          contextNotes: analysisNote || '',
        });

        // Auto-populate itinerary segments when we have image-extracted content
        if (analysisNote.trim()) {
          try {
            const genFn = httpsCallable(functions, 'generateChapter');
            const prompt =
              'Extract a travel or event itinerary from the following details and return as cards. ' +
              'Each card: title (descriptive, e.g. "Lunch at Pistarros"), ' +
              'category (must be exactly one of: flight, hotel, car, activity, transfer, note), ' +
              'items (2-4 specific details such as times, dates, addresses, confirmation numbers). ' +
              `Details: ${analysisNote.slice(0, 700)}`;
            const result = await genFn({ prompt });
            const data = result.data as any;
            const cards: any[] = data?.chapter?.cards || data?.cards || [];
            const validCats = ['flight', 'hotel', 'car', 'activity', 'transfer', 'note'];
            for (let i = 0; i < cards.length; i++) {
              const c = cards[i];
              const cat = validCats.includes((c.category || '').toLowerCase().trim())
                ? (c.category as string).toLowerCase().trim()
                : 'note';
              await addDoc(
                collection(db, 'users', user.uid, 'chapters', deckRef.id, 'customTabs', itineraryTabRef.id, 'segments'),
                {
                  title: c.title || 'Untitled',
                  category: cat,
                  details: (c.items || [])
                    .map((item: any) => (typeof item === 'string' ? item : item.text || ''))
                    .filter(Boolean)
                    .slice(0, 8),
                  order: i,
                  createdAt: serverTimestamp(),
                }
              );
            }
          } catch (e) {
            console.warn('Auto-itinerary generation failed (non-fatal):', e);
          }
        }
      }

      setPhase('done');
      setTimeout(() => { onUploaded(); onClose(); }, 1200);
    } catch (err) {
      console.error('Upload failed:', err);
      setError('Upload failed. Please try again.');
      setPhase('routing');
    }
  };

  const totalSelected = selectedIds.size + (newDeck ? 1 : 0);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-5">
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-lg font-semibold text-slate-900">
            {phase === 'select' && 'Upload a File'}
            {phase === 'analyzing' && 'Reading file...'}
            {phase === 'routing' && 'Where should this go?'}
            {phase === 'uploading' && 'Uploading...'}
            {phase === 'done' && 'Done'}
          </h2>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="px-6 pb-6">
          {phase === 'select' && (
            <>
              <div
                className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center gap-3 text-center cursor-pointer transition-colors ${dragOver ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:border-slate-400 hover:bg-slate-50'}`}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
              >
                <Upload className="w-8 h-8 text-slate-400" />
                <div>
                  <p className="font-medium text-slate-700">Drop a file or tap to browse</p>
                  <p className="text-sm text-slate-500 mt-1">Photos, PDFs, and documents</p>
                </div>
              </div>
              <input
                ref={inputRef} type="file" className="hidden"
                accept="image/*,.pdf,.txt,.doc,.docx,.csv,.md"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }}
              />
            </>
          )}

          {phase === 'analyzing' && (
            <div className="flex flex-col items-center py-8 gap-4">
              {imgPreview
                ? <img src={imgPreview} className="w-20 h-20 object-cover rounded-xl shadow-sm" alt="" />
                : <div className="w-16 h-16 bg-slate-100 rounded-xl flex items-center justify-center">{file && fileIcon(file.type)}</div>
              }
              <p className="text-sm font-medium text-slate-700 truncate max-w-xs">{file?.name}</p>
              <div className="flex items-center gap-2 text-slate-500">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-sm">Analyzing with ARKstamp Intelligence...</span>
              </div>
            </div>
          )}

          {(phase === 'routing' || phase === 'uploading') && file && (
            <>
              <div className="flex items-center gap-3 bg-slate-50 rounded-xl px-4 py-3 mb-4">
                {imgPreview
                  ? <img src={imgPreview} className="w-10 h-10 object-cover rounded-lg flex-shrink-0" alt="" />
                  : <div className="w-10 h-10 bg-white rounded-lg border border-slate-200 flex items-center justify-center flex-shrink-0">{fileIcon(file.type)}</div>
                }
                <p className="text-sm font-medium text-slate-800 truncate">{file.name}</p>
              </div>

              {/* Show what the AI read from the image */}
              {(suggestedDeckName || analysisNote) && (
                <div className="flex items-start gap-2 mb-3 px-1">
                  <Sparkles className="w-3.5 h-3.5 text-slate-500 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    {suggestedDeckName && (
                      <p className="text-xs font-semibold text-slate-700 mb-0.5">
                        Detected: {suggestedDeckName}
                      </p>
                    )}
                    {analysisNote && (
                      <p className="text-xs text-slate-500 line-clamp-2">{analysisNote}</p>
                    )}
                  </div>
                </div>
              )}

              {(suggestedIds.length > 0 || analysisNote) && !suggestedDeckName && (
                <div className="flex items-start gap-2 mb-3 px-1">
                  <Sparkles className="w-3.5 h-3.5 text-slate-500 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-slate-500">Suggested based on your decks</p>
                </div>
              )}

              {error && <p className="text-xs text-amber-600 mb-3 px-1">{error}</p>}

              <div className="space-y-1.5 max-h-48 overflow-y-auto mb-4">
                {chapters.map(chapter => {
                  const selected = selectedIds.has(chapter.id);
                  const suggested = suggestedIds.includes(chapter.id);
                  return (
                    <button
                      key={chapter.id}
                      onClick={() => toggleDeck(chapter.id)}
                      disabled={phase === 'uploading'}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors text-left ${selected ? 'bg-slate-900 text-white' : 'bg-slate-50 hover:bg-slate-100 text-slate-800'}`}
                    >
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${selected ? 'bg-white border-white' : 'border-slate-300'}`}>
                        {selected && <Check className="w-3 h-3 text-slate-900" />}
                      </div>
                      <span className="text-sm font-medium flex-1">{chapter.title}</span>
                      {suggested && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${selected ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-500'}`}>
                          Suggested
                        </span>
                      )}
                    </button>
                  );
                })}

                <button
                  onClick={() => setNewDeck(v => !v)}
                  disabled={phase === 'uploading'}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors text-left ${newDeck ? 'bg-slate-900 text-white' : 'bg-slate-50 hover:bg-slate-100 text-slate-700'}`}
                >
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${newDeck ? 'bg-white border-white' : 'border-slate-300'}`}>
                    {newDeck ? <Check className="w-3 h-3 text-slate-900" /> : <Plus className="w-3 h-3 text-slate-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      New Deck{suggestedDeckName ? `: ${suggestedDeckName}` : ''}
                    </p>
                    {newDeck && !suggestedDeckName && (
                      <p className="text-xs mt-0.5 text-white/70">
                        Deck + Itinerary tab will be created
                      </p>
                    )}
                  </div>
                </button>

                {/* Manual name input shown when analysis failed and New Deck is selected */}
                {newDeck && imageAnalysisFailed && (
                  <div className="px-1">
                    <p className="text-xs text-amber-600 mb-1.5">
                      Image could not be read automatically. Name this deck:
                    </p>
                    <input
                      value={customDeckName}
                      onChange={e => setCustomDeckName(e.target.value)}
                      placeholder="e.g. Jen and Doug Wedding"
                      className="w-full px-3 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-400 transition-colors"
                      disabled={phase === 'uploading'}
                    />
                  </div>
                )}
              </div>

              <button
                onClick={handleConfirm}
                disabled={totalSelected === 0 || phase === 'uploading'}
                className="w-full py-3 bg-slate-900 text-white rounded-xl text-sm font-semibold hover:bg-slate-800 disabled:opacity-40 transition-colors flex items-center justify-center gap-2"
              >
                {phase === 'uploading'
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Uploading...</>
                  : totalSelected === 0
                    ? 'Select at least one deck'
                    : `Add to ${totalSelected} Deck${totalSelected !== 1 ? 's' : ''}`
                }
              </button>
            </>
          )}

          {phase === 'done' && (
            <div className="flex flex-col items-center py-8 gap-3">
              <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center">
                <Check className="w-7 h-7 text-green-600" />
              </div>
              <p className="font-medium text-slate-900">File added successfully</p>
              {newDeck && (
                <p className="text-sm text-slate-500 text-center">
                  Deck and itinerary created. Open it to see your plan.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
