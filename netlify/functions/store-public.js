// Public store API — returns store items for a channel (no auth required)
// GET /api/store-public?channel=channelname

const { getDb } = require("./_lib/firebase");

// Local res() — supports optional `extra` headers param used by callers
function res(statusCode, body, extra = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing channel parameter" });

  try {
    const db = getDb();

    // Find streamer by kickChannel
    const streamersSnap = await db.collection("streamers")
      .where("kickChannel", "==", channel).limit(1).get();

    if (streamersSnap.empty) return res(404, { error: "Channel not found" });

    const streamerDoc  = streamersSnap.docs[0];
    const streamerUid  = streamerDoc.id;
    const streamerData = streamerDoc.data();

    // Get enabled store items
    const itemsSnap = await db.collection("streamers").doc(streamerUid)
      .collection("store_items").where("enabled", "==", true).get();

    const items = itemsSnap.docs.map(doc => {
      const d = doc.data();
      return {
        id:           doc.id,
        name:         d.name || "",
        description:  d.description || "",
        price:        d.price || 0,
        imageUrl:     d.imageUrl || null,
        stock:        d.stock ?? null,
        category:     d.category || "",
        isRaffleItem: d.isRaffleItem === true,
      };
    }).sort((a, b) => a.price - b.price);

    return res(200, {
      streamer: {
        channel:      streamerData.kickChannel,
        displayName:  streamerData.displayName || streamerData.kickChannel,
        currencyName: streamerData.currencyName || "points",
      },
      items,
    });
  } catch (err) {
    console.error("[store-public] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
