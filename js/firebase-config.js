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

// Firebase will be initialized after SDK loads (see initFirebase()).
//
// Two UIDs matter:
//   - fb.currentUser.uid : the *auth* user (who's actually logged in).
//   - fb.activeUid       : the *streamer* whose data the dashboard is
//                          operating on. Defaults to the auth user's own UID,
//                          but for moderators (Firebase users with a
//                          `delegatedFor` custom claim) this can be set to a
//                          delegated streamer's UID. ALL Firestore queries
//                          that target streamer data should use fb.activeUid.
let fb = {
  app: null,
  auth: null,
  db: null,
  storage: null,
  currentUser: null,
  streamerProfile: null,
  activeUid: null,
  delegatedFor: [],   // populated from the auth user's custom claim
  isModerating: false, // true when fb.activeUid !== fb.currentUser.uid
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
      // Pull delegatedFor off the JWT — drives the streamer picker / mod pill
      try {
        const tok = await user.getIdTokenResult();
        fb.delegatedFor = Array.isArray(tok.claims?.delegatedFor) ? tok.claims.delegatedFor : [];
      } catch { fb.delegatedFor = []; }

      // Default active streamer = the auth user themselves. If a moderator
      // has previously chosen a delegated streamer via the picker, restore
      // that selection (validated against the current delegatedFor list).
      let chosen = null;
      try {
        const stored = localStorage.getItem('wb_active_uid');
        if (stored && stored !== user.uid && fb.delegatedFor.includes(stored)) {
          chosen = stored;
        }
      } catch {}
      fb.activeUid    = chosen || user.uid;
      fb.isModerating = fb.activeUid !== user.uid;

      try { await loadStreamerProfile(fb.activeUid); } catch (e) { console.warn("loadStreamerProfile failed:", e); }

      // Edge case: user has delegations but their own streamer profile isn't
      // onboarded (they signed up just to be a mod, never set up a channel).
      // Don't bounce them to setup.html — drop them into the first delegated
      // streamer's dashboard instead.
      if (fb.activeUid === user.uid
          && (!fb.streamerProfile || !fb.streamerProfile.onboarded)
          && fb.delegatedFor.length > 0) {
        fb.activeUid    = fb.delegatedFor[0];
        fb.isModerating = true;
        try { localStorage.setItem('wb_active_uid', fb.activeUid); } catch {}
        try { await loadStreamerProfile(fb.activeUid); } catch (e) { console.warn("loadStreamerProfile (delegated) failed:", e); }
      }

      onAuthReady(user);
    } else {
      fb.activeUid    = null;
      fb.delegatedFor = [];
      fb.isModerating = false;
      onAuthNotLoggedIn();
    }
  });
}

// Switch the dashboard to operate on a different streamer (only valid for
// streamer UIDs in the moderator's delegatedFor list). Persists the choice
// so a reload keeps the same context.
async function setActiveStreamer(uid) {
  if (!fb.currentUser) return;
  if (uid !== fb.currentUser.uid && !fb.delegatedFor.includes(uid)) {
    throw new Error("You don't have moderator access to that streamer.");
  }
  fb.activeUid    = uid;
  fb.isModerating = uid !== fb.currentUser.uid;
  try { localStorage.setItem('wb_active_uid', uid); } catch {}
  await loadStreamerProfile(uid);
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
  const uid = fb.activeUid;
  await fb.db.collection("streamers").doc(uid).set(data, { merge: true });
  fb.streamerProfile = { ...fb.streamerProfile, ...data };
}

// ---- PROVIDER CONFIG (Gambulls, CSBattle, etc.) ----
async function saveProviderConfig(providerName, config) {
  const uid = fb.activeUid;
  await fb.db.collection("streamers").doc(uid)
    .collection("providers").doc(providerName).set(config, { merge: true });
}

async function getProviderConfig(providerName) {
  const uid = fb.activeUid;
  const doc = await fb.db.collection("streamers").doc(uid)
    .collection("providers").doc(providerName).get();
  return doc.exists ? doc.data() : null;
}

// ---- VERIFIED USERS (Firestore) ----
async function saveVerifiedUser(kickName, data) {
  const uid = fb.activeUid;
  const key = kickName.toLowerCase();
  await fb.db.collection("streamers").doc(uid)
    .collection("verified_users").doc(key).set(data);
}

async function removeVerifiedUser(kickName) {
  const uid = fb.activeUid;
  const key = kickName.toLowerCase();
  await fb.db.collection("streamers").doc(uid)
    .collection("verified_users").doc(key).delete();
}

async function loadAllVerifiedUsers() {
  const uid = fb.activeUid;
  const snapshot = await fb.db.collection("streamers").doc(uid)
    .collection("verified_users").get();
  const users = {};
  snapshot.forEach(doc => {
    users[doc.id] = doc.data();
  });
  return users;
}

async function clearAllVerifiedUsers() {
  const uid = fb.activeUid;
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
  const uid = fb.activeUid;
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
  const uid = fb.activeUid;
  await fb.db.collection("streamers").doc(uid)
    .collection("winners").add({
      ...winnerData,
      giveawayId: giveawayId,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
}
