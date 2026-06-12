# guided-tour

A reusable, **data-driven product-tour system**. Tours live as data (in your
backend), so non-technical authors record and publish them **without a deploy**.
Steps target elements by a resilient multi-signal locator + signature — no
build-time `data-tour` attributes — with runtime self-heal when the UI drifts.

Built on [driver.js](https://github.com/kamranahmedse/driver.js).

## Packages

| Package | What it is |
|---|---|
| [`@guided-tour-s4marth/core`](packages/tour-core) | framework-agnostic runtime (player, locator+signature, schema, telemetry) |
| [`@guided-tour-s4marth/react`](packages/tour-react) | React bindings — `TourProvider` + `useTour()` (start here) |
| [`@guided-tour-s4marth/recorder`](packages/tour-recorder) | DEV-only click-to-record authoring overlay |

## Quick start (React)

```bash
npm i @guided-tour-s4marth/react @guided-tour-s4marth/core driver.js
```

```tsx
import { TourProvider, useTour } from '@guided-tour-s4marth/react';
import 'driver.js/dist/driver.css';

<TourProvider fetchTours={() => fetch('/api/tours').then(r => r.json())} appVersion="1.0.0" userContext={{ userId }}>
  <App />
</TourProvider>
```

See [`packages/tour-react`](packages/tour-react) for the full setup.

## Why locator + signature?

A step records several ways to find its element (`testid → id → xpath`) plus a
*signature* of what the element is (tag/role/name/text). At runtime the resolver
tries each signal, and if they all miss it **self-heals** to the unique element
matching the signature. This survives most UI refactors and lets tours publish as
pure data. Full design notes: **[GUIDED-TOUR.md](GUIDED-TOUR.md)**.

## Develop

```bash
pnpm install
pnpm -r build      # build all packages
pnpm -r test       # run tests
```

Monorepo: pnpm workspaces + turbo. ESM-only, TypeScript.

## License

MIT
