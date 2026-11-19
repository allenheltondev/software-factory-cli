/**
 * The password a sign-in was attempted with, held in memory only, for the confirm step of an
 * unconfirmed account (LoginForm's onNeedsConfirmation → SignUpForm's initialConfirmPassword), so
 * confirming the code can finish the sign-in.
 *
 * It must never go into router state: BrowserRouter serializes state into `window.history.state`,
 * which browsers may write to disk for session restore. Here it lives in a module variable, only
 * for the email it was given for, at most HOLD_MS, and is dropped as soon as the confirm screen
 * reads it or goes away. A reload loses it, and the person signs in after confirming instead.
 */

export const HOLD_MS = 5 * 60 * 1000;

let held: { email: string; password: string; at: number } | null = null;

export function holdPassword(email: string, password: string | undefined, now = Date.now()): void {
  held = password ? { email, password, at: now } : null;
}

/** The password held for this email (once; later calls get nothing), or undefined. */
export function takeHeldPassword(email: string | undefined, now = Date.now()): string | undefined {
  const entry = held;
  held = null;
  if (!entry || !email || entry.email !== email || now - entry.at > HOLD_MS) return undefined;
  return entry.password;
}

export function forgetHeldPassword(): void {
  held = null;
}
