/**
 * Suppresses one specific, verified-benign warning from @x402/extensions.
 *
 * The bazaar extension validates route extensions with AJV, which compiles
 * validators via `new Function`. Workers forbids that, so validation cannot
 * run and the library warns for every route -- each warning carrying a full
 * generated-validator dump. It is emitted once per isolate, and isolates
 * churn constantly.
 *
 * This is cosmetic: the payment-required header still carries the complete
 * bazaar extension, which is why discovery and the Bazaar listing work. It is
 * worth suppressing anyway, because we now depend on Workers Logs to surface
 * a buyer signal. A flood of benign dumps burns observability quota and
 * buries the one line that would tell us someone finally tried to pay.
 *
 * Deliberately narrow: only the AJV code-generation cause is dropped. A
 * bazaar extension that is genuinely malformed produces a different error and
 * still reaches the log, because that one would mean discovery is broken and
 * is exactly the warning we would need to see.
 */

const BAZAAR_WARNING = "has an invalid bazaar extension";
const AJV_CAUSE = "Code generation from strings disallowed";

let installed = false;
let suppressed = 0;

export function isBenignBazaarWarning(args: unknown[]): boolean {
  const text = args
    .map((a) => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ");
  return text.includes(BAZAAR_WARNING) && text.includes(AJV_CAUSE);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Installs the filter once per isolate. Safe to call on every request.
 */
export function suppressBazaarSchemaNoise(): void {
  if (installed) return;
  installed = true;

  const original = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (isBenignBazaarWarning(args)) {
      // Report the suppression once, so this stays discoverable rather than
      // becoming a silent edit to the logs.
      if (suppressed === 0) {
        original(
          "x402: suppressing the AJV bazaar-extension warning (cannot compile " +
            "validators in Workers; discovery is unaffected -- see log-noise.ts)",
        );
      }
      suppressed++;
      return;
    }
    original(...args);
  };
}

export function suppressedWarningCount(): number {
  return suppressed;
}
