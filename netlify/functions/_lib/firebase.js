// Shared Firebase Admin SDK initializer for Netlify functions.
// Uses lazy init via `if (!admin.apps.length)` so calling getDb() multiple times
// (across functions or repeated invocations of the same warm Lambda) is safe.
// Env vars are read at call time, not module-load time — matches the prior
// per-function pattern that's been battle-tested.

const admin = require("firebase-admin");

// Two accepted shapes for the credential.
//
// The three FIREBASE_* vars are what deploys use. FIREBASE_SERVICE_ACCOUNT_JSON
// carries the whole service-account object in one value, and exists because
// FIREBASE_PRIVATE_KEY is stored as a Netlify *secret*: secrets are blanked in
// local runs and the CLI cannot reveal them, so `netlify dev` otherwise reaches
// Firestore with an empty key and every function 500s on the same confusing
// "Service account object must contain a string private_key property".
//
// The individual vars win whenever they carry a key, so deploys are untouched.
function serviceAccount() {
  const key = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (key) {
    return {
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  key,
    };
  }

  // Base64 form. Netlify appears to blank env values that contain PEM key
  // material, so the plain JSON below arrives empty in local runs even though
  // the CLI reports injecting it. Encoded, it survives.
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '';
  const blob = b64
    ? Buffer.from(b64, 'base64').toString('utf8')
    : (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '');
  if (blob) {
    const j = JSON.parse(blob);
    return {
      projectId:   j.project_id   || process.env.FIREBASE_PROJECT_ID,
      clientEmail: j.client_email || process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  String(j.private_key || '').replace(/\\n/g, '\n'),
    };
  }

  // Nothing usable: hand it over as-is and let the SDK raise its own error
  // rather than inventing a different one here.
  return {
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  '',
  };
}

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount()) });
  }
  return admin.firestore();
}

module.exports = { getDb, admin };
