# Feature Spec: Venues, Court Pre-Allocation & Court Watch

## Overview

Two linked features:

1. **Venues & courts** — a venue has a fixed number of courts. Admin pre-allocates
   which fixture plays on which court, ahead of time. This removes the informal
   "who gets which court" negotiation between teams, and gives the system enough
   information to know what's happening on any given court without the scorer
   having to type anything.
2. **Court Watch** — a standalone, read-mostly page: point it at a court number
   and it shows whatever's happening there live (current score, between-games
   summary, arrival/queue status), for people not physically at the venue. It
   allows one interactive action — marking a player as arrived — using the same
   mechanism as the scorer app, gated by the same club access code.

## Data model

```sql
CREATE TABLE IF NOT EXISTS venues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  court_count INT NOT NULL CHECK (court_count > 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Pre-allocation: which fixture is assigned to which court, for a given date.
-- One row per fixture (a fixture only ever plays once, so fixture_id is
-- unique) - admin can reassign by updating the row, not by adding new ones.
CREATE TABLE IF NOT EXISTS fixture_court_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id TEXT NOT NULL UNIQUE REFERENCES fixtures(fixture_id),
  venue_id UUID NOT NULL REFERENCES venues(id),
  court_number INT NOT NULL,
  allocated_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CHECK (court_number > 0)
);
CREATE INDEX IF NOT EXISTS idx_court_alloc_venue_court ON fixture_court_allocations(venue_id, court_number);
```

`player_arrivals.venue_id` currently holds the hardcoded placeholder
`'default-venue'` (added when arrival tracking was built, anticipating this
feature) — once venues are real, arrivals should record the actual venue's
`id` instead.

## Comp Admin: Venue & court management

New tab (matching the existing Player Availability tab's conventions):

- **Venues list**: name + court count, add/edit/delete (matching the simple
  list+form pattern already used).
- **Court allocation**: pick a date (and optionally comp/round, mirroring the
  scorer app's fixture filters), see all that date's fixtures with a court
  picker per fixture (constrained to the selected venue's `court_count`).
  Unallocated fixtures are clearly flagged so nothing gets missed. This is the
  main tool for pre-empting court-preference disputes — allocate the whole
  round in one sitting.

## Scorer app: court display

- When a fixture has a pre-allocation, its court number shows on the fixture
  list and is submitted automatically with progress updates and the final
  result — no manual entry needed for the normal case.
- Since overflow fixtures (from a different team match-up) occasionally land
  on a court that wasn't allocated to them, the scorer can override the court
  number before starting — defaulting to the pre-allocated value, editable,
  not locked. Ad-hoc matches (no fixture) fall back to a manually entered
  court number, remembered per device the same way the club code is.

## Court Watch (standalone page)

A new, separate lightweight page (own HTML file, own manifest), not merged
into the scorer app — spectators get a fundamentally different interaction
model (no tap-to-score, no undo, no change-server), and keeping it separate
means the scorer app's code never has to branch on "am I in watch mode."

**Access:** gated by the same club access code / device token as the scorer
app (not fully public), since it now includes a write action (marking
arrivals), not just reads.

**Entry:** pick a venue + court number (remembered per device thereafter,
same convention as the scorer app's club code and court override).

**Layout, top to bottom** (mirrors the scorer app's structure so the two feel
like the same product):
1. Arrival/queue banner — the same "other fixtures, tap to mark arrived,
   #N / played" bar used on the scorer app's score screen, scoped to whichever
   fixture is currently on this court (or the two teams involved, once known).
   Tapping a player pill marks arrival exactly as it does today — the one
   interactive action this page has.
2. Game/match timers — same clockbar as the scorer app (Game N, Games X–Y,
   Game clock, Match clock).
3. Score panels — same visual layout as the scorer app (names, colours,
   points, serve indicator) but **not tappable** — no "tap = won rally", no
   undo, no change-server. Purely a live mirror of the score.
4. Between games / between matches — the same summary screen shown on the
   scorer app between games (game-by-game table, tie table with arrivals and
   queue position) is shown here too, and is also what displays when no game
   is currently in progress on this court (i.e. the "idle" state is just this
   same summary screen, not a separate design).
5. History — same as the scorer app's History drawer, read-only.

**Live updates:** polls the same progress/arrival/queue data the scorer app
already publishes (`action:'progress'`, arrival status, sub nominations),
on a short interval, so score changes appear promptly without a manual
refresh. Works in both portrait and landscape.

**Explicitly not included:** scoring taps, undo, change-server, match
abandon, save/result-submission — anything that mutates the match itself.

## Implementation phases

**Phase A — Venues & court pre-allocation (Comp Admin)**
- `venues` + `fixture_court_allocations` tables
- Venues list tab
- Court allocation tool (date/round view, per-fixture court picker)

**Phase B — Scorer app court awareness**
- Fixture list shows pre-allocated court
- Court submitted automatically with progress/results; editable override for
  overflow fixtures; remembered manual court for ad-hoc matches
- `player_arrivals.venue_id` switched from the `'default-venue'` placeholder
  to the real venue id

**Phase C — Court Watch page**
- New standalone page: venue/court picker, club-code gate
- Live score mirror + clockbar + arrival/queue banner + history, reusing the
  scorer app's existing rendering logic wherever practical (shared JS module
  rather than copy-pasted, where that's not too disruptive to extract)
- Between-games/idle summary screen (shared with the scorer app's tie table)
- Polling-based live updates
