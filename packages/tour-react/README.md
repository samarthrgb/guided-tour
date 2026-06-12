# @guided-tour-s4marth/react

React bindings for a data-driven product-tour system. Tours are **data** (fetched
from your backend), so you author and change them **without a deploy**. Steps
target elements by a resilient multi-signal locator + signature (no build-time
`data-tour` attributes), with runtime self-heal when the UI drifts.

Built on [driver.js](https://github.com/kamranahmedse/driver.js).

## Install

```bash
npm i @guided-tour-s4marth/react @guided-tour-s4marth/core driver.js
```

`react` / `react-dom` (>=18) are peer dependencies. Import driver.js's CSS once
in your app entry (the popover is unstyled without it):

```ts
import 'driver.js/dist/driver.css';
```

## Quick start

Wrap your app in `TourProvider`, give it a way to fetch tours, and start tours
with `useTour()`.

```tsx
import { TourProvider, useTour } from '@guided-tour-s4marth/react';
import 'driver.js/dist/driver.css';

function Root() {
  return (
    <TourProvider
      fetchTours={() => fetch('/api/tours').then(r => r.json())}
      appVersion="1.4.0"
      userContext={{ userId: currentUser.id, role: currentUser.role }}
      navigate={route => router.push(route)}          // for steps that span screens
      theme={{ primaryColor: '#6366f1' }}             // optional CSS-variable overrides
    >
      <App />
    </TourProvider>
  );
}

function PlayButton({ tourId }: { tourId: string }) {
  const { startTour } = useTour();
  return <button onClick={() => startTour(tourId)}>Take the tour</button>;
}
```

The newest unseen active **release** tour auto-plays once per session (set
`autoPlay={false}` to disable). "Seen" is tracked via a pluggable `seenStore`
(defaults to `localStorage`; pass your own to persist per-user on the backend).

## Tour data shape

`fetchTours` returns an array of tours. Minimal example:

```jsonc
{
  "id": "v1.4",
  "title": "v1.4",
  "type": "release",                 // "release" | "onboarding"
  "status": "active",
  "steps": [
    { "title": "Welcome", "body": "Here's what's new." },   // no anchorId → centered modal
    {
      "title": "Export",
      "body": "Click here to export.",
      "anchorId": "loc:{…}"          // a captured locator (see @guided-tour-s4marth/recorder)
    }
  ]
}
```

You typically don't hand-write `anchorId` — record tours with
[`@guided-tour-s4marth/recorder`](https://www.npmjs.com/package/@guided-tour-s4marth/recorder),
which captures the locator for you.

## `TourProvider` props

| Prop | Required | Description |
|---|---|---|
| `fetchTours` | ✓ | `() => Promise<unknown[]>` — your tours from the backend |
| `appVersion` | ✓ | used by version-gated conditions |
| `userContext` | ✓ | `{ userId?, role?, flags? }` for eligibility + seen |
| `navigate` | | router push, so steps can change routes |
| `waitForElement` | | `(selector, timeoutMs)` for async/modal targets |
| `seenStore` | | persistence adapter (default: `localStorage`) |
| `theme` | | `ThemeOverrides` (CSS variables) |
| `autoPlay` | | default `true` |

## `useTour()`

```ts
const { tours, eligibleTours, activeTourId, currentStepIndex, startTour, stopTour } = useTour();
```

## License

MIT
