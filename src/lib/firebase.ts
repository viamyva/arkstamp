import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: "AIzaSyDi3V6-hyYNLTdGBcWMaZb7uE_Chths7rs",
  authDomain: "keepstamp-prod.firebaseapp.com",
  projectId: "keepstamp-prod",
  storageBucket: "keepstamp-prod.firebasestorage.app",
  messagingSenderId: "534822744743",
  appId: "1:534822744743:web:beb5b520d7f13ad5c76182",
  measurementId: "G-51QVQXJ72P"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);
