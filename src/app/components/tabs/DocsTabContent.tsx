import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { db, storage } from '../../../lib/firebase';
import {
  collection, addDoc, deleteDoc, doc as fsDoc,
  onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Plus, Trash2, Loader2, FileText, ImageIcon, File, Download, X } from 'lucide-react';

interface DocItem { id: string; fileName: string; fileUrl: string; fileType: string; uploadedAt: string; }

interface DocsTabContentProps {
  chapterId: string;
  tabId: string;
  ownerUid?: string;
  refreshKey?: number;
}

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
    </div>
  );
}

export function DocsContent({ chapterId, tabId, ownerUid, refreshKey = 0 }: DocsTabContentProps) {
  const { user } = useAuth();
  const effectiveUid = ownerUid ?? user?.uid;
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<DocItem | null>(null);

  const colPath = () => `users/${effectiveUid}/chapters/${chapterId}/customTabs/${tabId}/docs`;

  useEffect(() => {
    if (!user || !effectiveUid) return;
    setLoading(true);
    const unsub = onSnapshot(collection(db, colPath()), snap => {
      setDocs(snap.docs.map(d => ({ id: d.id, ...d.data(), uploadedAt: d.data().uploadedAt?.toDate?.()?.toISOString() ?? '' } as DocItem)));
      setLoading(false);
    }, err => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [tabId, user, effectiveUid, refreshKey]);

  const handleUpload = async (file: File) => {
    if (!user) return;
    setUploading(true);
    try {
      const storageRef = ref(storage, `users/${effectiveUid}/customTabs/${tabId}/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file);
      const fileUrl = await getDownloadURL(storageRef);
      await addDoc(collection(db, colPath()), { fileName: file.name, fileUrl, fileType: file.type, uploadedAt: serverTimestamp() });
    } catch (err) { console.error(err); }
    finally { setUploading(false); }
  };

  const handleDelete = async (d: DocItem) => {
    if (!user) return;
    await deleteDoc(fsDoc(db, colPath(), d.id));
  };

  const handleDownload = async (d: DocItem) => {
    try {
      const res = await fetch(d.fileUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = d.fileName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { window.open(d.fileUrl, '_blank'); }
  };

  if (loading) return <Spinner />;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <label className="cursor-pointer group" onClick={e => e.stopPropagation()}>
          <div className="bg-white rounded-xl border-2 border-dashed border-slate-300 group-hover:border-slate-400 group-hover:bg-slate-50 transition-all overflow-hidden">
            <div className="aspect-square flex flex-col items-center justify-center gap-2">
              {uploading ? <Loader2 className="w-7 h-7 text-slate-400 animate-spin" /> : <><Plus className="w-7 h-7 text-slate-400 group-hover:text-slate-600 transition-colors" /><span className="text-xs text-slate-500">Add file</span></>}
            </div>
          </div>
          <input type="file" multiple onChange={e => { Array.from(e.target.files || []).forEach(handleUpload); (e.target as HTMLInputElement).value = ''; }} className="hidden" disabled={uploading} />
        </label>
        {docs.map(d => {
          const isImage = d.fileType?.startsWith('image/');
          const Icon = isImage ? ImageIcon : d.fileType?.includes('pdf') ? FileText : File;
          return (
            <div key={d.id} className="bg-white rounded-xl border border-slate-100 shadow-sm">
              <div className={`aspect-square overflow-hidden rounded-t-xl cursor-pointer active:opacity-80 ${isImage ? 'bg-slate-100' : 'bg-slate-50 flex items-center justify-center'}`} onClick={() => setPreview(d)}>
                {isImage ? <img src={d.fileUrl} alt={d.fileName} className="w-full h-full object-cover" /> : <Icon className="w-10 h-10 text-slate-300" />}
              </div>
              <div className="p-2.5">
                <p className="text-xs font-medium text-slate-900 truncate">{d.fileName}</p>
                <div className="flex items-center justify-end gap-1 mt-1.5">
                  <button onClick={() => handleDownload(d)} className="p-1 rounded hover:bg-slate-100 transition-colors"><Download className="w-3 h-3 text-slate-400" /></button>
                  <button onClick={() => handleDelete(d)} className="p-1 rounded hover:bg-red-50 transition-colors"><Trash2 className="w-3 h-3 text-red-400" /></button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {docs.length === 0 && !uploading && <p className="text-center text-sm text-slate-400 mt-6">Tap the tile or drag files here</p>}
      {preview && (
        <div className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="absolute top-5 right-5"><div className="w-9 h-9 bg-white/10 rounded-full flex items-center justify-center"><X className="w-5 h-5 text-white" /></div></div>
          <div className="absolute top-5 left-5 right-16"><p className="text-white/80 text-sm font-medium truncate">{preview.fileName}</p></div>
          {preview.fileType?.startsWith('image/')
            ? <img src={preview.fileUrl} alt={preview.fileName} className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg shadow-2xl" onClick={e => e.stopPropagation()} />
            : preview.fileType?.includes('pdf')
              ? <div className="w-[92vw] h-[88vh] rounded-lg overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}><iframe src={`${preview.fileUrl}#toolbar=0`} className="w-full h-full border-0 bg-white" title={preview.fileName} /></div>
              : <div className="bg-white rounded-2xl p-8 text-center shadow-2xl max-w-sm" onClick={e => e.stopPropagation()}><File className="w-12 h-12 text-slate-400 mx-auto mb-3" /><p className="font-medium text-slate-900 mb-1">{preview.fileName}</p><button onClick={() => handleDownload(preview)} className="mt-4 px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-medium hover:bg-slate-800 transition-colors">Download</button></div>
          }
        </div>
      )}
    </>
  );
}
