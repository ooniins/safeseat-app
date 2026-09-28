# SafeSeat Infobip Destination Fix

- Fixed the Infobip `/sms/2/text/advanced` request payload.
- Replaced invalid message-level `to` with `destinations: [{ to: ... }]`.
- Added phone normalization before sending:
  - `09XXXXXXXXX` -> `639XXXXXXXXX`
  - `9XXXXXXXXX` -> `639XXXXXXXXX`
  - `+639XXXXXXXXX` -> `639XXXXXXXXX`
  - already-international digit-only numbers remain supported.
- Invalid destination numbers now fail locally with a clear message before calling Infobip.
- Preserved the Infobip trial sender fallback `ServiceSMS`.
- Restored the provided Expo `.env` values with corrected plain URL/App ID formatting.

Testing note: Infobip trial delivery still requires the destination number to be verified in the Infobip portal.
