/**
 * Maps a DOM element to its JSX source location.
 *
 * Two strategies:
 * 1. @babel/plugin-transform-react-jsx-source stamps _debugSource on fiber nodes
 *    with { fileName, lineNumber, columnNumber } in dev builds.
 * 2. React fiber traversal: walk up from the DOM node to find the owning fiber.
 *
 * This module only works in dev builds (NODE_ENV !== 'production').
 */

export interface SourceLocation {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
  componentName?: string;
}

interface ReactFiber {
  _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number };
  _debugOwner?: { name?: string; type?: { name?: string; displayName?: string } };
  type?: { name?: string; displayName?: string } | string;
  return?: ReactFiber;
  stateNode?: Node | { _reactFiber?: ReactFiber };
}

type ElementWithFiber = Element & {
  [key: string]: ReactFiber | undefined;
};

function getFiberFromElement(el: Element): ReactFiber | null {
  const domEl = el as ElementWithFiber;

  // React 17+ stores the fiber on the element with a mangled key like __reactFiber$...
  for (const key of Object.keys(domEl)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      return domEl[key] ?? null;
    }
  }
  return null;
}

function walkFiberForSource(fiber: ReactFiber): SourceLocation | null {
  let current: ReactFiber | undefined = fiber;
  while (current) {
    if (current._debugSource) {
      const componentName =
        current._debugOwner?.name ??
        (typeof current.type === 'function' || typeof current.type === 'object'
          ? (current.type as { name?: string; displayName?: string })?.displayName ??
            (current.type as { name?: string })?.name
          : undefined);

      const loc: SourceLocation = {
        fileName: current._debugSource.fileName,
        lineNumber: current._debugSource.lineNumber,
      };
      if (current._debugSource.columnNumber !== undefined) loc.columnNumber = current._debugSource.columnNumber;
      if (componentName) loc.componentName = componentName;
      return loc;
    }
    current = current.return;
  }
  return null;
}

export function getSourceLocation(el: Element): SourceLocation | null {
  if (typeof process !== 'undefined' && process.env['NODE_ENV'] === 'production') {
    console.warn('[tour-recorder] Source mapping is not available in production builds.');
    return null;
  }

  const fiber = getFiberFromElement(el);
  if (!fiber) return null;

  return walkFiberForSource(fiber);
}
