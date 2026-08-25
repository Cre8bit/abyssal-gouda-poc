# Abyssal — The Descent, Round by Round

A design read-me: what the loop is today, where its difficulty flattens out, and
how to make every round harder than the last **without adding a single new
mechanic to learn**. Plus: stories of how a game actually plays, because the
mood is the product.

---

## 1. The loop as it stands

One sentence: *hook on → the bell falls 100 m → it shakes you off somewhere in
the dark → swim home before your air runs out → hook on again.*

That's the whole game, and it's the right game. What makes it work:

- **The scatter is the level.** There is no map to memorise — every round the
  "level" is a random bearing and a distance, and the only geometry that
  matters is *you → bell*.
- **The instruments can lie.** The bell radar doesn't know what the bell *is*,
  only what pings like one — and from level 1 down, something else pings like
  one. The scariest UI element in the game is the honest-looking amber quadrant.
- **Being eaten isn't death.** A swallowed diver is out until the bell next
  settles, then hauled back with the crew. The only true loss is a full wipe.
  This keeps groups laughing instead of quitting.
- **The hull is real safety.** The Lanternmaw will not take a hooked diver.
  Every round therefore has a finish line you can *feel*.

Where the difficulty currently flattens:

| System | Today | Problem |
| --- | --- | --- |
| Ejection scatter | grows +35 % per level (`EJECT_GROWTH`, `bell.js`) | ✅ the one knob that already scales |
| Oxygen | flat 180 s forever (`O2_SECONDS`, `main.js`) | never actually tight — level 5's swim home is ~60 s of a 180 s tank |
| Bell ping | every 5 s forever (`ALARM_PERIOD`, `bell.js`) | navigation never gets harder, only longer |
| The Lanternmaw | same ranges, same half-beat lure offset at every depth | once you've learned "count the half-beat", level 6 is level 2 |
| Currents | same strength/frequency at every depth (`current.js`) | ambience at level 1, still ambience at level 6 |

By level 4 a practised crew is just doing a longer version of level 2. The fix
is not new systems — it's screws.

---

## 2. The design rule

> **One loop. Same verbs every round. Every knob tightens with depth.**

Nothing new to explain, ever. A new player learns everything on levels 0–2, and
levels 3+ are the same game with less air, fewer pings, a better liar, and
meaner water. Difficulty should always be legible as *"the thing I already
understand, but worse"* — the ocean doesn't change its rules, it just stops
being polite.

---

## 3. The escalation ladder

All parameter-only. `L` = bell level. Each one is a one-line change at the call
site listed.

### 3.1 The ping stretches — *navigation gets harder, not just longer*

`ALARM_PERIOD` becomes `5 + 0.75·L`, capped at 9 s (`bell.js` / `main.js`).

At level 1 you get a bearing every 5 seconds. At level 5 you get one every
~8.7 — you swim most of the way home on memory, drift and faith. This is the
single highest-value knob in the game: it makes the *existing* compass,
minimap-quadrant and stereo-panned ping matter more every round, and it makes
the dark between pings feel longer, which is exactly the mood.

### 3.2 The lure learns the beat — *the lie improves*

Today the counterfeit ping fires half a beat off the bell's
(`lurePingTimer = ALARM_PERIOD * 0.5`, `main.js`). Shrink the offset per level:

```
offset = ALARM_PERIOD × max(0.5 − 0.08·L, 0.08)
```

- Level 1–2: two clearly separate pings. Count the rhythm, live.
- Level 3–4: they syncopate. You *think* you can still tell.
- Level 5+: near-unison. Rhythm alone no longer saves you — you need the
  vertical ▲▼ hint on the radar, a flare, or a teammate calling "my quadrant's
  clean" over voice. The tool you trusted at level 2 quietly stops working,
  and the game never had to say a word.

### 3.3 The fish gets hungrier — *shorter grace, longer memory*

In `angler.js`, scale with depth on spawn:

- `NOTICE_RANGE`: 72 → +6/level (it commits to you from further away)
- `T_REVEAL`: 1.15 s → −0.08/level, floor 0.7 s (less time between "IT IS NOT
  THE BELL" and the lunge)
- `T_SOUND` (its sulk after a miss): 18 s → −2/level, floor 8 s (a missed lunge
  at level 6 buys you seconds, not a rest of the round)
- Patrol centre drifts closer to the bell each level — at depth, the monster is
  *between* you and home more often than not.

### 3.4 The air thins — *pressure is a clock you can hear*

Keep the 180 s tank, scale the **drain**: `drain = 1 + 0.12·L` (`main.js`,
step 8). At level 5 your tank is effectively ~112 s. Combined with the wider
scatter, the maths finally crosses: from level 5 down, *a straight swim home
still works, but a single mistake — one wrong light, one current, one detour —
does not.* The O₂ bar goes from decoration to the reason your voice shakes.

(Cheap juice: below 25 % O₂, drive `setBreathRate` to max and let the HUD bar
pulse. The panic should be audible to *you* before it's visible to anyone.)

### 3.5 The water gets meaner — *currents graduate from mood to hazard*

In `current.js`, scale per level: `STRENGTH` 3.4 → +0.35/level (base swim speed
is 4.5, sprint 9 — at level 5 a core current outruns your normal swim and you
*must* sprint or cross it sideways), and tighten spawn gaps (`GAP_MIN/MAX`
−15 %/level). A current that drags you 40 m off your ping bearing at level 5,
with 9 seconds to the next ping and thin air, is a whole story by itself — and
it costs zero new code paths.

### 3.6 Already done, keep it

- Ejection spread already grows (`EJECT_GROWTH = 0.35`).
- Fog/dread already deepen (`setDread`, `setDepthLevel`).
- The Lanternmaw already only hunts where it's dark enough to work.

### The ladder, felt from inside the helmet

| LVL | Name the crew will use | What actually changed | What it feels like |
| --- | --- | --- | --- |
| 0 | The Surface | — | Sunlight. Jokes on voice. Someone can't find E. |
| 1 | The Murk | angler wakes, scatter 55–85 m | "There are two lights." — "No there aren't." |
| 2 | Blackwater | full dark, dread ramp begins | Flashlights become currency. First swallow. |
| 3 | The Choir | pings 7.25 s apart, lure ~2 s off-beat | Everyone counts out loud on voice now. |
| 4 | The Long Swim | scatter ×2, air −48 %, currents bite | You hook on with single-digit O₂ and hear applause. |
| 5 | The Throat | near-unison pings, reveal 0.75 s | Rhythm is dead. Flares, verticality, and trust. |
| 6+ | — | everything, more | Nobody has a name for it because nobody talks down here. |

Names cost nothing (one string per toast: `▼ The bell drops to level 3 — The
Choir…`) and give the crew a shared vocabulary of fear. "We died in The Throat"
is a story; "we died at level 5" is a log line.

### One number to chase

Persist a **depth record** in `localStorage` and print it on the menu and on
every wipe: *"The bell came back empty from The Throat. Deepest: level 5."*
The loop is a roguelike descent; give it the one line of meta-progression that
genre lives on — a number that only ever goes down, that you beat with the
same three friends.

---

## 4. A game, played

*Four divers. Wednesday night. Nobody has passed level 4 yet.*

**Level 0.** They hook on in blue water, four green shapes on the ring of the
hull. Lorenzo hosts; the bell holds its beat and a half, then falls. Two
point two seconds of accelerating descent — the sound drops with it — and the
stop hits like a fist. The bell shakes them off.

**Level 1.** Marie lands 70 m out with her back to everything. Standard
procedure, worked out over three sessions: *don't swim, breathe, wait for the
ping.* Amber lights her radar's left quadrant, the sound pans hard left, she
turns and swims. Somewhere off in the murk there is a second light, blinking
patiently on its own beat, and tonight everyone ignores it. Four hooked. Drop.

**Level 2.** Black water. Théo's the last one out, 90 m, and his radar lights
a quadrant that turns out to have teeth in it. He learns this at 27 metres,
when the face turns itself on — 46 metres of it — and the toast says the thing
everyone quotes in the office kitchen: **IT IS NOT THE BELL.** He sprints. It
misses by the width of a panic. On voice, three people are yelling
contradictory bearings and one of them is right.

**Level 3 — The Choir.** The pings are 7 seconds apart now and the lure has
tightened up to two seconds behind the bell. The crew adapts without being
told: Marie calls "PING" every time the true bell fires, and everyone counts
the impostor against her voice. It works — until a current takes Karim
side-on, 40 metres in nine seconds, and when the next ping comes it's in a
different quadrant than his mental map says it should be. He follows it. It's
the wrong one. The crew hears the roar through his mic before they hear it in
the water. *A diver went into the dark. Nothing came back out.*

**Level 4 — The Long Swim.** Three left; Karim rides inside something, watching
a slow black roll, listening to his friends breathe on proximity voice as they
get further away. The scatter is doubled now and the air is thin. Théo hooks
on with 9 seconds of O₂ and his breath at maximum rate; nobody says anything,
which is how you know they're impressed. The bell settles — and Karim comes to
in open water with the rest of the ejection scatter, light working, 130 m
from home, laughing.

**Level 5 — The Throat.** The two pings are almost one sound. Marie burns her
flare straight down the bearing and gets, for two seconds, the honest truth
of the water: the bell — *and*, forty metres left of it, the lure, hanging
still, waiting to be believed. "Left light's fake. LEFT LIGHT'S FAKE." Two
make it. Théo doesn't — the reveal is three-quarters of a second down here and
he was mid-sentence. Karim, last man loose, 20 % air, has the maw between him
and the hull. He goes *under* it — under the face, where its own dead eyes
can't follow — and comes up on the hull with the alarm flashing red above him
and 4 seconds of oxygen, and hooks on.

Two aboard out of four. Survivors count as a full crew. The bell drops.

**Level 6.** It takes them thirty seconds down there. The wipe screen says the
only thing it needs to: *The crew is gone. The bell goes back up empty.* And
then the line that makes them queue again instantly — **Deepest: level 6. New
record.**

---

## 5. Player stories

Short vignettes the systems above produce for free. These are the moments the
game is *for* — every design decision should be tested against whether it
creates more of these.

### The Counter
> Level 3. Aline can't see anything and has stopped trusting her radar, so she
> mutes her own doubt and just counts out loud on voice: "bell… two… three…
> fake. Bell… two… three… fake." Two other divers navigate home purely on her
> counting. She gets in last, on the beat she called herself.

*Made of:* stretched `ALARM_PERIOD` + shrinking lure offset + proximity voice.
The game never asked anyone to do this.

### The Lighthouse-Keeper
> One diver hooks on early with plenty of air and becomes ground control:
> reading the crew's quadrants off the minimap, calling the impostor's bearing
> when the flare pops, talking a friend home ping by ping. Hooked on, they're
> untouchable — the hull is real safety — so the role is *pure* generosity.

*Made of:* hull immunity + minimap quadrants + voice. Consider leaning in: the
hooked diver is stationary and safe, the ideal narrator.

### The Wrong Rescue
> Théo sees a light and swims to it to "help Marie find the bell". The light
> is not Marie. Marie, at the hull, watches his flashlight beam cross the
> black, curve toward the lure, and stop. The kindest instinct in the game is
> also the way it eats you.

*Made of:* nothing new — the decoy already selects for altruists.

### Four Seconds
> Any level past 4. The O₂ bar is red, the breathing is ragged in your own
> ears, the ping says *ahead and below*, and the arrow on the radar flips to ▼
> at the exact moment you'd decided to swim up. You hook on with a number on
> the tank you will repeat, inflated, for weeks.

*Made of:* depth-scaled O₂ drain. The stories are always about the number.

### The Underpass
> The maw holds station between the scatter and the bell — at depth its patrol
> hugs home. The crew learns the move every crew eventually learns: you don't
> go around the face, you go *under* it, close enough to see the skin. It
> never sees you. You will do this a hundred times and it will never once feel
> safe.

*Made of:* patrol-centre scaling (§3.3). Give the fish a blind spot and
players will build a ritual out of it.

### The Empty Bell
> A full wipe, but slow: the last diver alive is hooked on, alone, and the
> crew — all swallowed, all spectating on voice — realises together that one
> survivor on the hull *can still drop*. She rides the bell down solo to set
> the depth record while four ghosts scream navigation she doesn't need.

*Made of:* "survivors count as a full crew" + the depth record. The rule that
prevents deadlock also creates the best possible ending.

---

## 6. Priorities

If only three things get built, in order:

1. **Stretch the ping + tighten the lure offset** (§3.1, §3.2) — one knob each,
   and together they are the difficulty curve: navigation *and* deception both
   degrade with depth, at different rates.
2. **Depth-scaled O₂ drain** (§3.4) — turns the existing tank into the clock
   every story above runs on.
3. **Level names + depth record** (§3, end) — zero-mechanic, pure retention.
   Crews come back to beat a number, and they talk about the places they died
   because the places have names.

Everything else (§3.3 fish, §3.5 currents) is second-pass seasoning: add after
a few playtests, one knob at a time, and only where crews report levels 4–5
feeling *long* rather than *hard*.
