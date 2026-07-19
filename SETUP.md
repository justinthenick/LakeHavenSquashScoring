# Court Card — setup

A lean squash PAR scorer that reads fixtures from a Google Sheet and writes
results back. No app store, no OAuth on the phone. The phone talks to **one**
Apps Script URL that runs as you and has native Sheets access.

```
 phone (PWA)  ──GET  ?action=fixtures──►  Apps Script web app  ──►  Google Sheet
              ◄──── JSON fixtures ─────
              ──POST result (JSON) ───►                        ──►  MatchLog + GameLog
```

## How and when results are written

**Written once, at match end** — not per game. The app can undo across a
completed game, so committing a game mid-match could leave a stale row behind.
Instead the app **autosaves the in-progress match locally** after every rally;
if the phone dies or you close it, reopening offers **Resume** (works for a
match still in progress *or* one that finished but wasn't saved yet). The sheet
only ever receives complete, consistent matches.

Even though it writes once, it writes the **full per-game breakdown**, so your
ladders and per-player stats get game-level resolution.

## The app is the only writer, and only to raw logs

Two append-only tabs, both written in the single match-end POST. Build ladders,
standings and player progress as **separate QUERY tabs that read these** — never
point the app at a formula-driven tab, or it'll trample your formulas.

## Files

| File | Where it goes |
|------|----------------|
| `squash-scorer.html` | the app (host it, or open locally) |
| `manifest.webmanifest`, `sw.js` | next to the html — install + offline |
| `icon-192.png`, `icon-512.png` | you supply (any square PNG) |
| `Code.gs` | pasted into the Sheet's Apps Script editor |

## 1. Sheet tabs

**Fixtures** (app reads; row 1 headers matched by name, any subset/order):

| Id | Player1 | Player2 | Color1 | Color2 | PointsToWin | BestOf | Event | Venue | Played |
|----|---------|---------|--------|--------|-------------|--------|-------|-------|--------|
| 1  | J. Smith | A. Lee | #e6913c | #6b52ae | 15 | 5 | Div 1 R3 | Court 2 | |

- Colours optional; if present the app pre-selects them.
- Anything in **Played** hides that fixture in the app; the backend stamps it
  automatically after a result is saved (needs `Id` + `Played` columns).

**MatchLog** and **GameLog** — don't create them; `Code.gs` makes them with the
right headers on first save.

- **MatchLog** (1 row / match): `MatchId, Timestamp, Date, Event, Venue,
  FixtureId, Player1, Player2, Color1, Color2, GamesP1, GamesP2, Winner,
  ScoreLine, DurationSec`
- **GameLog** (1 row / game — authoritative for points): `MatchId, GameNo, Date,
  Event, Player1, Player2, PointsP1, PointsP2, GameWinner`

## 2. Deploy the backend

1. In the Sheet: **Extensions ▸ Apps Script**. Delete the stub, paste `Code.gs`.
2. Set `SECRET` to a random string.
3. **Deploy ▸ New deployment ▸ Web app** — Execute as **Me**, access **Anyone**.
4. Authorise, copy the **/exec** URL.

> "Anyone" = anyone with the URL can hit it, which is why every request carries a
> shared `SECRET`. Keep the URL + secret private; don't commit them to a public
> repo. Not bank-grade, but it keeps random traffic out.

## 3. Wire up the app

Top of the script block in `squash-scorer.html`:

```js
var CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfy..../exec",
  SHARED_SECRET:   "the-same-secret-as-Code.gs"
};
```

## 4. Host it

- **GitHub Pages** (free HTTPS — required for install + offline): drop the files
  in a repo, enable Pages, open the `squash-scorer.html` URL on your phone,
  browser menu ▸ **Add to Home screen**.
- Or open the file directly for a quick test (install/offline won't fully engage
  without HTTPS, but scoring works).

## The one gotcha: CORS

Apps Script mishandles CORS **preflight**. The app avoids it: reads are plain
`GET`; writes are `fetch(url,{method:'POST',body:JSON.stringify(...)})` with **no
`Content-Type` header** (so the browser sends `text/plain`, a "simple request",
no preflight) and `Code.gs` reads `e.postData.contents`. If you add
`Content-Type: application/json` it starts failing with an opaque CORS error.
Don't.

## Building your ladders from the logs (examples)

Put these in a NEW tab, not in a log tab. Adjust ranges/columns to your data.

Human-readable results feed, newest first:

```
=QUERY(MatchLog!A:O,
  "select B, C, G, H, N, M where G is not null order by B desc", 1)
```

A player's games won + points for/against across BOTH GameLog columns
(replace `"J. Smith"`):

```
Games won  =COUNTIFS(GameLog!E:E,"J. Smith",GameLog!I:I,"J. Smith")
            +COUNTIFS(GameLog!F:F,"J. Smith",GameLog!I:I,"J. Smith")
Points for =SUMIF(GameLog!E:E,"J. Smith",GameLog!G:G)
            +SUMIF(GameLog!F:F,"J. Smith",GameLog!H:H)
Points against =SUMIF(GameLog!E:E,"J. Smith",GameLog!H:H)
            +SUMIF(GameLog!F:F,"J. Smith",GameLog!G:G)
```

Because a player can be in either the Player1 or Player2 column, per-player
aggregation always sums the two cases. If you'd rather work with a single tidy
"one row per player per game" table for your existing INDIRECT/IMPORTRANGE
ladder machinery, unpivot GameLog once:

```
={ GameLog!A2:B, GameLog!E2:E, GameLog!G2:G, GameLog!H2:H ;
   GameLog!A2:B, GameLog!F2:F, GameLog!H2:H, GameLog!G2:G }
```

(MatchId, GameNo, Player, PointsFor, PointsAgainst — stacked for both players.)

## Scoring rules implemented

- Point-a-rally; tap the winner's panel.
- Server keeps serve and swaps box each point; lose the rally and serve passes
  over, new server starts **Right** (tap the R/L badge or **Swap box** for Left).
- Game to target; **win-by-two** toggle (default on). Best of 1/3/5. Winner of a
  game serves next. **Undo** reverses everything, including across a game.
- Left out by choice: let/stroke, conduct, injury/forfeit, warm-up timer. The
  engine has a clean seam to add them later.

## Changing scoring later

The logic is the node-tested engine functions near the top of the script block
(`wonRally`, `gameResult`, etc.), inlined verbatim from a module with 22 passing
tests. Edit there; nothing else depends on the internals.
