// Imports only the Firebase services used by the landing, chair, and
// delegate pages.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// Connects this website to the Firebase project created for Logn MUN.
const firebaseConfig = {
  apiKey: "AIzaSyBeBMQoRCpgCZ0DNlfDv4gA2QEbq3GcW6s",
  authDomain: "lognmunwebsite.firebaseapp.com",
  projectId: "lognmunwebsite",
  storageBucket: "lognmunwebsite.firebasestorage.app",
  messagingSenderId: "435294680868",
  appId: "1:435294680868:web:d31239a6279604a75625b1",
  measurementId: "G-4KTL9YZ5VK",
};

const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);

// The one Google account allowed to sign in as chair. chair.js checks
// every signed-in visitor against this before showing any chair
// controls -- Google sign-in verifies the email address itself, so this
// can't be spoofed by signing in with a different account.
export const ALLOWED_CHAIR_EMAIL = "sjsjsjrl05@gmail.com";

// One shared Google sign-in provider instance for the "Sign in as
// Chair" button on the landing page.
const googleProvider = new GoogleAuthProvider();

// Creates a private anonymous identity when a visitor first submits
// content as a delegate. Never used for the chair -- the chair always
// signs in with the real Google account below instead.
export async function ensureAnonymousUser() {
  if (auth.currentUser) {
    return auth.currentUser;
  }

  const credential = await signInAnonymously(auth);
  return credential.user;
}

// Opens the Google sign-in popup for the "Sign in as Chair" button.
// Throws if the visitor closes the popup or sign-in otherwise fails --
// the caller is responsible for showing an error message.
export async function signInWithGoogle() {
  const credential = await signInWithPopup(auth, googleProvider);
  return credential.user;
}

// True only for the one Google account allowed to act as chair. Checked
// on both the landing page (to decide where to send the visitor after
// signing in) and chair.html itself (in case someone opens that page
// directly while signed in as a different account, or not signed in
// with Google at all).
export function isChairEmail(user) {
  return Boolean(user) && user.email === ALLOWED_CHAIR_EMAIL;
}

// Shares the small set of Firestore and Auth helpers needed by the
// landing, chair, and delegate page scripts.
export {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onAuthStateChanged,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  signOut,
};
