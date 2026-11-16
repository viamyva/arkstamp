import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AuthForm } from './components/AuthForm';
import { ArkLibrary } from './components/ArkLibrary';

// Read ?shared=1&owner=UID&deck=ID from the URL once at startup
function getPendingShare(): { ownerUid: string; chapterId: string } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const ownerUid  = params.get('owner');
    const chapterId = params.get('deck');
    if (params.get('shared') === '1' && ownerUid && chapterId) {
      return { ownerUid, chapterId };
    }
  } catch {}
  return null;
}

const pendingShare = getPendingShare();

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="size-full flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-slate-900 mb-4"></div>
          <p className="text-slate-600">Loading ARKstamp...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthForm pendingShare={pendingShare} />;
  }

  return <ArkLibrary pendingShare={pendingShare} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}