# Court Card setup

Court Card is a GitHub Pages scorer backed by Google Apps Script and Supabase. Sheets remain available for administrative draw and roster workflows; match, game and rally results are stored in Supabase.

## Files and tests

- `index.html`, `sw.js`, `manifest.json`, and the two icons form the installable scorer.
- `app-script/` contains the current backend and admin source. Copy these files into the existing Apps Script project. Keep historical onboarding/backfill scripts private; their functions must end in `_`.
- `database/result_integrity.sql` installs the transactional result and player routines, result archive and indexes on the existing schema. It is not an empty-database bootstrap.
- Apply `database/roster_integrity.sql` after it to add persistent substitute-pool storage and atomic roster/fixture saves. `database/test_roster.sql` checks moving players into/out of the pool and rollback after a late failure, as the service role; all test changes roll back.
- `database/test_results.sql` exercises saving, retries, replacement, rollback, removal and role privileges inside a transaction that ends with `ROLLBACK`. Run the complete file together, preferably on a staging clone.
- `npm ci && npm test` runs the JavaScript regression checks. GitHub Actions runs these checks on pushes and pull requests.

## Access

In Apps Script **Project Settings → Script properties**, retain the existing `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `MASTER_ID`, `DRAW_ID`, and scan/Gemini settings. Add `CLUB_ACCESS_CODE` with a private value of exactly four letters or digits (case-sensitive). Leading zeros are preserved. A longer code of at least 16 characters is also supported. Never put this value, the service key or Gemini key into this repository.

Each scorer enters the club code using **Settings** once on their device. Successful enrollment stores a signed device token, not the short code, in browser local storage. Tokens last 180 days. Treat the code as a shared credential: anyone given it can read scorer fixtures/player names and submit results. It does not grant admin access. Rotate the property and inform scorers if a device or the code is compromised; this invalidates all existing tokens. The legacy published `SECRET` value is no longer accepted.

Five incorrect enrollment attempts within 15 minutes pause new-device sign-in for the remainder of that window. This limit is club-wide because Apps Script does not expose a trusted client IP. Already-connected devices continue working. An attacker can temporarily block new enrollment, and a four-character code is still weaker than a long random code. `CLUB_LOGIN_ATTEMPTS` stores the failure window; the backend creates `CLUB_DEVICE_SIGNING_KEY` automatically. Keep that key private. Removing it revokes all devices; an administrator can clear `CLUB_LOGIN_ATTEMPTS` after investigating a lockout.

Administrator entry points check the signed-in Google identity on every call. `ADMIN_EMAILS` may hold a comma-separated allowlist; without it, the existing project owner and editor are the only permitted identities. All other server helpers end in `_`, preventing invocation through `google.script.run`.

The scorer deployment runs as the owner and permits anonymous HTTP access, with the private code validated by the backend. A plain anonymous request cannot open admin. The owner can access admin while signed in. For another authorized administrator, use a separate web-app deployment executing as **User accessing the web app**, requiring Google sign-in, with underlying spreadsheet/database script permissions as needed; do not weaken the server allowlist. Google may require the user to authorize the existing script scopes.

## Release order

1. Back up the existing database and script source.
2. Apply the SQL migration to the existing Supabase schema. Keep RLS enabled and ordinary API roles denied; only `service_role` can call the new write routines.
3. Save all Apps Script source, configure the private code, and update the existing deployment to a new version, preserving its `/exec` URL. Review active deployments so an old public version is not left active.
4. Publish the frontend to GitHub Pages. Set only `APPS_SCRIPT_URL` in source; leave `SHARED_SECRET` blank.
5. Verify anonymous admin denial, rejected missing/invalid scorer codes, authorized fixture reads, and pending-result controls. Existing installed apps may need to be reopened/reloaded to receive the new service worker.

## Result durability

The browser autosaves the active match. At confirmation it first persists the full result under its match ID, then sends it. Results stay queued until acknowledged. A rejected result remains visible with its error; it does not block other queued results. Open **View pending results / retry sync** from setup or the result summary to retry or download a backup. Clearing browser storage removes local matches and unsynced results, so export pending results first.

The database saves a match, its games, its rallies and its played flag in one transaction. A fixture has at most one result. Repeating the same immutable result is safe; conflicting changes are rejected. Scan replacement/removal archives the old rows and deletes dependent rallies before games. Scan overrides of app results require explicit admin selection. Dates use the fixture's authoritative instant and Sydney calendar interpretation. Scoring rules come from the selected competition.

## Credential incident follow-up

The previous public admin code exposed callable property helpers. There is no evidence here that credentials were retrieved, but the Supabase privileged key and Gemini key should be rotated through their provider consoles and replaced in Script Properties. Do not record their values in commits, logs or issue reports. Keep the old deployment archived. Restoring the old public version would restore the exposure; roll back with a corrected secure version instead.
