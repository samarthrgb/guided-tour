# @guided-tour-s4marth/recorder

**DEV-only** click-to-record authoring overlay for the guided-tour system. Mount
it in your app (development builds only) to record tours by clicking through the
UI — it captures a resilient locator + signature per step, so the resulting tour
targets elements at runtime with no build-time `data-tour` attributes and no deploy.

Pairs with
[`@guided-tour-s4marth/react`](https://www.npmjs.com/package/@guided-tour-s4marth/react).

## Install

```bash
npm i -D @guided-tour-s4marth/recorder
```

(`@guided-tour-s4marth/core` and React >=18 are peers.)

## Usage

Render it **only in development** and hand it a `onSubmit` that persists the
recorded tour to your backend:

```tsx
import { lazy, Suspense } from 'react';

const RecorderOverlay = import.meta.env.DEV
  ? lazy(() => import('@guided-tour-s4marth/recorder').then(m => ({ default: m.RecorderOverlay })))
  : null;

{import.meta.env.DEV && RecorderOverlay && (
  <Suspense fallback={null}>
    <RecorderOverlay
      navigate={route => router.push(route)}
      onSubmit={result => saveTour(result.draft)}        // POST to your backend
      onSaveRepair={result => updateTour(result.draft)}  // PATCH existing (repair mode)
    />
  </Suspense>
)}
```

## What you get

- **Record** — a floating button opens the recorder; click targets to add steps,
  navigations/clicks between steps are captured as each step's prepare path.
- **Modal steps** — add a targetless centered-modal step (intro/outro).
- **Preview** — play the draft with the real player before submitting.
- **Repair mode** — load an existing tour (`repairTour` prop), see a live health
  badge per step, re-capture a broken step, and save — no deploy.

The overlay marks its own DOM so it never records itself.

## License

MIT
