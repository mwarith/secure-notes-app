# Secure Notes

A single-context app for private, versioned notes with auditable, rate-limited authentication. The terms below are the shared language for tickets, discussion, code, tests, and docs (PRD §22).

## Language

### Notes

**Note**:
A private document containing a title and content, owned by exactly one user. No sharing exists in this product.
_Avoid_: document, item, record

**Note version**:
A saved state of a note — its title and content exactly as a save landed — captured after the update. Any save that differs exactly from the most recent version creates one, throttled to at most once per minute; identical saves never do. The version history is separate from the Audit log: it answers "what did the note say", not "who did what" (PRD §7). Restoring one appends to history rather than overwriting it.
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
A logged-in identity: an opaque token held by the browser that maps server-side to exactly one user, valid until logout or a fixed expiry. Logout and expiry must both revoke access.
_Avoid_: login (that is the act of creating one), user account, JWT

**Two-factor challenge**:
The sign-in step where a user with TOTP enabled must prove possession of their authenticator app or a recovery code before an Authenticated session is created. Distinct from two-factor authentication, the broader capability of enabling and managing TOTP.
_Avoid_: 2FA prompt, OTP, MFA

### Security infrastructure

**Audit event**:
A single record of security-relevant activity answering what happened, when, which user, and which resource. Named `<entity>.<event>` per AGENTS.md; never contains secrets, tokens, or passwords.
_Avoid_: "audit log" for a single event — the log is the whole collection

**Rate limit window**:
A fixed wall-clock interval per key (IP, or IP+email) during which attempts count against a threshold; the counter starts once and is never extended mid-window. Login and registration each define their own window and limit.
_Avoid_: throttle, cooldown, sliding window
