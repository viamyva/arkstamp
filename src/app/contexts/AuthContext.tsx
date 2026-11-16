import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  getRedirectResult,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { auth } from '../../lib/firebase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isDDG: boolean;
  ghostEmail: string | null;
  isGhostMode: boolean;
  startGhost: (uid: string, email: string) => void;
  exitGhost: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/calendar.events');
googleProvider.addScope('https://www.googleapis.com/auth/calendar');

// Detect DuckDuckGo browser — it blocks popups, so we use redirect instead
const isDDG = /DuckDuckGo/i.test(navigator.userAgent);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [ghostTarget, setGhostTarget] = useState<{ uid: string; email: string } | null>(null);

  // When ghosting, swap user.uid transparently — all existing components
  // use user.uid for Firestore paths and will read/write the target's data.
  const effectiveUser = ghostTarget && user
    ? ({ ...user, uid: ghostTarget.uid } as User)
    : user;

  const startGhost = (uid: string, email: string) => setGhostTarget({ uid, email });
  const exitGhost = () => setGhostTarget(null);

  useEffect(() => {
    // Handle redirect result when returning from Google sign-in on DDG.
    // onAuthStateChanged will fire with the user automatically; we call
    // getRedirectResult here only to surface any errors from that flow.
    getRedirectResult(auth).catch((err) => {
      console.error('Redirect sign-in error:', err);
    });

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUp = async (email: string, password: string, name: string) => {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    if (name) await updateProfile(user, { displayName: name });
  };

  const signInWithGoogle = async () => {
    await signInWithPopup(auth, googleProvider);
  };

  const resetPassword = async (email: string) => {
    await sendPasswordResetEmail(auth, email);
  };

  const signOut = async () => {
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{
      user: effectiveUser, loading, isDDG,
      ghostEmail: ghostTarget?.email ?? null,
      isGhostMode: ghostTarget !== null,
      startGhost, exitGhost,
      signIn, signUp, signInWithGoogle, resetPassword, signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
