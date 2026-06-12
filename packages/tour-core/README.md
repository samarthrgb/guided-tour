# @guided-tour-s4marth/core

Framework-agnostic runtime for a data-driven product-tour system. This is the
low-level engine — **most apps should use
[`@guided-tour-s4marth/react`](https://www.npmjs.com/package/@guided-tour-s4marth/react)**,
which wraps this with a `TourProvider` + `useTour()`.

Use `core` directly if you're integrating with a non-React app or building your
own bindings.

## Install

```bash
npm i @guided-tour-s4marth/core driver.js
```

Import driver.js's CSS once in your app entry: `import 'driver.js/dist/driver.css'`.

## What's inside

- **`playTour(opts)`** — plays a tour: runs each step's prepare path, resolves the
  target, animates the spotlight (single persistent driver.js instance), handles
  next/skip/close, emits telemetry.
- **Locator + signature targeting** (`locator.ts`) — `buildLocator(el)` (capture),
  `resolveLocator(loc)` (runtime, with self-heal), `encode/decodeLocator`,
  `getXPath`, `signatureMatches`, `waitForLocator`. A locator is encoded into a
  step's `anchorId` as `loc:<json>`; resolution tries `testid → domId → xpath`,
  then self-heals to a unique element matching the signature.
- **`parseTour` / `parseTours`** — zod-validate tour data.
- **`isTourEligible`** — evaluate route/role/version/flag conditions.
- **`SeenStore`** adapters + **telemetry** (`setTelemetryHandler`).

## Minimal usage

```ts
import { parseTours, playTour } from '@guided-tour-s4marth/core';
import 'driver.js/dist/driver.css';

const tours = parseTours(await fetch('/api/tours').then(r => r.json()));
await playTour({
  tour: tours[0],
  navigate: route => router.push(route),
  onComplete: () => markSeen(tours[0].id),
});
```

A step with no `anchorId` renders as a centered modal. Broken/missing targets are
skipped at runtime; if every step is missing, `onUnavailable` fires and the tour
isn't marked complete.

## License

MIT
