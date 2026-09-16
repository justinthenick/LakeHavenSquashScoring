# Court Card — current setup

The GitHub Pages scorer uses Google Apps Script and Supabase for fixtures and results. The Apps Script endpoint is configured in index.html; no club credential is published in this repository.

## Scorer access

Open Settings and enter the private four-character club code (letters or digits, case-sensitive). Leading zeros are supported. Successful sign-in saves a signed device token for 180 days. Five wrong enrollment attempts within 15 minutes pause new-device sign-in for the remainder of that club-wide window. Already-connected devices continue working.

An administrator sets CLUB_ACCESS_CODE in Apps Script Script Properties. Changing the code revokes existing device tokens. Keep all Supabase/Gemini credentials and the automatically generated CLUB_DEVICE_SIGNING_KEY private. A code of at least 16 characters remains supported if stronger access is preferred.

## Saving and recovering results

Choose a fixture to load its scoring rules. The browser autosaves the active match and stores confirmed results locally before sending them. Results remain pending until the backend acknowledges them. Open “View pending results / retry sync” from the setup screen or result summary to retry or download a backup. Clearing browser storage removes local unsynced results.

The backend saves match, game, rally and fixture state transactionally. Corrections and scan overrides require administrator access. Admin calls check the signed-in Google identity; the club code does not grant admin access.

## Deployment

Keep index.html, sw.js, manifest.json and both icons together on GitHub Pages. Reopen/reload installed apps after a release. Backend changes require saving the Apps Script source and deploying a new version while preserving the configured /exec URL.

The September 2026 backend source, SQL migration and regression checks are currently retained in the local Squash for CODEX workspace; they have not yet been added to this repository. The previous setup instructions described the superseded Sheets-only architecture.

Potentially exposed privileged Supabase and Gemini credentials still need rotation through their provider consoles and replacement in Script Properties.
