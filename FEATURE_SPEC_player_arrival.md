# Feature Spec: Player Arrival Tracking & Next-to-Play Queue

## Overview
Add player arrival tracking to the scoring app so scorers can manage the match queue. While one match is being scored, track which players from related fixtures have arrived, and display ready-to-play matches.

---

## Data Model

### New Database Table: `player_arrivals`
```
- id (UUID, primary key)
- venue_id (text) — the venue/location
- date (date) — session date
- fixture_id (text, FK) — the fixture
- player_id (text, FK) — the player
- arrived_at (timestamp) — when they arrived
- created_at (timestamp)
```

Or add to existing `roster` or `fixtures` table:
- `player1_arrived_at` (timestamp, nullable)
- `player2_arrived_at` (timestamp, nullable)

**Recommendation:** New table for flexibility (players might arrive at different times, and you might want history).

---

## Feature 1: Fixture List — Mark Arrivals

**UI:** In the fixtures list view (left panel), add a section above the fixture table:

```
┌─────────────────────────────────┐
│ Mark Player Arrivals            │
├─────────────────────────────────┤
│ Select fixture: [Dropdown v]    │
│ ☐ Player 1 Name                 │
│ ☐ Player 2 Name                 │
│ [Clear all] [Mark arrived]      │
└─────────────────────────────────┘
```

**Flow:**
1. User picks a fixture from dropdown
2. Shows both player names as checkboxes
3. Tick each player as they arrive
4. Click "Mark arrived" to save timestamps

**Backend:** POST endpoint to record `player_arrivals` entries.

---

## Feature 2: While Scoring — Arrival Buttons & Next-to-Play

**New section at top of scoring screen** (above current match, below "Match abandoned"):

```
┌─────────────────────────────────────────────────────────┐
│ Other fixtures (your teams)                             │
├─────────────────────────────────────────────────────────┤
│ [Line 2: Player A ☐ | Player B ☐]  ▶ Next to play      │
│ [Line 3: Player C ✓ | Player D ☐]                      │
│ [Line 4: Player E ✓ | Player F ✓]  ▶ Next to play      │
└─────────────────────────────────────────────────────────┘
```

**Features:**
- Shows all other fixtures from the same two **teams** playing now
- Checkbox per player (click to toggle arrival)
- "✓" = arrived, "☐" = not arrived
- **"Next to play"** pill shows when BOTH players arrived
- Clicking a fixture opens it for scoring (replaces current match)
- Live updates as scorers mark arrivals

**Backend:** 
- GET endpoint to fetch other fixtures + arrival status
- PATCH endpoint to update arrivals while scoring

---

## Recommended UI Layout for Large Screens

**Breakpoint:** 900px+ (tablet landscape and above)

**Layout:**
```
┌──────────────────────────────────────────────────────┐
│ Match abandoned – nominate winner  [Exit] [History]  │
├──────────────────────────────────────────────────────┤
│ Other fixtures (your teams)                          │
│ [L2: P1 ☐ | P2 ☐]  [L3: P3 ✓ | P4 ☐]  [L4: ✓✓ >>] │
├──────────────────────────────────────────────────────┤
│ Game 00:55 | Match 00:55 | History                  │
│                                                      │
│ ┌─────────────────┐    ┌──────────────────┐         │
│ │  Billy Triggell │    │    Nick Galea    │         │
│ │  0              │    │    0             │         │
│ │  [TAP=won]      │    │    [TAP=won]     │         │
│ └─────────────────┘    └──────────────────┘         │
│                                                      │
│ [Undo]              [Change server]                  │
└──────────────────────────────────────────────────────┘
```

**Adjustments from current:**
- Score card heights: reduce from ~70% to ~60% of viewport
- Button heights: ~40px instead of ~60px (touch target still 44px min via padding)
- Game summary: already at top, good position for spectators

---

## Implementation Phases

### Phase 1: Data + Fixture List UI
- Add `player_arrivals` table to Supabase
- Add "Mark arrivals" section to fixtures list
- Backend endpoints to record arrivals

### Phase 2: Scoring Screen Integration
- Fetch related fixtures + arrival status while scoring
- Add arrival buttons/display
- Update layout for large screens
- Live update when arrivals change

### Phase 3: Polish
- Keyboard shortcuts for rapid arrival marking
- Bulk operations (mark all, clear all)
- Historical view of arrivals per session

---

## Questions Answered

| Q | Answer |
|---|--------|
| Arrival capture | Manual via UI buttons (2 entry points) |
| Data storage | New table `player_arrivals` (recommended) |
| Scope | Per venue + date |
| Ready condition | Both players `arrived_at` is set |
| Related fixtures | Same two teams as current match |
| Ordering | By arrival time of last player |
| Large screen breakpoint | 900px+ |
| Clickable fixtures | Yes, open for scoring |
| Button heights | ~40px (was ~60px) |
| Match abandoned position | Very top |
| Data | Completely new |

---

## Open Design Decisions

1. **Data model:** New table vs. extend existing? (New recommended for flexibility)
2. **Venue identifier:** How is venue determined? Hardcoded in app? Selected per session?
3. **Session date:** Auto-detected (today's date) or user-selectable?
4. **Rapid entry:** Should there be a "quick entry" mode (e.g., swipe to mark arrived)?
5. **Display format:** "Next to play" pill vs. card vs. highlight color?
