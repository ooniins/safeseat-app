# SafeSeat Infobip Test Build

- Added a temporary **Settings > Alerts & Emergency > Test Emergency SMS** control.
- The test calls the existing authenticated `sendEmergencySms()` client service with driver seat 1 and a test occupant label.
- A confirmation warns that Vercel `TEST_MODE=false` can send a real SMS.
- Results are surfaced with alerts for test mode, no contacts, no phone number, duplicate event, success, and errors.
- Infobip sender is configurable through `INFOBIP_SENDER` and defaults to `ServiceSMS` for free-trial testing.
- Infobip base URL now accepts either a bare host or a URL with `https://`.
- Added `.env.example` containing only the public SMS endpoint example.
- This test control is temporary and should be removed before final release.
- Included a corrected local root `.env` using the Firebase client configuration supplied for this test folder plus the raw Vercel SMS endpoint URL. It contains no Infobip key or Firebase Admin credential.
