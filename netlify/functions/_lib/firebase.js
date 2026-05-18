// Shared Firebase Admin SDK initializer for Netlify functions.
// Uses lazy init via `if (!admin.apps.length)` so calling getDb() multiple times
// (across functions or repeated invocations of the same warm Lambda) is safe.
// Env vars are read at call time, not module-load time — matches the prior
// per-function pattern that's been battle-tested.

const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

module.exports = { getDb, admin };
