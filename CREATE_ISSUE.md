# Create GitHub Issue: Player Arrival Tracking Feature

The feature spec is ready! To create the GitHub issue, choose one of these methods:

## Option 1: Create Manually (Easiest)

1. Go to: https://github.com/justinthenick/LakeHavenSquashScoring/issues/new
2. **Title:** `Feature: Player arrival tracking & next-to-play queue`
3. **Body:** Copy the text below
4. **Labels:** Add `enhancement`, `ui`, `large-screen`
5. Click **Submit**

### Issue Body (copy & paste):

```
## Overview
Add player arrival tracking to the scoring app so scorers can manage the match queue. While one match is being scored, track which players from related fixtures have arrived, and display ready-to-play matches.

## Problem
While scoring a match, organizers cannot easily see:
- Which players from other fixtures have arrived
- Which matches are ready to play next
- A clear queue of waiting matches

## Solution
Add player arrival tracking with two UI entry points:

1. **Fixture List:** Dropdown to select a fixture + checkboxes to mark players as arrived
2. **While Scoring:** Show related fixtures (same teams) with arrival toggles and "Next to play" indicators

## Implementation
- New database table: `player_arrivals` (venue, date, fixture_id, player_id, arrived_at)
- Three implementation phases:
  - **Phase 1:** Data model + fixture list UI
  - **Phase 2:** Scoring screen integration + layout improvements
  - **Phase 3:** Keyboard shortcuts + bulk operations + historical view

## Design Decisions (Finalized)
- ✅ New `player_arrivals` table for flexibility and history tracking
- ✅ Auto-detect venue from current fixture; allow override in session settings
- ✅ Auto-detect session date (today); allow date picker for makeup matches
- ✅ Keyboard shortcuts for rapid entry:
  - `1` / `2` — toggle player 1 / player 2 arrival
  - `Space` — toggle focused player
  - `Enter` — confirm and move to next
- ✅ "▶ Next to play" bright badge/pill when both players arrived

## Layout Changes (Large Screens: 900px+)
- Move "Match abandoned" to very top
- Reduce score card heights from ~70% to ~60% of viewport
- Reduce button heights from ~60px to ~40px
- Add fixture queue display above scoring area showing related matches

## Scope
- Per venue + session date
- Show only fixtures from same two teams as current match
- Ordered by arrival time of last player to arrive
- Clicking a fixture opens it for scoring

## Resources
- Full specification: See `FEATURE_SPEC_player_arrival.md` in this repo
- Includes data model, UI flows, layout mockups, and all implementation details

**Type:** Enhancement  
**Priority:** Medium  
**Effort:** Medium (3-5 days for all 3 phases)
```

---

## Option 2: Using GitHub CLI (if installed)

```bash
gh issue create \
  --title "Feature: Player arrival tracking & next-to-play queue" \
  --label "enhancement,ui,large-screen" \
  --body-file CREATE_ISSUE.md
```

---

## Option 3: Using curl with GitHub API

First, get a GitHub personal access token:
1. Go to https://github.com/settings/tokens
2. Click "Generate new token"
3. Select scopes: `repo`
4. Copy the token

Then run:
```bash
export GITHUB_TOKEN="your_token_here"
bash /tmp/create_github_issue.sh
```

---

**Status:** ✅ Ready to create — feature spec is complete and finalized at `FEATURE_SPEC_player_arrival.md`
