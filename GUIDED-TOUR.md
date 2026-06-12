# Guided Tours — System Design & Operations Guide

> A reusable, data-driven product-tour system for DataGenie. Non-technical authors
> record tours by clicking through the app; tours publish to the backend and work
> **immediately, with no code change or deploy**; broken tours are detected by a
> Claude skill after each release and fixed as data.

---

## 1. The problem we set out to solve

DataGenie's release tours were hand-wired per release. Every tour meant:

1. An engineer adds `data-tour="..."` attributes to the right elements.
2. Someone writes the tour steps in code.
3. It ships in the next **release** of the UI app.

Two pain points dominated:

- **Re-release for every change.** A new tour, a moved element, or a typo fix needed a UI deploy. Authoring was gated on engineering + release cadence.
- **Silent rot.** When the UI changed, a tour's target vanished and the tour broke with no signal — discovered only when a user hit it.

**Goal:** let non-technical people author and publish tours without a deploy, make tours resilient to UI change, and detect breakage proactively.

---

## 2. Core principle

> **Code owns the contract. Data owns the content.**

- **Content** (which steps, what text, what order, conditions) lives in the **backend database** — editable without touching code.
- **Contract** (how a step finds its element on screen) is captured as a **portable locator** stored *with* the content — so no build-time coupling between a tour and the code.

The payoff: a tour is pure data. Publish it → it runs. Change it → it runs. No deploy in the loop.

---

## 3. Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  LIBRARY  (monorepo: /guided-tour, consumed by dg-ui via @guided-tour-s4marth/*) │
│                                                                       │
│  @guided-tour-s4marth/core      schema · locator+signature · player · telemetry      │
│  @guided-tour-s4marth/react     <TourProvider> · useTour()                           │
│  @guided-tour-s4marth/recorder  DEV overlay: record · repair · preview               │
└───────────────▲───────────────────────────────────────▲──────────────┘
                │ fetch tours / mark seen / publish       │ authoring
                │                                          │
┌───────────────┴──────────────┐         ┌────────────────┴─────────────┐
│  BACKEND  (dg-backend)        │         │  HOST APP  (dg-ui)            │
│  FastAPI + SQLModel           │         │  TourProvider in layout       │
│  guided_tours table (content) │         │  ReleaseNotesPanel (play UI)  │
│  guided_tour_seen table       │         │  RecorderOverlay (dev)        │
│  GET/POST/PATCH /guided-tours │         │  guidedTours RTK service      │
└───────────────────────────────┘         └──────────────────────────────┘
                                                          ▲
                                                          │ post-release audit
                                           ┌──────────────┴───────────────┐
                                           │  CLAUDE SKILL (dg-ui)         │
                                           │  .claude/skills/guided-tour/  │
                                           │  Playwright + real resolver   │
                                           │  → report + re-point fixes    │
                                           └───────────────────────────────┘
```

Three responsibilities, cleanly separated:

| Layer | Owns | Notes |
|---|---|---|
| **Library** | authoring + runtime | deterministic; never depends on Claude |
| **Backend** | storage of tours + per-user "seen" | tours are opaque JSON; no schema coupling to the UI |
| **Claude skill** | post-release health audit + fix proposals | judgment work; runs on demand, not at runtime |

---

## 4. The heart of it: locator + signature targeting

This is the key idea that unlocks "no deploy."

### 4.1 What a step targets

Instead of a build-time `data-tour` anchor, each step stores a **multi-signal locator + signature**, encoded into the existing `Step.anchorId` string as `loc:<json>` (so **no schema change** was needed):

```jsonc
{
  "testid": "kpi-card",            // optional — a unique data-testid (most stable)
  "domId":  "export-btn",          // optional — element id
  "xpath":  "//*[@id=\"root\"]/…", // always present — precise last-resort signal
  "signature": {                   // WHAT the element is
    "tag":  "button",
    "role": "button",
    "name": "Export",              // accessible name (aria-label)
    "text": "Export"               // trimmed visible text
  },
  "route": "/dashboards"           // screen it was captured on (audit metadata)
}
```

A plain (non-`loc:`) string is treated as a **legacy `data-tour`** selector, so old data still works.

### 4.2 How it resolves at runtime (`resolveLocator`)

Order matters — strongest signal first, each must resolve to a **unique** element **and** match the signature:

1. `testid` → 2. `domId` → 3. `xpath`
4. **Self-heal:** if all signals miss, find the *single* element anywhere that matches the signature and bind to it.

It returns one of four statuses:

| Status | Meaning | Runtime behavior |
|---|---|---|
| `ok` | a signal hit a unique element matching the signature | show the step |
| `healed` | signals missed, but a unique signature match was found | show it (drift auto-recovered) |
| `mismatch` | a signal hit a unique element, but its signature differs | **skip** (wrong element — don't highlight) |
| `broken` | nothing usable found | **skip** |

### 4.3 Why this is good

- **No build-time anchor.** Authors target *any* element; engineers don't pre-bless a vocabulary.
- **No deploy.** The locator travels with the tour data → publish and it runs.
- **Resilient.** Multiple signals + signature means small refactors (a wrapper div added, a class renamed, an element moved) usually still resolve, and **self-heal** recovers many cases automatically.
- **Honest about rot.** The signature distinguishes "moved" (healed) from "wrong element" (mismatch) from "gone" (broken) — instead of silently highlighting the wrong thing.
- **Single source of truth.** `buildLocator` (capture) and `resolveLocator` (runtime) both live in `@guided-tour-s4marth/core/src/locator.ts`, and the audit injects that *same* built module — so capture, runtime, and audit can never drift apart.

> **Trade-off / caveat:** the locator is only as strong as its signals. A stable `data-testid` is ideal (greppable, refactor-proof). When a target has none, capture falls back to `xpath` + a `text`/`tag` signature, which is more fragile (sensitive to copy changes and DOM restructuring). **Recommendation: prefer targets with a `data-testid`.** The more testid-anchored your tours, the stronger both self-heal and the audit.

---

## 5. How we eliminated the re-release cycle

**Old flow (deploy-gated):**

```
record → "gap" found → ClickUp ticket → engineer adds data-tour → PR → review → RELEASE → tour works
```

**New flow (data-only):**

```
record (locator captured live) → Submit → saved to backend → tour works on next page load
```

Because targeting is data, there are **no gaps** to fill in code. The recorder captures a working locator at record time; publishing writes it to the backend; the next user to load the app fetches it and it runs. The engineering + release step is gone from the authoring loop entirely.

The **only** time code changes is when the *right* fix is genuinely in the UI (e.g. an element that should have a `data-testid` and doesn't) — and even then it's an optional improvement, not a blocker.

---

## 6. The packages (library)

### `@guided-tour-s4marth/core` — the engine (framework-agnostic)
- **`schema.ts`** — zod schema for `Tour` / `Step` / `Condition` / `ThemeOverrides`. `anchorId` is optional (a step with none is a **centered modal**).
- **`locator.ts`** — `buildLocator` (capture), `resolveLocator` (runtime, with self-heal), `getXPath`, `signatureMatches`, `encode/decodeLocator`, `waitForLocator`. *The single source for targeting.*
- **`player.ts`** — `playTour()`: drives driver.js, runs each step's prepare path, resolves the target, animates, handles next/skip/close, emits telemetry.
- **`conditions.ts`** — eligibility rules (audience/version gating).
- **`persistence.ts`** — `SeenStore` interface + adapters.
- **`telemetry.ts`** — `setTelemetryHandler` + the event union; `PREVIEW_TOUR_ID` sentinel.

### `@guided-tour-s4marth/react` — the binding
- **`TourProvider`** — fetches tours, evaluates eligibility, runs autoplay, exposes `startTour`/`stopTour`.
- **`useTour()`** — `{ tours, startTour, ... }` for the host UI.

### `@guided-tour-s4marth/recorder` — DEV-only authoring overlay
- Click-to-capture steps (builds a locator per click), step tiles, **Preview** (plays the draft via the real player), **Submit**.
- **Repair mode** — load an existing tour, per-step live health badge, re-capture a broken step, **Save**.
- **Floating/modal steps**, **feature-tour** grouping (see §9.3), all marked `data-tour-recorder` so capture never targets the recorder's own UI.

> **Removed during the pivot:** `@tour/registry-plugin` (anchor scanner), `@tour/codemod` (data-tour injector + PR opener), `@tour/vite-plugin`, and the static CI rot-check. The locator model made all of them unnecessary.

---

## 7. The backend (dg-backend)

FastAPI + SQLModel. Tours are stored as **opaque JSON** — the backend never parses step internals, so the locator model needs no migration.

**Tables**
- `guided_tours` — `id, title, type, version, status, conditions, theme, steps(JSON), created_by, created_at, updated_at`
- `guided_tour_seen` — `(user_id, tour_id, seen_at)` — per-user "seen" ledger

**Endpoints** (under `/api/backend-service/guided-tours`)
- `GET /` (`?userId=`) — list active tours; computes per-user `seen` + `autoplay`
- `GET /{id}` — one tour
- `POST /` — upsert (the backend **generates the UUID id** — the UI never sends one)
- `PATCH /{id}` — partial update (used by repair save and archive)
- `POST /seen` — mark a tour seen for a user

**Seen / autoplay logic** (computed server-side on list):
- Only the **single newest active release tour** can autoplay, and only if the user hasn't seen it. No fallback to older tours.
- A tour is marked seen on **complete OR skip**. If *every* step's target was missing (`tour.unavailable`), it is **not** marked seen — so it can show once fixed.

---

## 8. Runtime flow (playing a tour)

```
TourProvider mounts
  └─ fetchTours()  ──────────────► GET /guided-tours?userId=…
  └─ compute eligible + autoplay (newest unseen active release)
        └─ playTour(tour)
             for each step i:
               1. runPrepare()    → navigate / click / wait  (reach the screen, open modals)
               2. waitForLocator() → wait for the target to appear (longer after a navigation)
               3. resolveLocator() → ok | healed | mismatch | broken
                    • broken/mismatch → record missing, SKIP step
               4. driverObj.highlight({element, popover})  → animated move + smooth-scroll
               5. await user action → next | skip | close
             end
        └─ complete → markSeen ;  all-missing → onUnavailable (NOT seen)
```

**Smooth transitions.** The player keeps **one persistent driver.js instance** for the whole tour and calls `highlight()` per step, so driver.js *animates the spotlight gliding* from one element to the next (and smooth-scrolls it into view). Earlier we created a new instance per step, which tore the overlay down and rebuilt it — that's the "vanish, then pop back" we fixed. (Cross-route steps can't tween across a navigation, so those re-anchor cleanly rather than glide — an accepted limit.)

**Theming.** A polished default stylesheet is always injected; the host passes `DG_TOUR_THEME` (CSS variables only) to match the design system. No `backdrop-filter: blur()` (it blurs the highlighted cutout).

**Telemetry.** `tour.started/completed/skipped/unavailable`, `step.viewed`, and `anchor.healed/mismatch/broken/fallback`. The host wires a handler; today it just logs broken anchors (health detection is the skill, not telemetry — see §10).

---

## 9. Authoring flow (the recorder)

### 9.1 Record → review → submit
1. Open the recorder (the ⏺ floating button, DEV only), name the tour (the title — see §9.3).
2. **+ Capture element** → click the target. The recorder builds a unique locator + signature and shows a readable label.
3. Add title/body/placement; repeat. Navigations and prep-clicks between steps are recorded as the step's **prepare path**.
4. **+ Modal step** adds a targetless centered-modal step (intro/outro banner).
5. **Done → Preview** plays the draft with the real player (tagged `PREVIEW_TOUR_ID` so it never pollutes telemetry).
6. **Submit** → `upsertTour` → saved to the backend (UUID generated server-side). It appears in Release Notes immediately.

### 9.2 Repair mode
The 🔧 icon on a tour (DEV) opens the recorder **preloaded** with that tour. Each step shows a live health badge for the current screen; re-capture a broken step with ⟳, then **Save repairs** → `PATCH` the tour's steps by its real id. Fix takes effect with no deploy.

### 9.3 Feature tours under a release (title convention)
The library stays generic — grouping is a **host-side convention on `title`**:
- main release tour → `title = "v4.14"`
- feature tour → `title = "v4.14-<feature>"` (e.g. `v4.14-knowledge-center`)

`ReleaseNotesPanel` matches the main tour by `title === version` and renders feature tours as small pills under it. No schema field carries this — only the title.

---

## 10. Health detection — the journey and the decision

We deliberately explored and **rejected** several approaches before landing on the Claude skill. This section documents *why*, because it's the most-asked question.

### 10.1 What we tried and dropped
- **Runtime health subsystem** (a `health` column + `POST /health` endpoint + per-play telemetry reporting + a navigating "probe" button). Built it, then **reverted it** — too much surface area, it caused refetch storms, and the navigating probe yanked the app and fired every page's APIs.
- **Naive ambient client check** ("resolve every step against the current page"). Rejected because it **false-alarms**: a multi-screen tour would look broken just because the other screens' steps aren't in the current DOM. (A step must only be judged on *its own* screen.)
- **Static CI grep / "virtual DOM" from source.** Useful only for token presence; can't faithfully resolve `xpath`/structure without a real render, and can't catch "wrong element."

### 10.2 What we shipped: a Claude skill
Health is checked **after each release** by a Claude Code skill in `dg-ui/.claude/skills/guided-tour/`, not at runtime. It renders the app for real and runs the *exact* runtime resolver:

```
fetch tours  →  headless Playwright  →  for each step: go to its route, replay prepare,
                inject @guided-tour-s4marth/core's BUILT resolveLocator/buildLocator, classify
             →  report (ok/healed/mismatch/broken)  →  propose fixes  →  human approves
```

Why this is the right fit:
- **"Does this element still exist?" is fuzzy judgment** — an LLM does it well (follows imports, sees a renamed testid vs a removed one), where a rigid script does poorly.
- **Audit == runtime.** It injects `@guided-tour-s4marth/core`'s built `dist/locator.js` and runs the real functions — the report matches what the player would actually do, by construction. Nothing to keep in sync.
- **Off the runtime path.** No column, no endpoint, no probe, no per-play writes. It's a periodic, on-demand audit.

### 10.3 Fix policy
- **Default = re-point the tour (data, no deploy).** When an element moved/renamed and a unique signature match exists, the audit builds a fresh locator (same `buildLocator` the recorder uses) and proposes `PATCH`-ing that step's `anchorId`.
- **Code PR only when the UI is at fault** (a `data-testid` that should exist was dropped).
- **Never auto-apply** — report and propose; a human approves each fix.

### 10.4 The honest limits
- A step is only verifiable **where it renders** — multi-route tours navigate during the audit; auth/data-gated or dynamic screens may be **uncertain** (never reported as broken).
- It's a point-in-time audit, not live monitoring. (Runtime still degrades gracefully on its own — see §11.)

---

## 11. What happens when a tour *is* broken (runtime safety net)

No health system is needed for safety: at runtime a broken step's target simply fails to resolve and that **step is skipped**, the tour continues. If **every** step's target is missing, the tour reports `unavailable` and is **not** marked seen (so it reappears once fixed). Breakage degrades quietly; the audit makes it *visible*.

---

## 12. Using it end-to-end in DataGenie

### 12.1 One-time wiring (already done in dg-ui)
- `<TourProvider>` in `src/layout/index.jsx` with `fetchTours`, `appVersion`, `userContext`, an inline `seenStore` (RTK `markTourSeen`), `navigate`, `waitForElement`, and `DG_TOUR_THEME`.
- `<RecorderOverlay>` (DEV only, lazy) with `onSubmit` (→ `upsertTour`), `onSaveRepair` (→ `PATCH`), `repairTour`/`onRepairConsumed`.
- `<ReleaseNotesPanel>` — Play/Replay, dev-only Archive (🗄) and Repair (🔧) icons.
- `guidedTours.service.ts` — RTK Query against `/api/backend-service`.

### 12.2 Author & publish a tour (no deploy)
1. Run dev app (`:3000`), open the recorder (⏺).
2. Title it `v4.14` (or `v4.14-<feature>`), capture steps, add a `+ Modal step` intro if desired.
3. **Preview** to sanity-check.
4. **Submit** → it's in the backend and shows in Release Notes immediately.

### 12.3 Users experience it
- The newest unseen active release **autoplays once per session**; otherwise users replay from Release Notes. Seen state is per-user.

### 12.4 After a release — run the health audit
In dg-ui (dev server up on `:3000`):
```bash
node .claude/skills/guided-tour/login.mjs   # opens a browser → log in → captures token to .auth/token.txt
node .claude/skills/guided-tour/audit.mjs   # renders each step, reports health + re-point suggestions
```
Or open Claude Code in dg-ui and say **"run the guided-tour skill"**.

### 12.5 Fix broken tours
- **Re-point** (most cases): apply the suggested new locator → `PATCH` the tour. No deploy.
- **Code PR** (UI regressions): add back the missing `data-testid`.
- Or just open the tour in **Repair mode** and re-capture the broken step.

---

## 13. Design decisions & rationale (why we chose what)

| Decision | Why |
|---|---|
| Locator+signature in `anchorId` (not a schema field) | zero migration; old `data-tour` strings still work as legacy |
| Multi-signal + self-heal | survives most refactors; recovers drift with no human action |
| Signature for rot detection | distinguishes moved / wrong-element / gone — no silent mis-highlight |
| Tours in backend, not code | publish/edit without a deploy — the whole point |
| Backend generates the id (UUID) | UI never owns identity; avoids title-as-id coupling |
| One persistent driver.js instance | smooth animated step transitions instead of vanish/rebuild |
| Health = Claude skill, not runtime | fuzzy judgment fits an LLM; keeps the runtime path clean; no DB/endpoint surface |
| Audit injects the *built* core locator | audit == runtime, single source, nothing to keep in sync |
| Default fix = re-point (data) | matches the no-deploy philosophy; code PR only for true UI faults |
| `dev_bearer_token` for headless auth | the app's own E2E path; cookie storage-state fails headless |
| Feature tours via title convention | keeps the library generic; grouping is a host concern |

---

## 14. Answered questions & caveats

- **Will a locator always be unique?** Not guaranteed — that's why each signal is *uniqueness-checked* at capture and resolve time, and self-heal only binds when the signature match is unique. Non-unique → it falls through to the next signal or reports `broken`/`mismatch` rather than guessing.
- **Dynamic ids / interpolated testids / i18n text?** These weaken the signals; capture still records `xpath` + signature. The audit marks such steps **uncertain**, not broken. Prefer stable `data-testid`.
- **Is `xpath` fragile?** Yes — it's the last-resort signal and breaks on DOM restructuring. It's why testid/id come first and signature self-heal exists.
- **Re-submitting the same tour?** Creates a *new* tour (new UUID) — Submit is always a create. Editing an existing tour goes through **Repair** (PATCH). (A "submit = upsert by title" is a possible future add.)
- **Placement on a modal step?** Ignored — a targetless step always centers; the placement dropdown is a no-op there.
- **Cross-route health without navigating?** Impossible — a step is only verifiable where it renders. The audit navigates; that's inherent.
- **Token expiry during audit?** Access tokens are short-lived — run `audit.mjs` promptly after `login.mjs`.
- **Known build wart:** dg-ui's `tsc` type-checks the *aliased recorder source* and emits ~21 `CSSProperties` cross-repo csstype-skew errors. They're pre-existing and inline-style only; the recorder builds clean under its own tsconfig. Filter them: `npx tsc --noEmit | grep -v RecorderOverlay`.
- **`exactOptionalPropertyTypes: true`** is on across the library — assign optional props conditionally (`if (x) o.x = x`), never spread `| undefined`.

---

## 15. Parked ideas (not built, on the table)
- **Version-stamp** — store the app version a tour was verified against; show "verified vs needs re-check after update" for a near-free proactive signal.
- **CI token scan** — a `tour:check` that greps the source for each step's stable token at PR time (catches removed/renamed testids before deploy). Strong only with testid-heavy tours.
- **Testid-first capture** — nudge the recorder to prefer a `data-testid` target, strengthening self-heal, the audit, and the CI scan at once.

---

## 16. File map

```
guided-tour/ (library monorepo)
  packages/tour-core/src/    schema.ts · locator.ts · player.ts · conditions.ts
                             persistence.ts · telemetry.ts · index.ts
  packages/tour-react/src/   TourProvider.tsx · useTour.ts · ReleaseSidebar.tsx
  packages/tour-recorder/src/overlay/RecorderOverlay.tsx · export.ts · capture.ts

dg-repos/ui-app/ (host)
  src/layout/index.jsx                              TourProvider + recorder wiring
  src/components/ReleaseNotes/ReleaseNotesPanel/    play / replay / archive / repair UI
  src/services/guidedTours.service.ts               RTK Query client
  .claude/skills/guided-tour/  SKILL.md · audit.mjs · login.mjs   (health audit)

dg-repos/dg-backend/ (backend)
  backend_service/api/guided_tour.py                routes
  backend_service/services/guided_tour.py           seen/autoplay logic
  backend_service/models/{base,tables,request,response}/guided_tour*.py
```

---

*Build: `pnpm -r build` (library). Typecheck host: `npx tsc --noEmit | grep -v RecorderOverlay`.*
