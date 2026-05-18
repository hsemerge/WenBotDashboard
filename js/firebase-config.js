// ============================================================
// FIREBASE CONFIG - LogicTools / LogicPlay
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyDIFmRUou9_aWJWrQJa8HSoA1MBsndBnqg",
  authDomain: "logictools.firebaseapp.com",
  projectId: "logictools",
  storageBucket: "logictools.firebasestorage.app",
  messagingSenderId: "814616765484",
  appId: "1:814616765484:web:6cf9f657fe612c95c19d89",
  measurementId: "G-PDDC34E377"
};

// Firebase will be initialized after SDK loads (see initFirebase())
let fb = {
  app: null,
  auth: null,
  db: null,
  storage: null,
  currentUser: null,
  streamerProfile: null,
};

function initFirebase() {
  fb.app = firebase.initializeApp(firebaseConfig);
  fb.auth = firebase.auth();
  fb.db = firebase.firestore();
  if (typeof firebase.storage === 'function') fb.storage = firebase.storage();

  // Listen for auth state changes
  fb.auth.onAuthStateChanged(async (user) => {
    fb.currentUser = user;
    if (user) {
      try { await loadStreamerProfile(user.uid); } catch (e) { console.warn("loadStreamerProfile failed:", e); }
      onAuthReady(user);
    } else {
      onAuthNotLoggedIn();
    }
  });
}

// ---- AUTH FUNCTIONS ----
async function signUp(email, password) {
  const cred = await fb.auth.createUserWithEmailAndPassword(email, password);
  // Create default streamer profile
  await fb.db.collection("streamers").doc(cred.user.uid).set({
    email: email,
    plan: "free",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    onboarded: false,
  });
  return cred.user;
}

async function signIn(email, password) {
  const cred = await fb.auth.signInWithEmailAndPassword(email, password);
  return cred.user;
}

async function signOut() {
  await fb.auth.signOut();
  window.location.href = "login.html";
}

async function resetPassword(email) {
  await fb.auth.sendPasswordResetEmail(email);
}

// ---- STREAMER PROFILE ----
async function loadStreamerProfile(uid) {
  const doc = await fb.db.collection("streamers").doc(uid).get();
  if (doc.exists) {
    fb.streamerProfile = { id: uid, ...doc.data() };
  } else {
    fb.streamerProfile = null;
  }
}

async function saveStreamerProfile(data) {
  const uid = fb.currentUser.uid;
  await fb.db.collection("streamers").doc(uid).set(data, { merge: true });
  fb.streamerProfile = { ...fb.streamerProfile, ...data };
}

// ---- PROVIDER CONFIG (Gambulls, CSBattle, etc.) ----
async function saveProviderConfig(providerName, config) {
  const uid = fb.currentUser.uid;
  await fb.db.collection("streamers").doc(uid)
    .collection("providers").doc(providerName).set(config, { merge: true });
}

async function getProviderConfig(providerName) {
  const uid = fb.currentUser.uid;
  const doc = await fb.db.collection("streamers").doc(uid)
    .collection("providers").doc(providerName).get();
  return doc.exists ? doc.data() : null;
}

// ---- VERIFIED USERS (Firestore) ----
async function saveVerifiedUser(kickName, data) {
  const uid = fb.currentUser.uid;
  const key = kickName.toLowerCase();
  await fb.db.collection("streamers").doc(uid)
    .collection("verified_users").doc(key).set(data);
}

async function removeVerifiedUser(kickName) {
  const uid = fb.currentUser.uid;
  const key = kickName.toLowerCase();
  await fb.db.collection("streamers").doc(uid)
    .collection("verified_users").doc(key).delete();
}

async function loadAllVerifiedUsers() {
  const uid = fb.currentUser.uid;
  const snapshot = await fb.db.collection("streamers").doc(uid)
    .collection("verified_users").get();
  const users = {};
  snapshot.forEach(doc => {
    users[doc.id] = doc.data();
  });
  return users;
}

async function clearAllVerifiedUsers() {
  const uid = fb.currentUser.uid;
  const snapshot = await fb.db.collection("streamers").doc(uid)
    .collection("verified_users").get();
  const batch = fb.db.batch();
  snapshot.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

// ---- KICK CONNECTION (Firestore) ----
// Note: writing Kick OAuth tokens from the client is blocked by Firestore rules.
// The Kick OAuth callback now finalizes server-side via /api/kick-streamer-finalize.
// loadKickConnection() below is still used to read the saved connection.

async function loadKickConnection() {
  const uid = fb.currentUser.uid;
  const doc = await fb.db.collection("streamers").doc(uid).get();
  if (!doc.exists) return null;
  const d = doc.data();
  return d.kickUserId ? {
    kickUserId:         d.kickUserId,
    kickUsername:       d.kickUsername,
    kickEmail:          d.kickEmail,
    kickAvatar:         d.kickAvatar,
    kickAccessToken:    d.kickAccessToken,
    kickRefreshToken:   d.kickRefreshToken,
    kickTokenExpiresAt: d.kickTokenExpiresAt,
  } : null;
}

// ---- WINNERS (Firestore) ----
async function saveWinner(giveawayId, winnerData) {
  const uid = fb.currentUser.uid;
  await fb.db.collection("streamers").doc(uid)
    .collection("winners").add({
      ...winnerData,
      giveawayId: giveawayId,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
}
