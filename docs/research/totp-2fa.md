# TOTP 2FA foundation — design validation (ENG-27)

Research step of ENG-27 (2FA foundation). Method: primary sources only (official
docs, the libraries' own repositories and shipped source, RFCs, NIST), plus
empirical verification — the published packages (`otpauth@9.5.1`,
`qrcode@1.5.4`) were installed from the npm registry and exercised directly
under Node. Every design decision below was validated before implementation.

**Verdict: 6/6 CONFIRMED — no contradictions. The locked design stands.**

## 1. `otpauth` for TOTP — CONFIRMED (chosen over `otplib`)

- Base32 secrets: `Secret.fromBase32(str)` parses Base32 (RFC 3548); a 20-byte
  secret renders as exactly 32 Base32 chars, round-trip verified against the
  shipped 9.5.1 source. (Implementation note: the static is `fromBase32`, not
  `fromB32`.)
- Token derivation: `totp.generate()` returns the current 6-digit code
  (verified empirically).
- Verification window: `totp.validate({ token, window })` — "Window of counter
  values to test … Token delta or null if it is not found in the search
  window." Verified: current token → `0`, one time-step old → `-1`, mutated →
  `null` with `window: 1`. The design's ±1 window is the library default and
  matches RFC 6238 §5.2 ("at most one time step").
- GA compatibility and maintenance: the README documents Google Authenticator
  key-URI generation (`totp.toString()`); ~2.2M weekly npm downloads; stable
  synchronous class-based API since 2017 (9.5.1 current); single runtime dep
  (`@noble/hashes`); dual ESM/CJS builds via the `exports` map
  (`otpauth.node.mjs` / `otpauth.node.cjs`). `import { TOTP, Secret } from
  "otpauth"` works in Node (verified) — the package is isomorphic, no browser
  APIs needed server-side.
- vs `otplib`: the v12 line all existing material targets last shipped
  2020-01-24; v13 (2026-01-10) is "a complete rewrite with breaking changes"
  (per its own README) with <1 year of track record. otpauth's continuity and
  API stability make it the lower-risk choice for a security-critical flow.

Sources:
- https://github.com/hectorm/otpauth
- https://hectorm.github.io/otpauth/
- https://registry.npmjs.org/otpauth/latest
- https://github.com/yeojz/otplib (v13 rewrite notice)

## 2. `qrcode` for server-side PNG data URLs — CONFIRMED

`soldair/node-qrcode` documents a Server API `toDataURL(text, [options],
[cb])` returning a PNG data URI; server rendering uses `pngjs` (no `canvas`
native dependency — `canvas` is dev-only for that package). Verified
empirically: `QRCode.toDataURL(otpauthUri)` →
`data:image/png;base64,iVBORw0KGgo…`. Stable and ubiquitous (~24M weekly
downloads).

Sources:
- https://github.com/soldair/node-qrcode (Server API section)
- https://registry.npmjs.org/qrcode/latest

## 3. 20-byte Base32 secrets for Google Authenticator — CONFIRMED

RFC 4226 §4: the shared secret MUST be ≥128 bits, RECOMMENDED 160 bits.
RFC 6238 §5.1: keys SHOULD match the HMAC output length — 160 bits for the
default HMAC-SHA-1, i.e. 20 bytes = exactly 32 unpadded Base32 chars
(RFC 3548). otpauth's `Secret` defaults to `size: 20`, and its README warns
against <128 bits. GA's Key-Uri-Format spec requires Base32 per RFC 3548 with
padding omitted.

Sources:
- https://www.rfc-editor.org/rfc/rfc4226 (§4)
- https://datatracker.ietf.org/doc/html/rfc6238 (§5.1)
- https://github.com/google/google-authenticator/wiki/Key-Uri-Format

## 4. `otpauth://` URI format GA expects — CONFIRMED

GA spec: `otpauth://TYPE/LABEL?PARAMETERS`, canonical example
`otpauth://totp/Example:alice@google.com?secret=…&issuer=Example`. Label =
`issuer ":" accountname` (colon, literal or URL-encoded); the `issuer` query
param is "STRONGLY RECOMMENDED", and the wiki recommends using BOTH the label
prefix and the parameter (kept equal). Defaults: `algorithm=SHA1`, `digits=6`,
`period=30` — GA currently ignores these params on some platforms, so emitting
defaults explicitly is harmless. Verified empirically,
`totp.toString()` (issuer "Secure Notes", label an email address) produces
`otpauth://totp/Secure%20Notes:user%40example.com?issuer=Secure%20Notes&secret=<32 chars>&algorithm=SHA1&digits=6&period=30`,
and `URI.parse()` round-trips issuer/label/secret. The design's
`totpUri(secret, email)` with issuer "Secure Notes" matches exactly.

Sources:
- https://github.com/google/google-authenticator/wiki/Key-Uri-Format

## 5. AES-256-GCM, `iv:tag:ciphertext` base64 storage — CONFIRMED

Node crypto docs confirm the mechanics: `createCipheriv('aes-256-gcm', key,
iv)`; `getAuthTag()` after `final()`; `setAuthTag()` before `final()` on
decryption — "if the cipher text has been tampered with, `decipher.final()`
will throw, indicating that the cipher text should be discarded due to failed
authentication." The 16-byte (128-bit) tag is the norm — Node deprecated other
GCM tag lengths (v20.13/v22) and disallows them outright (v26). The 12-byte
(96-bit) IV is the NIST SP 800-38D §8.2.1 recommendation ("implementations
restrict support to the length of 96 bits") — Node's docs only explicitly
mandate 12 bytes for the GCM-SIV variant, so the GCM citation is NIST, not
Node. Verified end-to-end empirically: encrypt → store
`[iv, tag, ct].map(b64).join(':')` → decrypt with `setAuthTag` succeeds;
flipping a bit of ciphertext or tag throws.

Sources:
- https://nodejs.org/api/crypto.html
- https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf (§8.2.1)

## 6. 32-byte base64 key via `APP_ENCRYPTION_KEY` — CONFIRMED

AES-256 requires exactly 32 bytes; `createCipheriv` enforces it. Design's
validation (`Buffer.from(env, "base64").length === 32` before first use) is
essential because `Buffer.from(…, "base64")` is lenient — it skips invalid
characters silently, so a truncated/corrupt key must be caught by the explicit
length check. Key rotation is out of scope (ENG-32); the standard future
upgrade path (prefixing ciphertext with a key-version id) does not conflict
with the current format decision.

Sources:
- https://nodejs.org/api/crypto.html

## Forward notes for ENG-28/29 (out of scope here, recorded by the research)

- Replay protection: `validate` returns a delta and does NOT prevent token
  reuse; RFC 6238 §5.2 requires the verifier to reject a second attempt after
  a successful validation. The login flow must handle this (otpauth exposes
  `totp.counter()` for it). Attempt throttling is also recommended by the
  otpauth README and fits the existing rate-limit infrastructure.
- `timestamp` is a per-call option on `generate`/`validate`, not an instance
  property (a silent no-op if assigned).
