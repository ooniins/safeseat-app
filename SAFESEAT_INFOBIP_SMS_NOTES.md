# SafeSeat Infobip SMS Integration

## Architecture

```
SafeSeat App (Expo)
       │
  Firebase login (ID token)
       │
       ▼
  Vercel API (/api/send-sms)
       │
  ┌────┴────┐
  ▼         ▼
Firebase   Infobip
Firestore  SMS
```

**Security:** App never holds Twilio/Infobip or Firebase Admin secrets. Only Vercel env vars.

## What Was Built

### Server (`server/`)
- `server/api/send-sms.ts` — Vercel serverless function:
  - Firebase Admin auth verification (Bearer token)
  - Firestore lookup of primary emergency contact (hierarchy 1-5)
  - Infobip SMS via REST API (`POST /sms/2/text/advanced`)
  - Duplicate-event protection (5-min in-memory window)
  - `TEST_MODE=true` → logs without sending SMS
  - Phone numbers excluded from Firestore audit logs (`smsLog` collection)
- `server/package.json` — deps: firebase-admin only (Infobip via native fetch)
- `server/vercel.json` — function config, maxDuration 10s
- `server/tsconfig.json` — standalone (root tsconfig depends on Expo, not available on Vercel)
- `server/.env.example` — template with REDACTED values

### App (`src/`)
- `src/services/sms-escalation.ts` — calls Vercel endpoint with Firebase ID token
- `src/components/emergency-modal.tsx` — SMS fires once when countdown elapses, ONLY if:
  - Driver seat (seat === 1)
  - `emergencyEscalation` enabled in user preferences
  - `isRealEmergency` prop is true
- `src/app/(tabs)/home/index.tsx` — passes `isRealEmergency={rawSeatState === "emergency" && !simulationActive}`

### Safety Guards
- UAT simulations CANNOT trigger SMS (`simulationActive` blocks it)
- Warning states CANNOT trigger SMS (only emergency)
- Server rejects seat !== 1
- Duplicate event IDs blocked for 5 minutes
- `TEST_MODE=true` on Vercel = no real SMS sent
- Secrets only in Vercel env vars, never in code
- `smsSentRef` prevents duplicate sends per modal session
- Ref resets when modal closes or seat changes

## SMS Trigger Flow
1. Real Main Hub fusion state = EMERGENCY
2. Emergency modal shows with 20/25/30s countdown (user preference `escalationWindowSeconds`)
3. Countdown hits 0 → `windowElapsed = true`
4. `sendEmergencySms()` called once
5. Backend verifies auth → looks up primary contact → sends via Infobip (or logs in TEST_MODE)

## Vercel Setup
- Project: `safeseat-app` under `gabrielcasanovaq-98800s-projects` team
- Root Directory: `server`
- Branch: `safeseat-live-app-final`
- GitHub: forked to `ooniins/safeseat-app` (original is `ollymt/safeseat-app`)
- Default branch changed to `safeseat-live-app-final`
- "Include files outside root directory" should be DISABLED (causes Expo tsconfig error)

### Environment Variables (Vercel)
- `TEST_MODE` = `true` (change to `false` only after hardware testing)
- `INFOBIP_API_BASE_URL` = `api.infobip.com`
- `INFOBIP_API_KEY` = (Infobip API key, human-only)
- `FIREBASE_SERVICE_ACCOUNT` = (service account JSON, human-only)

### App Environment (root `.env`)
- `EXPO_PUBLIC_SMS_API_URL` = `https://safeseat-app.vercel.app/api/send-sms` (or actual domain)

## Infobip Account
- Sender number: +44 7491 163443 (UK virtual long number, SMS, free trial 60 days)
- API key scope: `sms:message:send` only (least privilege)
- No restrictions/notifications on account

## Firebase Admin
- Service account JSON downloaded from Firebase Console → Settings → Service Accounts
- Human-only, never committed

## Rules (from groupmate)
1. DO NOT give AI secrets (Twilio/Infobip API keys, Firebase private keys)
2. DO NOT auto-deploy — human reviews and deploys manually
3. Use TEST_MODE=true for development
4. Emergency contacts are personal data (Philippine Data Privacy Act) — don't expose in logs
5. Workflow: AI writes code → git diff → human inspects → test locally → test trial → human deploys

## Testing Status
- Backend deployed and responding (`{"error":"Method not allowed"}` on GET = working)
- NOT yet tested with real Main Hub hardware
- NOT yet tested end-to-end SMS delivery
- Typecheck passes (only pre-existing `app-tabs.web.tsx` error unrelated to SMS)

## Key Files
- Emergency detection: `src/services/safeseat-hub.ts`, `src/hooks/safeseat-hub-context.tsx`
- Emergency modal: `src/components/emergency-modal.tsx`
- Home screen: `src/app/(tabs)/home/index.tsx`
- User preferences (escalation settings): `src/hooks/user-preferences-context.tsx`
- Firebase client: `src/firebase.ts`
