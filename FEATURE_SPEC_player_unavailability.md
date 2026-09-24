# Feature Spec: Planned Player Unavailability & Advance Sub Nomination

## Problem

Players know in advance about dates they can't play (holidays, injury, work). Today
the only way to handle this is on match night, via the "Substitute" checkbox when
starting a match. There's no way to:

- Record in advance that a player is unavailable for a stretch of time
- See that a fixture's rostered player is planned-absent when browsing upcoming
  fixtures
- Nominate a substitute ahead of time, so the fixture list reflects who's actually
  expected to play before the day arrives

A player going on a 3-week holiday, or out injured for a month, needs this handled
**once**, not fixture-by-fixture — re-entering the same absence against every
individual match over several weeks would be painful and error-prone.

## Design decisions

1. **Unavailability is a date range against a player, not a fixture.** A separate
   `player_unavailability` table (player_id, date_from, date_to, reason) models
   "this player can't play between these dates" independently of any match.
   Fixtures within that range are derived by joining on date, not stored per-row.

2. **Bulk entry lives in Comp Admin, not the scorer PWA fixture list.** Entering a
   multi-week absence one fixture at a time is the exact pain point being solved,
   so the primary entry point is an admin screen: pick a player, a date range, an
   optional reason, save once. This is new admin panel functionality (Admin.html /
   AdminApp.gs).

3. **The fixture list (scorer PWA) is the secondary, single-fixture entry point.**
   Useful for a last-minute or single-match change, and especially for a captain
   or admin browsing a future date and wanting to nominate a sub right there. This
   does NOT replace the bulk admin tool — it's for the one-off case.

4. **A sub nomination is per-fixture, not per-unavailability-window.** Different
   weeks of the same absence may need different subs (whoever's free that week),
   so nominating a sub is always scoped to one fixture, even though the underlying
   unavailability record spans many fixtures.

5. **Arrival tracking stays a simple binary (arrived / not arrived).** Rather than
   a tri-state pill (not-arrived → arrived → sub), planned absence and arrival are
   kept as separate concerns:
   - Unavailability + optional sub nomination determines **who is expected to
     play** a given fixture (the rostered player, or their nominated sub).
   - The existing arrival pill (Phase 1) then tracks whether *that* person has
     shown up, same as today. No change needed to the arrival state machine.

## Data model

```sql
CREATE TABLE IF NOT EXISTS player_unavailability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id TEXT NOT NULL REFERENCES players(player_id),
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CHECK (date_to >= date_from)
);
CREATE INDEX IF NOT EXISTS idx_unavail_player_dates ON player_unavailability(player_id, date_from, date_to);

CREATE TABLE IF NOT EXISTS fixture_sub_nominations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
  original_player_id TEXT NOT NULL REFERENCES players(player_id),
  sub_player_id TEXT NOT NULL REFERENCES players(player_id),
  nominated_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(fixture_id, original_player_id)
);
```

A fixture's "expected player" for a given slot = the sub from
`fixture_sub_nominations` if one exists for that fixture, else the rostered
player — with the rostered player additionally flagged as **planned absent** if
today's fixture date falls inside a `player_unavailability` range for them and no
sub has been nominated yet.

## Implementation phases

**Phase A — Data + bulk admin entry**
- Deploy the two tables above.
- New Comp Admin screen: list current/upcoming unavailability records; add one
  (player picker, date-from, date-to, reason); edit/delete existing ones.
- No change yet to the scorer PWA fixture list — this phase just gets the data in.

**Phase B — Fixture list integration (scorer PWA)**
- Fixture list marks a rostered player as "planned absent" (e.g. greyed pill with
  a small note) when the fixture date falls in their unavailability range and no
  sub is nominated.
- Tapping a planned-absent player opens a lightweight "Nominate a sub" picker
  (reuses the existing player search/add-player flow from match setup) scoped to
  that one fixture.
- Once a sub is nominated, the fixture list shows the sub's name in place of (or
  alongside) the original player, and the normal arrival pill applies to the sub.

**Phase C — Polish**
- Comp Admin: surface which upcoming fixtures still need a sub nominated for a
  known absence (a simple "gaps" list), so it doesn't get missed.
- Consider a notification/reminder if an absence's fixtures are close and no sub
  is nominated yet.

## Explicitly out of scope for now

- Players self-service entering their own unavailability (admin enters it, at
  least initially).
- Automatic sub suggestions/matching — sub is always chosen manually.
