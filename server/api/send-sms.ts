import type { VercelRequest, VercelResponse } from "@vercel/node";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Firebase Admin initialization (runs once per cold start)
// ---------------------------------------------------------------------------
function initFirebaseAdmin() {
  if (getApps().length > 0) return;

  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountRaw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is missing");
  }

  const serviceAccount = JSON.parse(serviceAccountRaw);
  initializeApp({ credential: cert(serviceAccount) });
}

// ---------------------------------------------------------------------------
// Duplicate-event protection (in-memory, survives across invocations on warm)
// ---------------------------------------------------------------------------
const recentEvents = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isDuplicateEvent(eventId: string): boolean {
  const now = Date.now();

  for (const [key, timestamp] of recentEvents) {
    if (now - timestamp > DEDUP_WINDOW_MS) recentEvents.delete(key);
  }

  if (recentEvents.has(eventId)) return true;
  recentEvents.set(eventId, now);
  return false;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://safeseat-app.vercel.app",
  "http://localhost:8081", // Expo dev
  "http://localhost:19006", // Expo web
];

function setCorsHeaders(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ---------------------------------------------------------------------------
// SMS message template
// ---------------------------------------------------------------------------
function buildSmsBody(
  userName: string,
  seatLabel: string,
  timestamp: string,
): string {
  return (
    `SafeSeat EMERGENCY ALERT\n\n` +
    `${userName} in the ${seatLabel} may need immediate help.\n\n` +
    `Time: ${timestamp}\n\n` +
    `This is an automated alert from SafeSeat. Please check on them immediately. ` +
    `If this is a medical emergency, call 911.`
  );
}

// ---------------------------------------------------------------------------
// Infobip SMS sending (REST API)
// ---------------------------------------------------------------------------
async function sendInfobipSms(
  to: string,
  text: string,
): Promise<{ messageId: string }> {
  const apiKey = process.env.INFOBIP_API_KEY;
  const baseUrl = process.env.INFOBIP_API_BASE_URL ?? "api.infobip.com";

  if (!apiKey) {
    throw new Error("INFOBIP_API_KEY environment variable is missing");
  }

  const response = await fetch(`https://${baseUrl}/sms/2/text/advanced`, {
    method: "POST",
    headers: {
      Authorization: `App ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          from: "SafeSeat",
          to,
          text,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown");
    throw new Error(`Infobip API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();

  // Extract the message ID from Infobip response
  const messageId: string =
    data?.messages?.[0]?.messageId ?? "unknown";

  return { messageId };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const testMode = process.env.TEST_MODE === "true";

  try {
    initFirebaseAdmin();

    // ---- 1. Verify authentication ----
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid authorization header" });
      return;
    }

    const idToken = authHeader.slice(7);
    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ error: "Invalid or expired auth token" });
      return;
    }

    const uid = decodedToken.uid;

    // ---- 2. Validate request body ----
    const { seatNumber, seatLabel, occupantName, eventId, timestamp } =
      req.body as {
        seatNumber?: number;
        seatLabel?: string;
        occupantName?: string;
        eventId?: string;
        timestamp?: string;
      };

    if (seatNumber !== 1) {
      res
        .status(400)
        .json({ error: "SMS escalation is only available for the driver seat" });
      return;
    }

    if (!eventId || !timestamp) {
      res.status(400).json({ error: "Missing required fields: eventId, timestamp" });
      return;
    }

    // ---- 3. Duplicate-event protection ----
    if (isDuplicateEvent(eventId)) {
      res.status(200).json({ ok: true, skipped: "duplicate_event" });
      return;
    }

    // ---- 4. Look up primary emergency contact ----
    const db = getFirestore();
    const contactsSnap = await db
      .collection("users")
      .doc(uid)
      .collection("emergencyContacts")
      .orderBy("hierarchy", "asc")
      .limit(5)
      .get();

    if (contactsSnap.empty) {
      res.status(200).json({ ok: true, skipped: "no_contacts" });
      return;
    }

    const primaryContact = contactsSnap.docs.find((contactDoc) => {
      const data = contactDoc.data();
      return typeof data.hierarchy === "number" && data.hierarchy > 0 && data.phone;
    });

    if (!primaryContact) {
      res.status(200).json({ ok: true, skipped: "no_phone_number" });
      return;
    }

    const contactData = primaryContact.data();
    const contactPhone = contactData.phone as string;
    const contactName = contactData.name as string;

    const displayName = occupantName || "The driver";
    const displaySeat = seatLabel || "driver seat";
    const smsBody = buildSmsBody(displayName, displaySeat, timestamp);

    // ---- 5. TEST MODE: log but don't send ----
    if (testMode) {
      console.log("========== TEST MODE — SMS NOT SENT ==========");
      console.log(`Would send to: ${contactName}`);
      console.log(`Message:\n${smsBody}`);
      console.log(`Event ID: ${eventId}`);
      console.log(`User UID: ${uid}`);
      console.log("===============================================");

      res.status(200).json({
        ok: true,
        testMode: true,
        skipped: "test_mode",
        wouldSendTo: contactName,
        messagePreview: smsBody,
      });
      return;
    }

    // ---- 5b. LIVE MODE: send SMS via Infobip ----
    const result = await sendInfobipSms(contactPhone, smsBody);

    console.log(`SMS sent to ${contactName} for user ${uid}: ${result.messageId}`);

    // ---- 6. Log the sent SMS in Firestore for audit trail (no phone number) ----
    try {
      await db.collection("smsLog").add({
        uid,
        eventId,
        seatNumber,
        occupantName: displayName,
        contactName,
        infobipMessageId: result.messageId,
        timestamp: new Date().toISOString(),
      });
    } catch (logError) {
      console.warn("Failed to log SMS to Firestore:", logError);
    }

    res.status(200).json({
      ok: true,
      messageId: result.messageId,
      sentTo: contactName,
    });
  } catch (error) {
    console.error("SMS escalation error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ error: message });
  }
}
