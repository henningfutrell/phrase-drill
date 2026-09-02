# Owner checks

The standing home for checks only the owner can run, because they need their phone
and their car — this machine has neither, and no test in this repo can produce the
evidence.

## How this document works

Append-only. Each check is one `## Check N` section, dated, holding two parts in
this order:

| Part                       | Audience                     | Rule                                                                                                                                                |
| -------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Part 1 — the script**    | them                          | Copy-pasteable verbatim into a message. Numbered, imperative, one action per step, each step ending in the exact question. No file paths, no API names, no jargon. Every screen label quoted from source. |
| **Part 2 — why it exists** | the next session             | Step → inference table, the hypothesis named in this repo's terms, what is already known, and what the script deliberately does not ask.              |

A new check is a new section. Nothing here is rewritten when one is added, and a
closed check keeps its script — the script is the record of what the user was actually
asked.

Every round trip with their costs days. One check answers every open question at
once or it is not ready to send.

---

## Check 1 — 2026-08-24 — "choppy in the car"

**Status:** written, not yet sent.

**Reported:** "It seems to not work well in the car. Becomes choppy. I'm guessing
that's because it needs buffering or something. Raw streaming is too difficult /
doesn't work."

### Part 1 — the script

> Copy everything between the rules below into a message to them, unchanged.

---

Hi — six small things to try, all in one car trip, about fifteen minutes. Short
answers are all I need.

**"Fine" is a real answer and a useful one.** If something works, just write
"fine". You don't need to explain anything, and please don't try to work out why
— that's my job. Guessing wrong costs me nothing; a missing answer costs me a
week.

Where you can, use these exact words:

- **fine**
- **choppy**
- **clipped at the start**
- **breaks up in the middle**
- **no sound at all**

Do all of this **parked**, not while driving — every step needs both hands on
the phone. Please do the steps in this order: step 3 only tells me something if
step 2 came first.

**1. Music first, not the French app.**
In the car, phone connected to the car the way you always do it, play ordinary
music or a podcast for a full minute. Anything that isn't the French app.

> **Was that music or podcast fine, or was it choppy?**

**2. Now a Drill, in the car, connected as usual.**
Open the French app. On the **Decks** screen, tap the Deck you normally drill.
Tap **Drill this Deck**, then tap **Start Drill**. Let it run through at least
ten phrases.

> **Was that fine, or was it choppy?**

**3. Same Drill, same car, sound out of the phone itself.**
Stay in the car with the engine running. Open the phone's own **Settings** app
(the grey gear icon — not the Settings inside the French app), tap
**Bluetooth**, and turn the switch **off**. The car will drop out and the sound
will come from the phone's own speaker. Turn the phone's volume up.

Now run the *same* Deck again: **Drill this Deck**, then **Start Drill**, the
same ten or so phrases.

> **Coming out of the phone's own speaker, was it fine, or was it choppy?**

Then turn Bluetooth back on before you drive off.

**4. What the choppiness actually sounds like.**
This is the part only you can answer — I can't hear it from here. Reconnect to
the car and start a Drill again if you need to listen once more.

> **a.** Is the very **beginning** of each French phrase missing — as if the
> first word or syllable got swallowed — or does the sound **break up in the
> middle** of the phrase?
> **Answer: "clipped at the start" or "breaks up in the middle" (or both).**
>
> **b.** Does it get **worse the longer it runs** — the first few phrases fine
> and later ones worse — or is it the same all the way through?
> **Answer: "worse over time" or "same throughout".**
>
> **c.** During the quiet gaps between phrases, does the **car's screen** change
> at all — jumping to radio or another source, going blank, or showing nothing
> playing?
> **Answer: yes or no. If yes, what does it show?**
>
> **d.** The English line in the middle of each phrase — is it choppy too, or is
> only the French choppy?
> **Answer: "both" or "only the French" or "only the English".**

**5. Two taps — checking a fix from the 4th of August that has never been tried
on your phone.**
The thing this could go wrong as is *silence with no error message at all*, so
please do it exactly like this, and tell me even if it's boring.

1. Tap **Stop** to end the Drill. You'll land back on the Deck.
2. Tap **Drill this Deck**, then tap **Start Drill** **once**. Wait two or three
   seconds.
   > **Did the French start playing — yes, or no sound at all?**
3. Tap **Stop** again, then **Drill this Deck** again. This time tap
   **Start Drill** **twice, quickly**, one tap straight after the other, same
   spot.
   > **Did the French start playing — yes, or no sound at all?**
4. > **Did any message appear on the screen during either of those — red text,
   > or small grey text? If yes, please write it out word for word, or send me
   > a screenshot. A screenshot is easier and better.**

**6. Send me the app's own report.**
This step doesn't need the car, so do it whenever is easiest.

1. Go to the **Decks** screen (tap **Back** until you're there).
2. Tap **Settings**, top right.
3. Scroll to the bottom, to the card headed **Diagnostics**.
4. Tap **Open diagnostics**.
5. Tap **Copy report**. The word **Copied.** should appear just under the
   button.
6. Paste it into a message to me and send it.

If instead of "Copied." you get **"Couldn't copy — select and copy the text
below instead."**, don't fight it — just send me a screenshot of the block of
text on that screen.

> **Nothing to answer here — just send the report.**

That's everything. Six answers and one pasted report, and I'll know which of
three different things is wrong.

---

### Part 2 — why each step exists

**The hypothesis under test.** A Drill plays Clips that are already fully
downloaded and held on the phone; nothing streams, so "needs buffering" cannot
be the mechanism as the user framed it. The Cadence of one Phrase is four Utterance
Steps and four Pause Steps, and a Pause emits no audio at all — every Pause is
sized off the French text and clamped to 1500–5000 ms
(`PAUSE_MS_PER_CHARACTER = 65`, `PAUSE_MIN_MS`, `PAUSE_MAX_MS` in
`src/domain/cadence.ts`). At the end of each Utterance the shared audio element
is stopped and its source released. So the steady state of a Drill is 1–2 s of
audio, then 1.5–5 s of a stopped audio element, repeating, four times per Rep.

The hypothesis is that **iOS lets the phone's Bluetooth output route go idle
across that Pause, the head unit drops the stream, and re-acquiring the route
swallows the head of the next Clip** — heard as "choppy".

**This has never been observed on their device.** It is a hypothesis derived by
reading source, nothing more. No iPhone is reachable from this machine and jsdom
cannot produce this class of evidence. Step 3 is the whole reason this check
exists: it is the only step that can kill the hypothesis outright.

**Step → inference.**

| Step   | Observation                                         | If yes / choppy                                                                                      | If no / fine                                                                                                        |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **1**  | Music or podcast over the same car link             | The car link itself is bad. Nothing about this app is implicated; stop investigating the app.         | Rules out a broken car link. The link carries continuous audio fine, so a fault in step 2 is about *this* app.       |
| **2**  | A Drill over the car link                           | Reproduces their report under our own instructions — confirms the symptom exists and is repeatable.     | Not reproducible on demand. Ask what was different the day the user reported it (which Deck, how long, motorway vs town). |
| **3**  | The same Drill on the phone's own speaker           | **Kills the route hypothesis.** Choppy without Bluetooth in the path means the fault is in playback itself — decode, element reuse, or the source swap per Utterance. | **Strongest support the route hypothesis can get.** Fine on speaker + choppy over Bluetooth isolates the fault to the output route, which is exactly what a Route hold would address. |
| **4a** | Clipped at the start vs breaks up in the middle      | *Clipped at the start* — consistent with route re-acquisition eating the head of a Clip after silence. | *Breaks up in the middle* — inconsistent with route re-acquisition; points at decode or the per-Utterance source swap instead, and a Route hold would not fix it. |
| **4b** | Worse the longer it runs                            | Cumulative — thermal, memory, or leaked object URLs across many source swaps. Not the route.          | Constant from the first Rep — consistent with a per-Pause mechanism that has no memory, i.e. the route.               |
| **4c** | Car screen changes during the Pause                 | Near-direct confirmation: the head unit is being told the stream ended, which is the route going idle. | Weakens the route hypothesis without killing it — a route can be dropped below the level the head unit displays.      |
| **4d** | English choppy as well as French                    | *Both* — uniform, consistent with the route: all four Pauses are the same length, so all four Utterances are equally exposed. | *Only one language* — not the route. All four Pauses are equal, so a language-asymmetric fault has to be in the Clips themselves (generation, voice, encoding). |
| **5**  | One tap starts audio; two fast taps still start it   | Both start → the T001 unlock fix holds on their hardware, and the never-confirmed risk is closed.       | Either fails silently → the T001 unlock re-entrancy fix does **not** hold on their phone. This is the failure that produces silence with no error, so it must be asked as taps, not as "does it work?". |
| **5.4**| Any red or grey message, quoted                     | Red is the unlock failure (`--danger`); grey is a readiness block (`--ink-dim`). Either one names the real cause and ends the guessing. | No message plus no sound is the specific silent-failure mode T001 was about — a strictly worse signal than an error, and worth knowing. |
| **6**  | The Diagnostic report                               | n/a — always collected.                                                                              | Carries build sha and timestamp, pinned voice, Clips ready vs total Phrases, storage, last sync, and the last errors captured on-device. Confirms *which build* every answer above was given about. |

**What is already known, from them, on 2026-08-24.**

| Fact                                       | Value                                                              |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Phone-to-car audio path                    | Bluetooth A2DP. Not CarPlay, not a cable.                           |
| The build on their home screen               | The Render service (current `main`), not the GitHub Pages build.     |

Both were confirmed by them directly, so the script does not re-ask either. Step 6
still confirms the exact build sha, which the user has never stated and should not be
asked to.

**The T001 unlock fix step 5 verifies.** Three commits, verified with
`/usr/bin/git show`:

| Commit    | Date (author = commit) | Subject                                                                                 |
| --------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `f472af1` | 2026-08-04 16:22 -0500 | `test(T001): pin unlock() re-entrancy and AbortError handling`                            |
| `78df226` | 2026-08-04 16:24 -0500 | `fix(T001): make unlock() re-entrancy-safe and treat AbortError as interrupted, not refused` |
| `a3d6d9a` | 2026-08-04 16:26 -0500 | `merge(T001): a second Start Drill tap no longer aborts the first tap's unlock`             |

The task that commissioned this document cited the fix as 2026-08-07; the repo
says 2026-08-04 for all three. The 4th is what the script tells them, because it
is what the repo can prove. Either way it has never been confirmed on their phone.

**What this script deliberately does NOT ask.**

The user is not asked to read out any URL, build sha, or setting by hand. The
Diagnostic report carries the build sha, the build timestamp, the pinned voice,
the Clips-ready count, storage, last sync, and the recent error log — all of it,
already formatted, behind one control. Asking a non-technical user in another
country to transcribe a hex string is how a round trip gets wasted: the user
mistypes one character, or reads the wrong line, and the answer is worse than no
answer because it looks like data. One tap on **Copy report** and one paste is
strictly better than any question we could write.

The user is also not asked anything about A2DP, audio elements, buffering, or the
Pause between Clips. Step 3 gets the same information out of an action the user can
perform.

**Where the script's wording came from.** Every screen name, button label, and
quoted message in Part 1 was read out of source at `72063ff`, not recalled:

| Source read                                     | What it fixed in the script                                                                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                                   | The navigation graph: `Decks` → `Settings` → `Diagnostics`, and Deck detail → Drill.                                                                                                |
| `src/ui/DecksScreen.tsx`                        | Header `Decks`; the header actions `Mix decks…`, `Scan a page`, `Settings`, `+ New Deck`. A Deck row is the Deck's own name.                                                        |
| `src/ui/DeckDetailScreen.tsx`                   | `Drill this Deck` — the primary button, rendered only when the Deck has Phrases. `Back`.                                                                                            |
| `src/ui/DrillScreen.tsx`                        | Start card: `Start Drill`, phrase count, `Back`. Running: `Skip`, `Pause`/`Resume`/`Tap to resume`, `Stop`, `Rep N of M`. Unlock failure copy and the blocked copy (below).           |
| `src/ui/DrillScreen.css`                        | Which message is which colour: `.drill-unlock-error` is `--danger` (red), `.drill-blocked` / `.drill-warning` are `--ink-dim` (grey). That is why step 5 asks for "red or grey".      |
| `src/ui/SettingsScreen.tsx`                     | Header `Settings`; the `Diagnostics` card is the **last** section (after `Backup`, `Voice`, `Saved audio`) — hence "scroll to the bottom" — and its control is `Open diagnostics`.    |
| `src/ui/DiagnosticsScreen.tsx`                  | The one control is `Copy report`; success shows `Copied.`, failure shows `Couldn't copy — select and copy the text below instead.`                                                    |
| `src/ui/MixSelectScreen.tsx`                    | The Mix path (`Mix decks…` → `Start Drill` for one Deck, `Start Mix` for two or more). Left out of the script: one Deck is the shorter instruction and the user was drilling a Deck.       |
| `src/adapters/diagnostics/diagnostics-report.ts` | What the report contains, and that it carries counts only — never phrase text. This is what makes step 6 safe to ask for.                                                            |
| `src/adapters/diagnostics/clipboard.ts`         | The copy control reports success or failure honestly rather than throwing, so the fallback wording in step 6 is a real state and not a hypothetical.                                 |
| `src/domain/cadence.ts`                         | Four Utterance Steps, four Pause Steps, every Pause sized off the French text and clamped to 1500–5000 ms — the basis of step 4d.                                                    |
| `docs/design.md` §3.1, §3.7                     | The product's own framing of the start card and of Diagnostics.                                                                                                                     |
| `docs/glossary.md`                              | Drill, Deck, Mix, Phrase, Clip, Diagnostic report, Rep, Cadence, Step, Pause used as defined and with no synonyms.                                                                   |

**One discrepancy found while reading, recorded rather than fixed here.**
`docs/design.md` §3.1 quotes the unlock-failure copy as `Couldn't start audio on
this phone. Tap Start Drill to try again.` The shipped copy in
`src/ui/DrillScreen.tsx` is `Audio didn't start. Tap Start Drill to try again.`
followed by a small detail line carrying the error's name and message. The script
does not quote either string at them — it asks them to send the words the user sees —
but whoever reads their answer should expect the shipped wording, not the design
doc's. Fixing the design doc is out of scope for this document.

**What could not be determined from source.** Nothing about the script's
navigation or labels. How the user reaches Diagnostics is unambiguous in `App.tsx`
and `SettingsScreen.tsx` and is quoted above. What remains unknown is only what
the trip is for: the actual behaviour on their hardware.

---

## Check 2 — 2026-09-02 — "it isn't playing"

**Status:** written, not yet sent.

**Reported:** phrase-drill does not play for the user. Nothing else — no screen, no message, no build.

**What was ruled out from here first, so the script does not ask them about any
of it.** Measured 2026-09-02:

| Checked                              | Result                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| The service is up                    | `GET /` 200, `GET /api/health` `{"status":"ok"}`                                                     |
| Postgres is up and readable          | `POST /api/login` with a nonexistent user → **401 `invalid-credentials`**, not 500 — the users table was read |
| The live build                       | `/assets/index-DPoN12Or.js` carries build sha `5e5d9ae` and the string `Route hold` — the same commit as `origin/main` |
| Playback of cached Clips in that build | Driven by hand in Chromium at `5e5d9ae`: 3-Phrase Deck, clips cached, `Start Drill` → the shared element plays ~1.2 s Clips with 1.5–5 s gaps, the Route hold's second element advancing beside it, zero console errors |
| The provider                         | ElevenLabs `eleven_multilingual_v2` is current and not deprecated; status page shows August's TTS incidents all resolved, nothing open |

So the server, the database, the deployed commit and the playback path are all
working. What is left is on their phone or in the account: whether audio can be
**made** (the credential and the credit behind it), whether the Clips the user had
are still there, or whether the sound is being made and not heard.

### Part 1 — the script

> Copy everything between the rules below into a message to them, unchanged.

---

Hi — something isn't playing and I can't see your phone from here, so I need
five short answers. All of it is on the phone, none of it needs the car, and it
should take about five minutes.

**Short answers are all I need**, and "nothing happens" is a real answer. Please
don't try to work out why — that's my job.

**1. When you open the app, does it ask you to log in?**
Close the app completely first (swipe it away), then tap the icon again.

> **Does a screen with **Username** and **Password** appear before you see your
> decks — yes or no?**

**2. Tap into a deck and start a drill.**
Tap the deck you normally drill, then **Drill this Deck**. Tell me what you see
*before* you tap anything else:

> **Is there a **Start Drill** button, or is there a line of grey text instead?**
>
> - If there is grey text, **write it out word for word** (or send a
>   screenshot — easier and better).
> - If there is a **Start Drill** button, tap it once, wait five seconds, and
>   answer question 3.

**3. What does it do after you tap Start Drill?**
Pick the closest one:

> - **"no sound at all, and the screen looks stuck"** — nothing moves.
> - **"no sound at all, but the words keep changing"** — the French line and the
>   little dots move along as if it were playing.
> - **"it plays"** — you hear the French.
>
> **Also: did any message appear — red text or grey text? If yes, word for word
> or a screenshot.**

**4. Now the same drill with the sound coming out of the phone itself.**
Turn Bluetooth **off** in the phone's own **Settings** app (the grey gear icon,
not the Settings inside the French app). Turn the phone's volume up with the
side buttons, and make sure the little switch above them is **not** set to
silent. Then start the same drill again.

> **Do you hear the French now — yes or no?**

Turn Bluetooth back on afterwards.

**5. Send me the app's own report.**

1. Go to the **Decks** screen (tap **Back** until you're there).
2. Tap **Settings**, top right.
3. Scroll to the bottom, to the card headed **Diagnostics**.
4. Tap **Open diagnostics**.
5. Tap **Copy report**. The word **Copied.** should appear under the button.
6. Paste it into a message to me and send it.

If you get **"Couldn't copy — select and copy the text below instead."**, just
send me a screenshot of that block of text.

> **Nothing to answer — just send the report.**

That's everything. Five answers and one pasted report.

---

### Part 2 — why each step exists

**The three hypotheses this check separates.** All three produce "it isn't
playing" and all three need different fixes:

1. **Audio cannot be made.** `/api/tts` is refusing: a dead or rotated
   `ELEVENLABS_API_KEY`, or the provider out of credit. Every Rep then reports
   unready, the Drill is blocked, and — in the build the user is on (`5e5d9ae`) —
   the screen says *"This drill's audio isn't ready yet — it's still being made.
   Try again in a moment."* whatever the real reason. That copy is a promise the
   app cannot keep, and it is why this report arrived with no cause attached.
   Fixed on `main` (`016ebc7` RED, `f835ae4` GREEN — Generation refusal) and
   **not released**, so their build still says the old line.
2. **Audio was made and is not being heard.** The ringer switch, the volume, or
   the Bluetooth route — including the A2DP hypothesis Check 1 exists for, in
   its worst form (silence rather than choppiness), which the Route hold shipped
   unproven on 2026-08-24 and could itself cause if iOS refuses to play a second
   element beside the Clip element.
3. **The user is on the other build.** `https://<owner>.github.io/phrase-drill/`
   still answered **200 on 2026-09-02**, serving `origin/gh-pages` @ `98062b4`
   (`dist/` from `01e2869`, 202 commits behind). Its bundle
   (`/phrase-drill/assets/index-BYC2Tj_Q.js`) was fingerprinted the same day:
   **no `api/tts`, no `Log in`, no `api/library`, and a direct
   `api.elevenlabs.io` call** — the pre-server build, which needs a provider key
   *on the device* and has no server behind it. A phone on that URL can generate
   nothing at all, so its Drill blocks exactly like hypothesis 1. The user said on
   2026-08-24 that their icon is the Render build; that was nine days before this
   symptom, so it is re-asked in the cheapest possible way rather than assumed.

**Step → inference.**

| Step | Observation                                            | What it settles                                                                                                                                                     |
| ---- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | A **Username**/**Password** screen appears             | **Which build the user is on, definitively.** The Render build has a login screen (T050); the Pages build has none and opens straight on Decks. One yes/no kills hypothesis 3 either way, and no build sha has to be read aloud. |
| **2** | Grey text instead of a **Start Drill** button          | The Drill is blocked, and the words say which block: *"No voice has been chosen yet"* is the pinned voice missing (a restore or a wiped device); *"still being made"* is every unready reason including a refusal (hypothesis 1); *"isn't on this phone right now, and there's no connection"* is offline with the Clips evicted. |
| **3** | Sound vs the screen moving                             | Separates hypothesis 1 from hypothesis 2. **"No sound but the words keep changing"** is the Drill running correctly with nothing audible — the route, the ringer, or the volume, never generation, because only ready Reps enter a Drill. **"Stuck"** with no message is the unlock failure T001 was about, which produces silence with no error. |
| **4** | The same Drill on the phone's own speaker              | If the French is audible with Bluetooth out of the path, the fault is the output route and the Route hold's own question becomes the live one. If it is silent on the speaker too, nothing about the car is implicated. |
| **5** | The Diagnostic report                                  | Carries the build sha (confirms step 1 independently), the pinned voice, **Clips ready vs total Phrases**, storage used, last sync, and the last errors captured on the device — where a refusal appears verbatim as `generation unauthorized for phrase …` or `generation quota for phrase …`, and where the Route hold's `held`/`played` numbers appear. It is the one artefact that can distinguish a dead credential from an empty wallet without anyone reading a dashboard. |

**What the owner should check in parallel, off their phone.** Neither is reachable
from this machine, and either would answer hypothesis 1 outright:

1. ElevenLabs — the account's remaining character credit and whether the key is
   still valid: https://elevenlabs.io/app/settings/api-keys and
   https://elevenlabs.io/app/usage
2. Render — the `phrase-drill` service's logs, for `tts provider error` /
   `not-configured` lines and for the value of `ELEVENLABS_API_KEY` in the
   Environment tab: https://dashboard.render.com

**What this script deliberately does not ask.** No build sha, no URL, no
setting read aloud — step 5 carries all of it behind one control (Check 1's
reasoning, unchanged). Nothing about the car: this symptom is silence, not
choppiness, and Check 1 already owns the car trip. Nothing about `/api/tts`,
IndexedDB eviction, or the Route hold; steps 3 and 4 get the same information
out of actions the user can perform.

**Where the script's wording came from.** Screen names and button labels read
out of source at `f835ae4`: `src/ui/LoginScreen.tsx` (**Username**,
**Password**, **Log in**), `src/ui/DecksScreen.tsx` (**Decks**, **Settings**),
`src/ui/DeckDetailScreen.tsx` (**Drill this Deck**), `src/ui/DrillScreen.tsx`
(**Start Drill**, and all three blocked lines quoted in the table above),
`src/ui/SettingsScreen.tsx` (**Diagnostics**, **Open diagnostics**),
`src/ui/DiagnosticsScreen.tsx` (**Copy report**, **Copied.**, and the copy
failure line). The grey-vs-red distinction is `src/ui/DrillScreen.css`:
`.drill-blocked` is `--ink-dim`, `.drill-unlock-error` is `--danger`.
