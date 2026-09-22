import { auth } from "../firebase";

const SMS_API_URL = process.env.EXPO_PUBLIC_SMS_API_URL ?? "";

const SEAT_LABELS: Record<number, string> = {
  1: "driver seat",
  2: "front passenger seat",
  3: "rear left seat",
  4: "rear center seat",
  5: "rear right seat",
};

export type SmsEscalationResult =
  | { ok: true; messageId?: string; sentTo?: string; skipped?: string }
  | { ok: false; error: string };

/**
 * Send an emergency SMS via the SafeSeat backend.
 *
 * Safety guards (call these BEFORE invoking this function):
 * - seatNumber MUST be 1 (driver seat only)
 * - The emergency MUST come from a real Main Hub fusion state, NOT a UAT simulation
 * - The user MUST have `emergencyEscalation` enabled in preferences
 * - The 20/25/30-second countdown MUST have elapsed
 */
export async function sendEmergencySms(params: {
  seatNumber: number;
  occupantName: string;
}): Promise<SmsEscalationResult> {
  if (!SMS_API_URL) {
    console.warn("SafeSeat SMS API URL is not configured");
    return { ok: false, error: "SMS API URL not configured" };
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    return { ok: false, error: "No authenticated user" };
  }

  try {
    const idToken = await currentUser.getIdToken();

    const eventId = `sms-${params.seatNumber}-${Date.now()}`;

    const response = await fetch(SMS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        seatNumber: params.seatNumber,
        seatLabel: SEAT_LABELS[params.seatNumber] ?? `seat ${params.seatNumber}`,
        occupantName: params.occupantName,
        eventId,
        timestamp: new Date().toISOString(),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.warn("SafeSeat SMS API error:", data);
      return { ok: false, error: data.error ?? "SMS API request failed" };
    }

    return {
      ok: true,
      messageId: data.messageId,
      sentTo: data.sentTo,
      skipped: data.skipped,
    };
  } catch (error) {
    console.error("SafeSeat SMS escalation failed:", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}
