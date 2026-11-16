import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db, storage } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc, updateDoc,
  getDocs, query, orderBy, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import {
  ref as storageRef, uploadBytes, getDownloadURL, deleteObject,
} from 'firebase/storage';
import {
  Plus, Trash2, Loader2, Download, X, Pencil, Check,
  FolderOpen, ArrowLeft, Image, GripVertical, SortAsc, Calendar,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
interface Album {
  id: string;
  name: string;
  order: number;
  createdAt: number; // ms timestamp for sort
}

interface Photo {
  id: string;
  fileName: string;
  fileUrl: string;
  uploadedAt: number; // ms
  order: number;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
    </div>
  );
}

function downloadUrl(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.click();
}

// ─────────────────────────────────────────────────────────────
// ALBUM COVER — 2×2 collage of the 4 most-recent photos
// ─────────────────────────────────────────────────────────────
function AlbumCover({ photos }: { photos: Photo[] }) {
  // Most-recent 4 (photos are already sorted newest-first by the parent)
  const preview = photos.slice(0, 4);

  if (preview.length === 0) {
    // Blank folder shape
    return (
      <div className="w-full aspect-square rounded-2xl bg-[#ede9de] flex items-center justify-center">
        <FolderOpen className="w-12 h-12 text-slate-400" />
      </div>
    );
  }

  if (preview.length === 1) {
    return (
      <div className="w-full aspect-square rounded-2xl overflow-hidden bg-slate-100">
        <img src={preview[0].fileUrl} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }

  // 2×2 grid for 2–4 photos
  return (
    <div className="w-full aspect-square rounded-2xl overflow-hidden grid grid-cols-2 grid-rows-2 gap-0.5 bg-slate-200">
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="overflow-hidden bg-slate-100">
          {preview[i] ? (
            <img src={preview[i].fileUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-[#ede9de]" />
          )}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ALBUM GRID VIEW (root of Photos tab)
// ─────────────────────────────────────────────────────────────
interface AlbumGridProps {
  chapterId: string;
  tabId: string;
  ownerUid?: string;
  onOpenAlbum: (album: Album) => void;
}

type SortMode = 'manual' | 'date';

function AlbumGrid({ chapterId, tabId, ownerUid, onOpenAlbum }: AlbumGridProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid ?? '';

  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumPhotos, setAlbumPhotos] = useState<Record<string, Photo[]>>({});
  const [loading, setLoading] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>('manual');

  // Rename
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Delete confirm
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Creating new album
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');
  const newAlbumRef = useRef<HTMLInputElement>(null);

  // Drag state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSrcIndexRef = useRef<number>(-1);
  const gridRef = useRef<HTMLDivElement>(null);

  const colPath = `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/albums`;

  const loadAlbums = useCallback(async () => {
    if (!user) return;
    try {
      const snap = await getDocs(query(collection(db, colPath), orderBy('order', 'asc')));
      const loaded: Album[] = snap.docs.map(d => ({
        id: d.id,
        name: d.data().name ?? 'Album',
        order: d.data().order ?? 0,
        createdAt: d.data().createdAt?.toMillis?.() ?? 0,
      }));
      setAlbums(loaded);

      // Load cover photos for each album (4 most recent)
      const photoMap: Record<string, Photo[]> = {};
      await Promise.all(loaded.map(async album => {
        try {
          const pSnap = await getDocs(
            query(
              collection(db, `${colPath}/${album.id}/photos`),
              orderBy('uploadedAt', 'desc'),
            )
          );
          photoMap[album.id] = pSnap.docs.slice(0, 4).map(d => ({
            id: d.id,
            fileName: d.data().fileName ?? '',
            fileUrl: d.data().fileUrl ?? '',
            uploadedAt: d.data().uploadedAt?.toMillis?.() ?? 0,
            order: d.data().order ?? 0,
          }));
        } catch {
          photoMap[album.id] = [];
        }
      }));
      setAlbumPhotos(photoMap);
    } finally {
      setLoading(false);
    }
  }, [user, colPath]);

  useEffect(() => { loadAlbums(); }, [loadAlbums]);

  // ── CREATE ALBUM ──
  const createAlbum = async () => {
    const name = newAlbumName.trim() || 'Album';
    if (!user) return;
    const maxOrder = albums.length > 0 ? Math.max(...albums.map(a => a.order)) + 1 : 0;
    await addDoc(collection(db, colPath), {
      name,
      order: maxOrder,
      createdAt: serverTimestamp(),
    });
    setCreatingAlbum(false);
    setNewAlbumName('');
    loadAlbums();
  };

  // ── RENAME ALBUM ──
  const startRename = (album: Album) => {
    setRenamingId(album.id);
    setRenameValue(album.name);
    setConfirmDeleteId(null);
    setTimeout(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); }, 50);
  };

  const saveRename = async () => {
    const val = renameValue.trim();
    if (!val || !user || !renamingId) { setRenamingId(null); return; }
    await updateDoc(fsDoc(db, colPath, renamingId), { name: val }).catch(console.error);
    setAlbums(prev => prev.map(a => a.id === renamingId ? { ...a, name: val } : a));
    setRenamingId(null);
  };

  // ── DELETE ALBUM ──
  const deleteAlbum = async (albumId: string) => {
    if (!user) return;
    // Delete all photos in the album from Storage + Firestore
    try {
      const pSnap = await getDocs(collection(db, `${colPath}/${albumId}/photos`));
      const batch = writeBatch(db);
      await Promise.all(pSnap.docs.map(async d => {
        const url: string = d.data().storagePath;
        if (url) {
          try { await deleteObject(storageRef(storage, url)); } catch { /* ignore */ }
        }
        batch.delete(d.ref);
      }));
      await batch.commit();
    } catch { /* ignore */ }
    await deleteDoc(fsDoc(db, colPath, albumId));
    setAlbums(prev => prev.filter(a => a.id !== albumId));
    setConfirmDeleteId(null);
  };

  // ── DOWNLOAD ALBUM ──
  const downloadAlbum = async (album: Album) => {
    if (!user) return;
    try {
      const pSnap = await getDocs(collection(db, `${colPath}/${album.id}/photos`));
      pSnap.docs.forEach(d => {
        const url: string = d.data().fileUrl;
        const name: string = d.data().fileName ?? 'photo.jpg';
        if (url) downloadUrl(url, name);
      });
    } catch { /* ignore */ }
  };

  // ── SAVE ORDER ──
  const saveOrder = async (ordered: Album[]) => {
    if (!user) return;
    const batch = writeBatch(db);
    ordered.forEach((a, i) => batch.update(fsDoc(db, colPath, a.id), { order: i }));
    await batch.commit().catch(console.error);
  };

  // ── DRAG REORDER ──
  const handleDragStart = (e: React.DragEvent, id: string, index: number) => {
    setDraggingId(id);
    dragSrcIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggingId || draggingId === targetId) { setDraggingId(null); setDragOverId(null); return; }
    setAlbums(prev => {
      const next = [...prev];
      const srcIdx = next.findIndex(a => a.id === draggingId);
      const tgtIdx = next.findIndex(a => a.id === targetId);
      if (srcIdx === -1 || tgtIdx === -1) return prev;
      const [item] = next.splice(srcIdx, 1);
      next.splice(tgtIdx, 0, item);
      saveOrder(next);
      return next;
    });
    setDraggingId(null);
    setDragOverId(null);
  };

  const handleDragEnd = () => { setDraggingId(null); setDragOverId(null); };

  // ── SORTED DISPLAY ──
  const displayAlbums = sortMode === 'date'
    ? [...albums].sort((a, b) => b.createdAt - a.createdAt)
    : albums;

  if (loading) return <Spinner />;

  return (
    <div className="max-w-4xl">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-5 gap-3">
        <button
          onClick={() => { setCreatingAlbum(true); setTimeout(() => newAlbumRef.current?.focus(), 50); }}
          className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Album
        </button>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setSortMode('manual')}
            title="Manual order"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              sortMode === 'manual' ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-400'
            }`}
          >
            <GripVertical className="w-3.5 h-3.5" />
            Manual
          </button>
          <button
            onClick={() => setSortMode('date')}
            title="Sort by date added"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              sortMode === 'date' ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-400'
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            Date Added
          </button>
        </div>
      </div>

      {/* New album input */}
      {creatingAlbum && (
        <div className="mb-5 flex items-center gap-2">
          <input
            ref={newAlbumRef}
            value={newAlbumName}
            onChange={e => setNewAlbumName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') createAlbum();
              if (e.key === 'Escape') { setCreatingAlbum(false); setNewAlbumName(''); }
            }}
            placeholder="Album name…"
            className="flex-1 px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
          <button
            onClick={createAlbum}
            className="px-4 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 transition-colors"
          >
            Create
          </button>
          <button
            onClick={() => { setCreatingAlbum(false); setNewAlbumName(''); }}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 text-sm rounded-xl hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Album grid */}
      {displayAlbums.length === 0 && !creatingAlbum ? (
        <div className="text-center py-16">
          <FolderOpen className="w-14 h-14 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">No albums yet. Create one to get started.</p>
        </div>
      ) : (
        <div ref={gridRef} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {displayAlbums.map((album, index) => (
            <div
              key={album.id}
              draggable={sortMode === 'manual'}
              onDragStart={e => handleDragStart(e, album.id, index)}
              onDragOver={e => handleDragOver(e, album.id)}
              onDrop={e => handleDrop(e, album.id)}
              onDragEnd={handleDragEnd}
              className={`group relative cursor-pointer select-none transition-all ${
                draggingId === album.id ? 'opacity-40 scale-95' : ''
              } ${dragOverId === album.id && draggingId !== album.id ? 'ring-2 ring-slate-900 rounded-2xl' : ''}`}
            >
              {/* Cover */}
              <div
                onClick={() => {
                  if (renamingId === album.id || confirmDeleteId === album.id) return;
                  onOpenAlbum(album);
                }}
              >
                <AlbumCover photos={albumPhotos[album.id] ?? []} />
              </div>

              {/* Name row */}
              <div className="mt-2 px-0.5 flex items-center gap-1.5">
                {renamingId === album.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={saveRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="flex-1 text-sm font-medium text-slate-900 bg-transparent border-b border-slate-400 focus:outline-none"
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="flex-1 text-sm font-medium text-slate-900 truncate"
                    onClick={() => onOpenAlbum(album)}
                  >
                    {album.name}
                  </span>
                )}

                {/* Action buttons — visible on hover */}
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <button
                    title="Rename"
                    onClick={e => { e.stopPropagation(); startRename(album); }}
                    className="p-1 rounded-lg hover:bg-slate-100 transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5 text-slate-500" />
                  </button>
                  <button
                    title="Download all photos"
                    onClick={e => { e.stopPropagation(); downloadAlbum(album); }}
                    className="p-1 rounded-lg hover:bg-slate-100 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5 text-slate-500" />
                  </button>
                  <button
                    title="Delete album"
                    onClick={e => { e.stopPropagation(); setConfirmDeleteId(album.id); setRenamingId(null); }}
                    className="p-1 rounded-lg hover:bg-red-50 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  </button>
                </div>
              </div>

              {/* Photo count */}
              <p className="text-xs text-slate-400 mt-0.5 px-0.5">
                {(albumPhotos[album.id] ?? []).length === 0
                  ? 'Empty'
                  : `${albumPhotos[album.id]?.length ?? 0}+ photos`}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirm modal */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-5"
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Delete Album?</h3>
            <p className="text-sm text-slate-500 mb-5">
              All photos inside this album will be permanently deleted.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="flex-1 px-4 py-2.5 border border-slate-300 rounded-xl text-sm text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteAlbum(confirmDeleteId)}
                className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ALBUM DETAIL VIEW
// ─────────────────────────────────────────────────────────────
interface AlbumDetailProps {
  chapterId: string;
  tabId: string;
  album: Album;
  ownerUid?: string;
  onBack: () => void;
}

function AlbumDetail({ chapterId, tabId, album, ownerUid, onBack }: AlbumDetailProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid ?? '';

  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState<Photo | null>(null);

  // Per-photo actions
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const colPath = `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/albums/${album.id}/photos`;

  const loadPhotos = useCallback(async () => {
    if (!user) return;
    try {
      const snap = await getDocs(query(collection(db, colPath), orderBy('uploadedAt', 'desc')));
      setPhotos(snap.docs.map(d => ({
        id: d.id,
        fileName: d.data().fileName ?? '',
        fileUrl: d.data().fileUrl ?? '',
        uploadedAt: d.data().uploadedAt?.toMillis?.() ?? 0,
        order: d.data().order ?? 0,
      })));
    } finally {
      setLoading(false);
    }
  }, [user, colPath]);

  useEffect(() => { loadPhotos(); }, [loadPhotos]);

  // ── UPLOAD ──
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || !user) return;
    setUploading(true);
    try {
      const fileArray = Array.from(files);
      await Promise.all(fileArray.map(async (file, i) => {
        const path = `users/${effectiveUid}/photos/${chapterId}/${tabId}/${album.id}/${Date.now()}-${i}-${file.name}`;
        const sRef = storageRef(storage, path);
        await uploadBytes(sRef, file);
        const url = await getDownloadURL(sRef);
        await addDoc(collection(db, colPath), {
          fileName: file.name,
          fileUrl: url,
          storagePath: path,
          uploadedAt: serverTimestamp(),
          order: Date.now() + i,
        });
      }));
      await loadPhotos();
    } finally {
      setUploading(false);
    }
  };

  // ── RENAME PHOTO ──
  const startRename = (photo: Photo) => {
    setRenamingId(photo.id);
    setRenameValue(photo.fileName);
    setConfirmDeleteId(null);
    setTimeout(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); }, 50);
  };

  const saveRename = async () => {
    const val = renameValue.trim();
    if (!val || !user || !renamingId) { setRenamingId(null); return; }
    await updateDoc(fsDoc(db, colPath, renamingId), { fileName: val }).catch(console.error);
    setPhotos(prev => prev.map(p => p.id === renamingId ? { ...p, fileName: val } : p));
    setRenamingId(null);
  };

  // ── DELETE PHOTO ──
  const deletePhoto = async (photoId: string) => {
    if (!user) return;
    const photo = photos.find(p => p.id === photoId);
    // Try to delete from Storage (best-effort)
    if (photo) {
      try {
        const snap = await getDocs(collection(db, colPath));
        const docSnap = snap.docs.find(d => d.id === photoId);
        const sp: string | undefined = docSnap?.data().storagePath;
        if (sp) await deleteObject(storageRef(storage, sp));
      } catch { /* ignore */ }
    }
    await deleteDoc(fsDoc(db, colPath, photoId));
    setPhotos(prev => prev.filter(p => p.id !== photoId));
    setConfirmDeleteId(null);
    if (lightboxPhoto?.id === photoId) setLightboxPhoto(null);
  };

  if (loading) return <Spinner />;

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-5 gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Albums</span>
        </button>
        <h2 className="text-lg font-semibold text-slate-900 flex-1 text-center truncate">{album.name}</h2>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded-xl hover:bg-slate-800 disabled:opacity-50 transition-colors"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {uploading ? 'Uploading…' : 'Add Photos'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={e => handleUpload(e.target.files)}
        />
      </div>

      {/* Photo grid */}
      {photos.length === 0 ? (
        <div
          className="border-2 border-dashed border-slate-200 rounded-2xl py-20 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-slate-400 transition-colors"
          onClick={() => fileInputRef.current?.click()}
        >
          <Image className="w-12 h-12 text-slate-300" />
          <p className="text-sm text-slate-400">Tap to upload photos</p>
          <p className="text-xs text-slate-300">You can select multiple at once</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {photos.map(photo => (
            <div key={photo.id} className="group relative">
              {/* Thumbnail */}
              <div
                className="aspect-square rounded-xl overflow-hidden bg-slate-100 cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => setLightboxPhoto(photo)}
              >
                <img
                  src={photo.fileUrl}
                  alt={photo.fileName}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </div>

              {/* Action overlay */}
              <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  title="Rename"
                  onClick={e => { e.stopPropagation(); startRename(photo); }}
                  className="w-7 h-7 bg-white/90 rounded-lg flex items-center justify-center shadow hover:bg-white transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5 text-slate-600" />
                </button>
                <button
                  title="Download"
                  onClick={e => { e.stopPropagation(); downloadUrl(photo.fileUrl, photo.fileName); }}
                  className="w-7 h-7 bg-white/90 rounded-lg flex items-center justify-center shadow hover:bg-white transition-colors"
                >
                  <Download className="w-3.5 h-3.5 text-slate-600" />
                </button>
                <button
                  title="Delete"
                  onClick={e => { e.stopPropagation(); setConfirmDeleteId(photo.id); setRenamingId(null); }}
                  className="w-7 h-7 bg-white/90 rounded-lg flex items-center justify-center shadow hover:bg-white transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-500" />
                </button>
              </div>

              {/* Rename inline */}
              {renamingId === photo.id && (
                <div className="mt-1 px-0.5">
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={saveRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="w-full text-xs text-slate-800 bg-white border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                </div>
              )}

              {/* File name */}
              {renamingId !== photo.id && (
                <p className="text-xs text-slate-400 mt-1 px-0.5 truncate">{photo.fileName}</p>
              )}
            </div>
          ))}

          {/* Upload tile */}
          <div
            className="aspect-square rounded-xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center gap-1.5 cursor-pointer hover:border-slate-400 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus className="w-6 h-6 text-slate-300" />
            <span className="text-xs text-slate-300">Add</span>
          </div>
        </div>
      )}

      {/* LIGHTBOX */}
      {lightboxPhoto && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center"
          onClick={() => setLightboxPhoto(null)}
        >
          {/* Close button */}
          <button
            className="absolute top-4 right-4 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center transition-colors z-10"
            onClick={() => setLightboxPhoto(null)}
          >
            <X className="w-5 h-5 text-white" />
          </button>

          {/* Nav arrows */}
          {photos.length > 1 && (
            <>
              <button
                className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center transition-colors z-10"
                onClick={e => {
                  e.stopPropagation();
                  const idx = photos.findIndex(p => p.id === lightboxPhoto.id);
                  setLightboxPhoto(photos[(idx - 1 + photos.length) % photos.length]);
                }}
              >
                <ArrowLeft className="w-5 h-5 text-white" />
              </button>
              <button
                className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center transition-colors z-10"
                onClick={e => {
                  e.stopPropagation();
                  const idx = photos.findIndex(p => p.id === lightboxPhoto.id);
                  setLightboxPhoto(photos[(idx + 1) % photos.length]);
                }}
              >
                {/* Right arrow using rotated ArrowLeft */}
                <ArrowLeft className="w-5 h-5 text-white rotate-180" />
              </button>
            </>
          )}

          {/* Image */}
          <img
            src={lightboxPhoto.fileUrl}
            alt={lightboxPhoto.fileName}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
            onClick={e => e.stopPropagation()}
          />

          {/* Bottom bar */}
          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/60 backdrop-blur-sm rounded-2xl px-4 py-2.5"
            onClick={e => e.stopPropagation()}
          >
            <span className="text-white text-sm max-w-[200px] truncate">{lightboxPhoto.fileName}</span>
            <button
              title="Download"
              onClick={() => downloadUrl(lightboxPhoto.fileUrl, lightboxPhoto.fileName)}
              className="w-8 h-8 bg-white/10 hover:bg-white/20 rounded-lg flex items-center justify-center transition-colors"
            >
              <Download className="w-4 h-4 text-white" />
            </button>
            <button
              title="Delete"
              onClick={() => { setConfirmDeleteId(lightboxPhoto.id); setLightboxPhoto(null); }}
              className="w-8 h-8 bg-white/10 hover:bg-white/20 rounded-lg flex items-center justify-center transition-colors"
            >
              <Trash2 className="w-4 h-4 text-red-400" />
            </button>
          </div>
        </div>
      )}

      {/* Delete photo confirm */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-5"
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Delete Photo?</h3>
            <p className="text-sm text-slate-500 mb-5">This photo will be permanently deleted.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="flex-1 px-4 py-2.5 border border-slate-300 rounded-xl text-sm text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deletePhoto(confirmDeleteId)}
                className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT — orchestrates grid ↔ detail navigation
// ─────────────────────────────────────────────────────────────
export interface PhotosTabProps {
  chapterId: string;
  tabId: string;
  ownerUid?: string;
  refreshKey?: number;
}

export function PhotosContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: PhotosTabProps) {
  const [openAlbum, setOpenAlbum] = useState<Album | null>(null);

  // Reset to grid when tabId or refreshKey changes
  useEffect(() => { setOpenAlbum(null); }, [tabId, refreshKey]);

  if (openAlbum) {
    return (
      <AlbumDetail
        chapterId={chapterId}
        tabId={tabId}
        album={openAlbum}
        ownerUid={ownerUid}
        onBack={() => setOpenAlbum(null)}
      />
    );
  }

  return (
    <AlbumGrid
      chapterId={chapterId}
      tabId={tabId}
      ownerUid={ownerUid}
      onOpenAlbum={setOpenAlbum}
    />
  );
}
