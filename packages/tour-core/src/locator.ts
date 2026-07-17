// ─── Locator + signature ────────────────────────────────────────────────────
// A tour step targets an element by a multi-signal locator (no build-time
// data-tour anchor needed). The locator is encoded into the Step.anchorId string
// (reusing that field — no schema change): `loc:<json>`. A plain string anchorId
// is treated as a legacy data-tour / CSS selector.
//
// The `signature` captures *what* the element is (tag, role, accessible name,
// text). It serves two jobs:
//   1. detect rot — if a signal resolves to an element whose signature no longer
//      matches, that's "wrong element" rot (not silently highlighted).
//   2. self-heal — if the signals miss, find a unique element matching the
//      signature and re-bind to it (recovers from many UI refactors, no deploy).

export interface TourSignature {
  tag: string;
  role?: string;
  name?: string; // accessible name (aria-label) — optional
  text?: string; // trimmed visible text — optional
}

export interface TourLocator {
  testid?: string;
  // Ancestor-testid anchor: when the element itself has no unique testid, bind to
  // the nearest ancestor that DOES (`testid`) plus a direct-child CSS path down to
  // the element (`path`, e.g. "div:nth-of-type(2) > button"). Far more stable than
  // an absolute xpath, and keeps resolution testid-anchored.
  scope?: { testid: string; path: string };
  domId?: string;
  role?: string;
  name?: string;
  text?: string;
  xpath?: string;
  signature: TourSignature;
  // The app route the element was captured on (e.g. "/dashboards"). Metadata only
  // — resolveLocator ignores it; it lets an offline auditor know which screen to
  // load to verify this step. Optional (older locators won't have it).
  route?: string;
}

const PREFIX = 'loc:';

// Test-id attributes, in priority order. Apps differ on the convention — dg-ui
// uses BOTH `data-test` (most common) and `data-testid`. We read/resolve against
// all of them so the test-id (our strongest, most stable signal) is captured no
// matter which the app emits. A recorded `testid` value resolves against any of
// these at runtime, so older locators (assumed `data-testid`) stay compatible.
const TESTID_ATTRS = ['data-testid', 'data-test'] as const;

/** First test-id value present on the element (any supported attribute). */
function readTestId(el: Element): string | undefined {
  for (const attr of TESTID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return v;
  }
  return undefined;
}

/** A selector matching `value` on ANY supported test-id attribute. */
function testIdSelector(value: string): string {
  const v = CSS.escape(value);
  return TESTID_ATTRS.map(attr => `[${attr}="${v}"]`).join(',');
}

export function encodeLocator(loc: TourLocator): string {
  return PREFIX + JSON.stringify(loc);
}

export function decodeLocator(anchorId: string | undefined | null): TourLocator | null {
  if (!anchorId || !anchorId.startsWith(PREFIX)) return null;
  try {
    const parsed = JSON.parse(anchorId.slice(PREFIX.length)) as TourLocator;
    return parsed && parsed.signature ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveXPath(xpath: string): Element | null {
  try {
    const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return (r.singleNodeValue as Element | null) ?? null;
  } catch {
    return null;
  }
}

// ── Pseudo-XPath construction ─────────────────────────────────────────────────
// Anchors on the nearest ancestor `id` for stability across re-renders;
// otherwise uses tag:nth-of-type segments.
function xpathLiteral(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return 'concat("' + s.split('"').join('",\'"\',"') + '")';
}

export function getXPath(el: Element): string {
  const segs: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    if (node.id) {
      segs.unshift(`*[@id=${xpathLiteral(node.id)}]`);
      return '//' + segs.join('/');
    }
    const tag = node.tagName.toLowerCase();
    let i = 1;
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === node.tagName) i++;
    }
    segs.unshift(`${tag}[${i}]`);
    node = node.parentElement;
  }
  return '/' + segs.join('/');
}

// ── Ancestor-testid scope (relative path from a stable testid ancestor) ─────────
/** CSS segment for `el` among its same-tag siblings, e.g. "button:nth-of-type(2)". */
function relativeSeg(el: Element): string {
  const tag = el.tagName.toLowerCase();
  let i = 1;
  for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
    if (sib.tagName === el.tagName) i++;
  }
  return `${tag}:nth-of-type(${i})`;
}

/** Nearest ancestor (within `maxDepth`) carrying a UNIQUE test-id, plus a
 *  direct-child path from it down to `el`. null if none found / path unverifiable. */
function buildTestidScope(el: Element, maxDepth = 6): { testid: string; path: string } | null {
  const segs: string[] = [];
  let node: Element = el;
  for (let depth = 0; depth < maxDepth && node.parentElement; depth++) {
    segs.unshift(relativeSeg(node));
    const parent = node.parentElement;
    const tid = readTestId(parent);
    if (tid && document.querySelectorAll(testIdSelector(tid)).length === 1) {
      const path = segs.join(' > ');
      try {
        if (parent.querySelector(`:scope > ${path}`) === el) return { testid: tid, path };
      } catch {
        /* invalid selector — fall through */
      }
      return null;
    }
    node = parent;
  }
  return null;
}

// ── Build a multi-signal locator + signature for an element ────────────────────
// Signals (testid → id → xpath) are each verified UNIQUE before being recorded,
// so resolveLocator can trust them. The signature (tag/role/name/text) captures
// what the element *is* — used for rot detection and self-heal. Single source of
// locator construction, shared by the recorder (capture) and the health auditor
// (re-point suggestion).
export function buildLocator(el: Element): TourLocator {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') ?? undefined;
  const ariaLabel = el.getAttribute('aria-label')?.trim() || undefined;
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || undefined;

  const signature: TourSignature = { tag };
  if (role) signature.role = role;
  if (ariaLabel) signature.name = ariaLabel;
  if (text) signature.text = text;

  const loc: TourLocator = { signature };

  // testid — only if it's on the element itself AND unique in the document.
  // Reads any supported attribute (`data-testid` / `data-test`); uniqueness is
  // checked across all of them so we never bind to an ambiguous test-id.
  const testid = readTestId(el);
  if (testid && document.querySelectorAll(testIdSelector(testid)).length === 1) {
    loc.testid = testid;
  } else {
    // No own testid → anchor to the nearest ancestor testid + relative path.
    const scope = buildTestidScope(el);
    if (scope) loc.scope = scope;
  }
  // dom id — only if it actually resolves back to this element.
  if (el.id && document.getElementById(el.id) === el) loc.domId = el.id;

  // xpath — always recorded as the precise last-resort signal.
  loc.xpath = getXPath(el);

  if (role) loc.role = role;
  if (ariaLabel) loc.name = ariaLabel;
  if (text) loc.text = text;

  // Route the element was captured on — metadata for the offline auditor (which
  // screen to load). Ignored by runtime resolution.
  loc.route = location.pathname + location.search;

  return loc;
}

function accessibleName(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
}

/** True if the element plausibly *is* the signature's target. Tag must match;
 *  any provided name/text must be contained. Lenient on role (often implicit).
 *
 *  `requireText` gates whether visible text must match. When resolving via a
 *  PRECISE signal (xpath / id / testid) we pass false: that signal already
 *  pinpointed one element, and inner text on data-driven screens legitimately
 *  changes between recording and playback (counts, names, loaded rows). Holding
 *  text strict there rejects the correct element. Self-heal (a broad signature
 *  search) keeps it true, since text is what makes that search trustworthy. */
export function signatureMatches(el: Element, sig: TourSignature, requireText = true): boolean {
  if (sig.tag && el.tagName.toLowerCase() !== sig.tag.toLowerCase()) return false;
  if (requireText && sig.text) {
    const text = (el.textContent ?? '').trim().toLowerCase();
    if (!text.includes(sig.text.toLowerCase())) return false;
  }
  if (sig.name) {
    const name = accessibleName(el).toLowerCase();
    if (!name.includes(sig.name.toLowerCase())) return false;
  }
  return true;
}

function unique(nodes: ArrayLike<Element>): Element | null {
  return nodes.length === 1 ? nodes[0]! : null;
}

export type LocatorStatus = 'ok' | 'healed' | 'mismatch' | 'broken';

/** Resolve a locator against the live DOM.
 *  - ok:       a signal resolved to a unique element matching the signature
 *  - healed:   signals failed, but a unique element matches the signature
 *  - mismatch: a signal resolved a unique element, but its signature differs (rot)
 *  - broken:   nothing usable found */
export function resolveLocator(loc: TourLocator): { el: Element | null; status: LocatorStatus } {
  let sawCandidate = false;

  // Precise signals (xpath/id/testid) already pinpoint ONE element, so we don't
  // require text to still match — only the tag (+ accessible name). This keeps
  // data-driven screens (lists, charts, live counts) resolving at playback.
  const tryEl = (el: Element | null): { el: Element; status: LocatorStatus } | null => {
    if (!el) return null;
    sawCandidate = true;
    return signatureMatches(el, loc.signature, false) ? { el, status: 'ok' } : null;
  };

  // 1–5: encoded signals, each must resolve to a UNIQUE element + match signature.
  // Order is testid-first (own testid → ancestor-testid scope) then id → xpath.
  if (loc.testid) {
    const r = tryEl(unique(document.querySelectorAll(testIdSelector(loc.testid))));
    if (r) return r;
  }
  if (loc.scope) {
    const scopeEl = unique(document.querySelectorAll(testIdSelector(loc.scope.testid)));
    if (scopeEl) {
      try {
        const r = tryEl(scopeEl.querySelector(`:scope > ${loc.scope.path}`));
        if (r) return r;
      } catch {
        /* invalid selector — skip */
      }
    }
  }
  if (loc.domId) {
    const r = tryEl(document.getElementById(loc.domId));
    if (r) return r;
  }
  if (loc.xpath) {
    const r = tryEl(resolveXPath(loc.xpath));
    if (r) return r;
  }

  // 5: self-heal — a single element anywhere matching the signature.
  if (loc.signature.tag) {
    const healed = Array.from(document.getElementsByTagName(loc.signature.tag)).filter(e =>
      signatureMatches(e, loc.signature),
    );
    if (healed.length === 1) return { el: healed[0]!, status: 'healed' };
  }

  // A signal hit a unique element but the signature didn't match → wrong element.
  return { el: null, status: sawCandidate ? 'mismatch' : 'broken' };
}

/** Wait for a locator to resolve (post-navigation / async render). */
export function waitForLocator(loc: TourLocator, timeoutMs = 5000): Promise<Element | null> {
  return new Promise(resolve => {
    const now = resolveLocator(loc);
    if (now.el) {
      resolve(now.el);
      return;
    }
    const observer = new MutationObserver(() => {
      const r = resolveLocator(loc);
      if (r.el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(r.el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}
