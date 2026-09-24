# Phase 1 Implementation Guide: Player Arrival Tracking

## Status
- ✅ Spec complete (`FEATURE_SPEC_player_arrival.md`)
- ✅ Design decisions finalized
- ✅ Backend functions written (`AdminApp.gs`: markPlayerArrived, getArrivalStatusForFixtures, clearArrival)
- ⏳ **TODO:** Deploy Supabase schema + add frontend UI

---

## Step 1: Deploy Supabase Schema

Run the SQL in Supabase SQL editor (or via migrations):

```sql
CREATE TABLE IF NOT EXISTS player_arrivals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id TEXT NOT NULL,
  date DATE NOT NULL,
  fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
  player_id TEXT NOT NULL REFERENCES players(player_id),
  arrived_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(date, fixture_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_arrivals_venue_date ON player_arrivals(venue_id, date);
CREATE INDEX IF NOT EXISTS idx_arrivals_fixture ON player_arrivals(fixture_id);
CREATE INDEX IF NOT EXISTS idx_arrivals_player ON player_arrivals(player_id);

CREATE OR REPLACE VIEW fixture_arrival_status AS
SELECT 
  f.fixture_id,
  f.comp_ref,
  f.round,
  f.line,
  f.team1_id,
  f.team2_id,
  f.player1_id,
  f.player2_id,
  p1_arrived.arrived_at AS player1_arrived_at,
  p2_arrived.arrived_at AS player2_arrived_at,
  CASE 
    WHEN p1_arrived.arrived_at IS NOT NULL AND p2_arrived.arrived_at IS NOT NULL THEN 'ready'
    WHEN p1_arrived.arrived_at IS NOT NULL OR p2_arrived.arrived_at IS NOT NULL THEN 'partial'
    ELSE 'not_arrived'
  END AS status
FROM fixtures f
LEFT JOIN player_arrivals p1_arrived ON f.fixture_id = p1_arrived.fixture_id AND f.player1_id = p1_arrived.player_id
LEFT JOIN player_arrivals p2_arrived ON f.fixture_id = p2_arrived.fixture_id AND f.player2_id = p2_arrived.player_id;
```

---

## Step 2: Add Fixture List UI for Marking Arrivals

Location: `index.html` (fixtures list view, left panel)

Add a new section ABOVE the fixture table at the top of the fixtures panel:

```html
<div id="markArrivals" class="card" style="margin-bottom:16px;display:none">
  <div class="eyebrow">Mark Player Arrivals</div>
  <label class="field">Select fixture</label>
  <select id="arrivalFixtureSelect" style="width:100%;padding:8px;margin-bottom:8px">
    <option value="">-- Pick a fixture --</option>
  </select>
  
  <div id="arrivalCheckboxes" style="display:none">
    <label style="display:block;margin:8px 0">
      <input type="checkbox" id="arrivals_p1"> <span id="arrivals_p1_name"></span>
    </label>
    <label style="display:block;margin:8px 0">
      <input type="checkbox" id="arrivals_p2"> <span id="arrivals_p2_name"></span>
    </label>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="cta" id="clearArrivalsBtn" style="flex:1">Clear</button>
      <button class="cta" id="markArrivalsBtn" style="flex:1">Mark arrived</button>
    </div>
  </div>
</div>
```

---

## Step 3: Add JavaScript for Marking Arrivals

Add to `index.html` after the `loadFixtures()` function:

```javascript
var arrivalDate = null;

function showMarkArrivals() {
  var fixtures = allFixtures;
  if (!fixtures.length) {
    $('markArrivals').style.display = 'none';
    return;
  }
  
  $('markArrivals').style.display = 'block';
  arrivalDate = $('fxDate').value || localDate();
  
  // Populate fixture dropdown
  var sel = $('arrivalFixtureSelect');
  sel.innerHTML = '<option value="">-- Pick a fixture --</option>';
  fixtures.forEach(function(f) {
    var label = 'L' + (f.line || '?') + ': ' + (f.player1 || '?') + ' vs ' + (f.player2 || '?');
    sel.innerHTML += '<option value="' + f.id + '">' + esc(label) + '</option>';
  });
  
  sel.onchange = function() {
    if (!sel.value) {
      $('arrivalCheckboxes').style.display = 'none';
      return;
    }
    
    var fixture = fixtures.find(function(f) { return f.id === sel.value; });
    if (!fixture) return;
    
    $('arrivals_p1_name').textContent = fixture.player1 || 'Player 1';
    $('arrivals_p2_name').textContent = fixture.player2 || 'Player 2';
    $('arrivals_p1').checked = false;
    $('arrivals_p2').checked = false;
    $('arrivalCheckboxes').style.display = 'block';
  };
}

function markPlayerArrived() {
  var sel = $('arrivalFixtureSelect');
  var fixtureId = sel.value;
  if (!fixtureId) return alert('Select a fixture first');
  
  var fixture = allFixtures.find(function(f) { return f.id === fixtureId; });
  if (!fixture) return;
  
  var p1_marked = $('arrivals_p1').checked;
  var p2_marked = $('arrivals_p2').checked;
  
  if (!p1_marked && !p2_marked) return alert('Select at least one player');
  
  // Call backend to mark arrivals
  var calls = [];
  if (p1_marked && fixture.player1Id) {
    calls.push(callApi({
      action: 'markArrival',
      fixtureId: fixtureId,
      playerId: fixture.player1Id,
      date: arrivalDate
    }));
  }
  if (p2_marked && fixture.player2Id) {
    calls.push(callApi({
      action: 'markArrival',
      fixtureId: fixtureId,
      playerId: fixture.player2Id,
      date: arrivalDate
    }));
  }
  
  Promise.all(calls).then(function() {
    alert('Players marked as arrived');
    sel.value = '';
    $('arrivalCheckboxes').style.display = 'none';
  }).catch(function(err) {
    alert('Error: ' + (err.msg || err.reason || 'Failed to mark arrivals'));
  });
}

$('markArrivalsBtn').onclick = markPlayerArrived;
$('clearArrivalsBtn').onclick = function() {
  $('arrivals_p1').checked = false;
  $('arrivals_p2').checked = false;
};

// Show mark arrivals section when fixtures load
var origRenderFixtures = window.renderFixtures;
window.renderFixtures = function(list) {
  origRenderFixtures(list);
  showMarkArrivals();
};
```

---

## Step 4: Add Backend Handler for Marking Arrivals

Add to `Code.gs` doGet handler:

```javascript
if (action === 'markArrival') {
  var result = markPlayerArrived(e.parameter.fixtureId, e.parameter.playerId, 'default-venue', e.parameter.date);
  return out_(result, e);
}
```

(Note: `'default-venue'` is a placeholder — you may want to pass venue from the app or use a session setting)

---

## Step 5: Test Phase 1

1. Deploy Apps Script changes: `clasp push`
2. Deploy Supabase schema
3. Open the scoring app
4. Go to fixtures list, you should see "Mark Player Arrivals" section
5. Select a fixture → check players → click "Mark arrived"
6. Verify in Supabase that `player_arrivals` table has the records

---

## Phase 1 Complete Checklist

- [ ] Supabase schema deployed (player_arrivals table + indexes + view)
- [ ] markPlayerArrived, getArrivalStatusForFixtures, clearArrival functions in AdminApp.gs
- [ ] Fixture list UI added to index.html
- [ ] JavaScript event handlers wired up
- [ ] Backend handler in Code.gs doGet
- [ ] Apps Script deployed
- [ ] Manual test: mark a player as arrived, verify in Supabase

---

## Next: Phase 2

Once Phase 1 is working:

1. **While Scoring:** Show related fixtures with arrival toggles above the score area
2. **Layout improvements:** Reduce button sizes, move match abandoned to top
3. **Live updates:** Real-time sync as arrivals are marked
4. **Next to play badge:** Show when both players arrived

See `FEATURE_SPEC_player_arrival.md` for Phase 2-3 details.

---

## Files Modified

- `app-script/AdminApp.gs` — Added backend functions
- `index.html` — TODO: Add fixture list UI
- `app-script/Code.gs` — TODO: Add doGet handler for markArrival action

## Files Created

- `FEATURE_SPEC_player_arrival.md` — Complete specification
- `CREATE_ISSUE.md` — GitHub issue template
- `IMPLEMENTATION_PHASE1.md` — This guide
- Schema file (deploy to Supabase)
