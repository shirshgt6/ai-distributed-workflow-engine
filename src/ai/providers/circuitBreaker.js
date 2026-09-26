/**
 * CIRCUIT BREAKER for one provider (in-process, per worker).
 *
 *   CLOSED ──(failureThreshold failures in a row)──► OPEN
 *     ▲                                               │ (cooldownMs passes)
 *     └──(trial call succeeds)── HALF_OPEN ◄──────────┘
 *                                   │ (trial call fails) ──► OPEN again
 *
 * While OPEN, calls are refused instantly instead of waiting for yet another
 * 60 s timeout from a provider we already know is down. That protects our own
 * workers (no threads stuck waiting) and gives the provider room to recover
 * (we stop hammering it). It's the "retry storm" lesson from Phase 8, applied
 * to dependencies.
 *
 * Per-process state means each worker learns about an outage on its own;
 * that's simpler than sharing state in Redis and good enough here.
 */
export function createCircuitBreaker({ failureThreshold = 3, cooldownMs = 30_000, now = () => Date.now() } = {}) {
  let state = "CLOSED";
  let failures = 0;
  let openedAt = 0;
  let trialInFlight = false;

  return {
    /** May a call go through right now? (Moves OPEN -> HALF_OPEN when the cooldown is over.) */
    allow() {
      if (state === "OPEN" && now() - openedAt >= cooldownMs) {
        state = "HALF_OPEN";
        trialInFlight = false;
      }
      if (state === "CLOSED") return true;
      if (state === "HALF_OPEN" && !trialInFlight) {
        trialInFlight = true; // exactly one trial call probes recovery
        return true;
      }
      return false;
    },
    success() {
      state = "CLOSED";
      failures = 0;
      trialInFlight = false;
    },
    failure() {
      failures += 1;
      trialInFlight = false;
      if (state === "HALF_OPEN" || failures >= failureThreshold) {
        state = "OPEN";
        openedAt = now();
      }
    },
    get state() {
      if (state === "OPEN" && now() - openedAt >= cooldownMs) return "HALF_OPEN";
      return state;
    },
  };
}
