// POST /api/slot-request-add
// Called by WenBotServer when a viewer types !sr <slot name>
// Body: { channel, kickUsername, slotName, kickUserId? }
// Returns: { success, message } — message is echoed to chat by WenBotServer

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

function res(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://wenbot.gg",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return res(400, { error: "Invalid JSON" });
  }

  const { channel, kickUsername, slotName, kickUserId } = body;
  if (!channel || !kickUsername || !slotName) {
    return res(400, { error: "Missing channel, kickUsername, or slotName" });
  }

  const channelKey = channel.toLowerCase().trim();
  const userKey    = kickUsername.toLowerCase().trim();
  const slot       = String(slotName).trim().slice(0, 100);

  try {
    const db = getDb();

    const streamerSnap = await db.collection("streamers")
      .where("kickChannel", "==", channelKey).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });

    const uid        = streamerSnap.docs[0].id;
    const streamerData = streamerSnap.docs[0].data();

    // Load sr settings
    const settingsDoc = await db.collection("streamers").doc(uid)
      .collection("sr_settings").doc("config").get();
    const settings = settingsDoc.exists ? settingsDoc.data() : {};
    const enabled       = settings.enabled !== false;
    const eligibility   = settings.eligibility  || "everyone";
    const cooldownMins  = settings.cooldownMins  ?? 5;
    const allowMultiple = !!settings.allowMultiple;

    if (!enabled) {
      return res(200, { success: false, message: `@${kickUsername} Slot requests are currently closed.` });
    }

    // Eligibility check
    if (eligibility === "verified") {
      const vSnap = await db.collection("streamers").doc(uid)
        .collection("verified_users").where("kickName", "==", userKey).limit(1).get();
      if (vSnap.empty) {
        return res(200, { success: false, message: `@${kickUsername} You need to be a verified user to request slots. Ask the streamer how to get verified.` });
      }
    } else if (eligibility === "code") {
      const vSnap = await db.collection("streamers").doc(uid)
        .collection("verified_users").where("kickName", "==", userKey).limit(1).get();
      if (vSnap.empty || !vSnap.docs[0].data().affiliateVerified) {
        return res(200, { success: false, message: `@${kickUsername} You need to be registered under the streamer's affiliate code to request slots.` });
      }
    }

    // Cooldown check
    if (cooldownMins > 0) {
      const cdDoc = await db.collection("streamers").doc(uid)
        .collection("sr_cooldowns").doc(userKey).get();
      if (cdDoc.exists) {
        const lastAt = cdDoc.data().lastRequestAt || 0;
        const elapsed = (Date.now() - lastAt) / 60000;
        if (elapsed < cooldownMins) {
          const remaining = Math.ceil(cooldownMins - elapsed);
          return res(200, { success: false, message: `@${kickUsername} You can request again in ${remaining} minute${remaining !== 1 ? "s" : ""}.` });
        }
      }
    }

    // Check for duplicate pending request from same user (skip if allowMultiple is on)
    if (!allowMultiple) {
      const dupSnap = await db.collection("streamers").doc(uid)
        .collection("slot_requests")
        .where("kickUsernameKey", "==", userKey)
        .where("status", "==", "pending")
        .limit(1).get();
      if (!dupSnap.empty) {
        return res(200, { success: false, message: `@${kickUsername} You already have a slot in the queue. Wait for it to be played first.` });
      }
    }

    // Add request
    const now = Date.now();
    await db.collection("streamers").doc(uid)
      .collection("slot_requests").add({
        kickUsername,
        kickUsernameKey: userKey,
        kickUserId:      kickUserId || null,
        slotName:        slot,
        status:          "pending",
        requestedAt:     now,
      });

    // Update cooldown
    await db.collection("streamers").doc(uid)
      .collection("sr_cooldowns").doc(userKey).set({ lastRequestAt: now });

    return res(200, { success: true, message: `@${kickUsername} Your slot request for "${slot}" has been added to the queue!` });
  } catch (err) {
    return res(500, { error: err.message });
  }
};
