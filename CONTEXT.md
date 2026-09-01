# Secure Notes

A single-context app for private, versioned notes with auditable, rate-limited authentication. The terms below are the shared language for tickets, discussion, code, tests, and docs (PRD §22).

## Language

### Notes

**Note**:
A private document containing a title and content, owned by exactly one user. No sharing exists in this product.
_Avoid_: document, item, record

**Note version**:
A saved state of a note — its title and content exactly as a save landed — captured after the update. A version is captured when the user pauses editing for ~10 seconds or finishes an editing session, if the saved state differs from the most recent version; identical saves never create one. The version history is separate from the Audit log: it answers "what did the note say", not "who did what" (PRD §7). Restoring one appends to history rather than overwriting it.
Restoring a version replaces the note's content and appends a new version — history is never rewritten or deleted.
_Avoid_: revision, history entry, backup, checkpoint log

**Autosave**:
The client mechanism that persists note edits automatically while the user works, surfacing saving / saved / save-failed states. It must never silently discard work, and it must not flood history with a new Note version per keystroke.
_Avoid_: draft, buffer, manual save

**Ownership-scoped query**:
A query that always filters by the authenticated user's id, so knowing a resource id alone never grants access. The default pattern for all Note and Note version reads and writes.
_Avoid_: lookup by id, permission check bolted on after the fact

### Authentication

**Authenticated session**:
A logged-in identity: an opaque token held by the browser that maps server-side to exactly one user, valid until logout or a fixed expiry. Logout and expiry must both revoke access. A session may be pending two-factor verification — it authenticates only for the challenge, never for the user's data.
_Avoid_: login (that is the act of creating one), user account, JWT

**Pending session**:
A session created after a correct password on a two-factor-enabled account: it exists only to carry the user to the Two-factor challenge and is rejected everywhere else. Cleared by a successful challenge; destroyed by logout or expiry.
_Avoid_: half-login, pre-auth session, unverified session

**Two-factor challenge**:
The sign-in step where a user with TOTP enabled must prove possession of their authenticator app or a recovery code before their Pending session is activated into a full Authenticated session. Rate-limited with the same budget as code verification, replay-protected, and audited. Distinct from two-factor authentication, the broader capability of enabling and managing TOTP.
_Avoid_: 2FA prompt, OTP, MFA

**Recovery code**:
A single-use, randomly generated alternative to the authenticator code, issued once when two-factor authentication is activated and shown exactly once. Stored only as a sha256 hash (high-entropy random code — not a password), consumed atomically so it can never be spent twice, never logged, never retrievable after dismissal.
_Avoid_: backup code, one-time password, master key

### Security infrastructure

**Audit event**:
A single record of security-relevant activity answering what happened, when, which user, and which resource. Named `<entity>.<event>` per AGENTS.md; never contains secrets, tokens, or passwords.
_Avoid_: "audit log" for a single event — the log is the whole collection

**Rate limit window**:
A fixed wall-clock interval per key (IP+email for login, user id for code verification) during which attempts count against a threshold; the counter starts once and is never extended mid-window. Login and registration fail OPEN when the store is unreachable (the core journey stays available); code-verification limiters fail CLOSED (a brute-force guard must not vanish with its store).
_Avoid_: throttle, cooldown, sliding window
