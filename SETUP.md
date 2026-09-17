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

Use **Comp Admin → Administrators** to add or remove Google account emails. Any current administrator can maintain this club-wide list (all competitions). Each change asks for confirmation, takes effect on the next server request, and is recorded in the Apps Script execution log. The UI cannot remove the signed-in administrator; a second administrator can remove them instead. Updates use a shared lock and individual add/remove operations so simultaneous edits do not overwrite one another. The list supports up to 25 accounts. Adding an address does not send email, share Drive files, or grant Apps Script editor access.

For recovery, the project owner can edit **Project Settings → Script properties → ADMIN_EMAILS** directly. Use a comma-separated list, retaining all intended administrators. Clearing the property restores the two default identities. Use the exact Google account email, not a mailing-list or forwarding address.

The scorer deployment runs as the owner and permits anonymous HTTP access, with the private code validated by the backend. A plain anonymous request cannot open admin. The owner can access admin while signed in. For another authorized administrator, use a separate web-app deployment executing as **User accessing the web app**, requiring Google sign-in, with underlying spreadsheet/database script permissions as needed; do not weaken the server allowlist. Google may require the user to authorize the existing script scopes.

## Release order

1. Back up the existing database and script source.
2. Apply the SQL migration to the existing Supabase schema. Keep RLS enabled and ordinary API roles denied; only `service_role` can call the new write routines.
3. Save all Apps Script source, configure the private code, and update the existing deployment to a new version, preserving its `/exec` URL. Review active deployments so an old public version is not left active.
4. Publish the frontend to GitHub Pages. Set only `APPS_SCRIPT_URL` in source; leave `SHARED_SECRET` blank.
5. Verify anonymous admin denial, rejected missing/invalid scorer codes, authorized fixture reads, and pending-result controls. Existing installed apps may need to be reopened/reloaded to receive the new service worker.

## Result durability

## Competition output and fixture status

Apply `database/output_and_identity.sql` and then `database/queued_scan_recovery.sql` after the existing migrations. `comps.output_workbook_id` identifies a separate workbook for each competition; a unique index prevents accidental sharing of an output workbook between seasons. In Comp Admin → Results, save its workbook ID or URL. The script owner must be able to edit it. The destination needs a **Retro Results** tab with named ranges `Line1_Names` through `Line5_Names` and `Team_Names`, and sequential numeric round headers after the name and line columns. Existing formulas are preserved. Extend round headers before TOTAL if a season is longer than the template.

Onboarding/cloning offers an optional new output workbook. A clone never inherits the source competition's destination. With no destination, sending is disabled and setup instructions are shown. Committing or deleting results no longer publishes workbook output automatically. Choose a round, preview the cell changes, and confirm **Send results to output**. Every fixture needs a result and linked scan. A preview expires after ten minutes and is rejected if source/output changes. Each round fills its existing column; retries do not append duplicate records. A private workbook backup is created before a write, and the changes are sent in one native range write, preserving intervening formulas and formatting, followed by a read-back check. Only Retro Results receives distributed results.

Reports use scheduled player IDs: only a player's scheduled match earns individual points, while substitute results still count toward the represented team's score. BYEs are inferred only for a complete odd-team round with exactly one absent team. Missing results remain blank; ambiguous duplicate scheduled appearances show CHECK and block output. Incomplete team ties do not receive a premature win bonus.

Scorer fixture cards include Not yet played, Underway, Played, Scratched, and Needs review (legacy played flag without a result), with scores and a completed-fixture filter. Live scores refresh about every 30 seconds when online; progress expires after three minutes without a heartbeat and is informational, not a saved result. Offline scoring and pending results remain local until acknowledged.

`player_aliases` retires confirmed duplicate identities without deleting their records. Old queued IDs resolve to the canonical player. A late app submission can replace a scanned result only when player IDs, match score, and every game match exactly; the scan link is retained and the old scan result is archived. Conflicting results remain queued for administrator review. `database/test_queued_scan.sql` verifies this within a rolled-back transaction using the documented scanned fixture.

The browser autosaves the active match. At confirmation it first persists the full result under its match ID, then sends it. Results stay queued until acknowledged. A rejected result remains visible with its error; it does not block other queued results. Open **View pending results / retry sync** from setup or the result summary to retry or download a backup. Clearing browser storage removes local matches and unsynced results, so export pending results first.

The database saves a match, its games, its rallies and its played flag in one transaction. A fixture has at most one result. Repeating the same immutable result is safe; conflicting changes are rejected. Scan replacement/removal archives the old rows and deletes dependent rallies before games. Scan overrides of app results require explicit admin selection. Dates use the fixture's authoritative instant and Sydney calendar interpretation. Scoring rules come from the selected competition.

## Credential incident follow-up

The previous public admin code exposed callable property helpers. There is no evidence here that credentials were retrieved, but the Supabase privileged key and Gemini key should be rotated through their provider consoles and replaced in Script Properties. Do not record their values in commits, logs or issue reports. Keep the old deployment archived. Restoring the old public version would restore the exposure; roll back with a corrected secure version instead.
