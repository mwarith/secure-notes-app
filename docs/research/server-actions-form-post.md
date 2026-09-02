# Server Actions over plain HTTP form POST — wire protocol for the no-JS stress driver

Research step for the load-test driver (invoke the app's Server Actions from plain
HTTP, no JavaScript). Method: primary sources only — the vendored runtime source in
`node_modules` (React 19.2.8 `react-dom`/`react-server-dom-webpack`, Next 16.3.3
`dist/server`/`dist/docs`), cross-checked against react.dev — plus **empirical
verification**: a scratch Next 16.3.3 (Turbopack) app was built and run (`next
build` + `next start`) and every POST below was replayed against it with Node's
`fetch`/`FormData`. Repo app code was not read and not modified.

**Verdict: CONFIRMED, with two hard limits.** Every Server Action whose
`<form>` appears in the server-rendered HTML can be POSTed from a plain HTTP
client using only fields found in that HTML. Forms that are not rendered at SSR
time (e.g. inside a closed dialog) and forms whose action args contain
`File`/`Blob` values cannot be reached this way.

## 1. Hidden fields in the server-rendered HTML

React emits hidden inputs as the first children of the `<form>` open tag (or
right after a `<button formAction>` open tag). The `<form>` tag itself gets
`action="" method="POST" enctype="multipart/form-data"` (the SSR output
literally contains the camelCase `encType` attribute; browsers treat attribute
names case-insensitively, and the driver should match it loosely or ignore it —
the request `Content-Type` is what matters).

Observed SSR output (scratch app, four forms on one page):

```html
<form id="server-form" action="" encType="multipart/form-data" method="POST">
<input type="hidden" name="$ACTION_ID_402e3a20f4399cd9badb54d17240ce735e5c90ec58"/>
...
<form id="client-form" action="" encType="multipart/form-data" method="POST">
<input type="hidden" name="$ACTION_REF_4"/>
<input type="hidden" name="$ACTION_4:0" value="{&quot;id&quot;:&quot;6034deff…&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/>
<input type="hidden" name="$ACTION_4:1" value="[{&quot;ok&quot;:true,&quot;message&quot;:&quot;idle&quot;}]"/>
<input type="hidden" name="$ACTION_KEY" value="kb0ddaa66d5b32fd7831d7e35b1c6dd4d"/>
...
<form id="bound-form" action="" encType="multipart/form-data" method="POST">
<input type="hidden" name="$ACTION_REF_5"/>
<input type="hidden" name="$ACTION_5:0" value="{&quot;id&quot;:&quot;402e3a20…&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/>
<input type="hidden" name="$ACTION_5:1" value="[&quot;xyz&quot;]"/>
```

### (a) Server-component form, `action={serverAction}` — unbound action

Exactly one hidden input: `name="$ACTION_ID_<id>"`, empty value, where `<id>` is
the build-time action reference id (Next 16: an encrypted, non-deterministic
40-hex-char string). The POST's plain user fields are appended to the action as
a single `FormData` argument.

Source: `defaultEncodeFormAction` returns `{name: "$ACTION_ID_" + id, method:
"POST", encType: "multipart/form-data"}` for unbound references —
`node_modules/next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.development.js:822-853`
(the `$ACTION_ID_` string at line 846). Next passes `encodeFormAction =
undefined` when creating server references, so this default encoder is what
runs — `node_modules/next/dist/build/webpack/loaders/next-flight-server-reference-proxy-loader.js:23-25`.
Fizz turns the result into form attributes and one hidden input —
`node_modules/react-dom/cjs/react-dom-server.node.development.js:1274-1299`
(`getCustomFormFields`), `2340-2382` (`<form>` case: pushes `action`, `encType`,
`method`, then `<input type="hidden" name=…>` + any extra fields).

### (b) Client-component form via `useActionState` — bound action

`useActionState` binds the current state as the action's first argument
(`action.bind(null, initialState)`), so the form encodes a **bound** action:

- `$ACTION_REF_<n>` — empty hidden input marking "action with bound args".
- `$ACTION_<n>:0` — HTML-escaped JSON `{"id":"<actionId>","bound":"$@1"}` (row 0
  of a Flight reply: action id + lazy reference to the bound args).
- `$ACTION_<n>:1` — HTML-escaped JSON array of the bound args; for
  `useActionState` this is `[<initialState>]`, e.g.
  `[{"ok":true,"message":"idle"}]`.
- `$ACTION_KEY` — the "postback state key" that ties this form to its previous
  result: `"k" + md5(JSON.stringify([keyPath, null, hookIndex]))`, or `"p" +
  permalink` when the `useActionState(action, state, permalink)` third argument
  is used.

Sources: `useActionState` SSR implementation —
`node_modules/react-dom/cjs/react-dom-server.node.development.js:4062-4126`
(`createPostbackActionStateKey` at 4062-4072; the `formData.append("$ACTION_KEY",
nextPostbackStateKey)` at 4113; matching a previous result via
`action.$$IS_SIGNATURE_EQUAL` and `postbackKey === nextPostbackStateKey` →
`initialState = request[0]`, lines 4081-4092). Bound-args encoding —
`react-server-dom-webpack-client.node.development.js:829-852`
(`$ACTION_<prefix>:<key>` fields + `$ACTION_REF_<prefix>` name) built from
`encodeFormData`/`processReply` (lines 793-821, 548-568: root row
`{"id":…,"bound":"$@1"}`, promise resolution appended as row `1`). Server-side
mirror: `decodeAction`/`decodeFormState` —
`node_modules/next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-server.node.development.js:6590-6634`
(`$ACTION_REF_` → prefix `$ACTION_<n>:`, `decodeBoundActionMetaData`;
`decodeFormState` returns `[actionResult, keyPath, referenceId,
bound.length - 1]`). Permalink semantics documented at
https://react.dev/reference/react/useActionState (`permalink?` — "the browser
will navigate to the specified permalink URL rather than the current page's
URL").

### (c) Client-component form with `.bind(null, arg)`

Same shape as (b): `$ACTION_REF_<n>` + `$ACTION_<n>:0` (metadata) +
`$ACTION_<n>:1` = JSON array of the bound args (probe: `["xyz"]` for
`saveNote.bind(null, "xyz")`), **no** `$ACTION_KEY` (that is useActionState
only). Next's docs state `bind` "works in both Server and Client Components and
supports progressive enhancement" —
`node_modules/next/dist/docs/01-app/02-guides/forms.md:124-127`. Bind
implementation that accumulates bound args on the reference —
`react-server-dom-webpack-client.node.development.js:964-991`.

### Field-name numbering and escaping

- `<n>` is Fizz's per-render form counter: `nextFormID` starts at `0` and is
  post-incremented per encoded form action
  (`node_modules/react-dom/cjs/react-dom-server.node.development.js:972`,
  `1276`). In the Next 16 static prerender the observed values were `4` and
  `5` (prerendering renders the tree in multiple passes; the counter does not
  restart). **Do not compute the suffix — read it from the HTML.**
- The JSON values of `$ACTION_<n>:0/1` are HTML-escaped in the attribute
  (`&quot;` for `"`). A driver must unescape (`&quot;`→`"`, `&amp;`→`&`,
  `&#x27;`→`'`, `&lt;`, `&gt;`) before putting them back into a multipart body.
  (First probe run sent the escaped strings verbatim and got a 500.)
- The colon in `$ACTION_4:0` travels verbatim in a multipart field name — no
  percent-encoding anywhere (see §3).

## 2. Where action IDs live: rendered markup vs flight payload

- Hidden inputs exist **only in rendered `<form>`/submit-button markup** — there
  is no noscript-specific copy of them. A form that is not in the SSR tree (a
  Radix dialog rendered only when open, or any `{condition && <form>}`) has no
  hidden fields in the HTML. Empirical: a `{false && <form
  action={hiddenAction}>}` in the probe produced no trace of `hiddenAction`'s
  id anywhere in the response — it is unreachable without JS.
- The inlined RSC flight payload (`self.__next_f.push([1,"…"])` scripts) is a
  **secondary** discovery source: a server action passed as a prop from a server
  component to a rendered client component is serialized as a `$F` server
  reference carrying the encrypted id, and appears even if the client component
  renders no form for it. In the probe, one action id occurred 3× (hidden
  input, `$ACTION_5:0` metadata, flight payload), but the action imported
  directly by a client module (`saveNoteWithState`) occurred **only** in its
  form's `$ACTION_4:0` — importing into a client bundle does not put the id in
  the flight stream.
- Practical rule for the driver: harvest `$ACTION_ID_*` / `$ACTION_REF_*` /
  `$ACTION_*:0/1` / `$ACTION_KEY` from the rendered form markup; treat the
  flight payload as a fallback reference source, not a POST recipe.

## 3. Wire format details

- **Method**: always POST. `defaultEncodeFormAction` returns `method: "POST"`
  (source in §1a), and Next's docs state a Server Action "runs as a POST
  request against the page that invokes it" —
  `node_modules/next/dist/docs/01-app/02-guides/server-actions.md:78`.
- **URL**: the current page URL. SSR emits `action=""` (empty → browser posts to
  the current URL; `customFields.action || ""` —
  `node_modules/react-dom/cjs/react-dom-server.node.development.js:2345`). There
  is no `/action` endpoint. Exception: a `permalink` passed to `useActionState`
  overrides the postback URL (`…react-dom-server.node.development.js:4101-4104`).
- **Content type**: `multipart/form-data` is required. Next's action handler
  classifies a POST via
  `node_modules/next/dist/server/lib/server-action-request-meta.js:37-40`:
  `multipart/form-data` → MPA/fetch action; `application/x-www-form-urlencoded`
  → "We don't actually support URL encoded actions" and the handler bails
  (`node_modules/next/dist/server/app-render/action-handler.js:400-411`). The
  probe confirms: a urlencoded POST carrying a valid `$ACTION_ID_` returns a
  normal page render (200 text/html) — the action never runs. Multipart field
  names (including the colon in `$ACTION_4:0`) are parsed verbatim via busboy
  (`action-handler.js:689-706`); no percent-encoding is involved.
- **Headers**: no `Next-Action` header on the no-JS path (its presence marks a
  "fetch action" — `server-action-request-meta.js:39`). CSRF check: the request
  `Origin` must match `Host`/`X-Forwarded-Host` unless it is missing entirely —
  a missing `Origin` is allowed with a server-side warning ("handcrafted
  requests can't contain user credentials…"), a **mismatched Origin aborts the
  action** (`action-handler.js:427-491`); `serverActions.allowedOrigins` can
  whitelist proxies (`server-actions.md:82`). Probe: `Origin:
  http://evil.example` → 500; `Origin: http://localhost:3210` → 303 as
  expected; no Origin header → works. Session cookies are ordinary cookies.
- **Body size limit**: 1 MB default (`serverActions.bodySizeLimit`), enforced
  with a 413 (`action-handler.js:517-520, 546-553, 638-647`).
- **Malformed multipart POSTs**: a multipart POST with no `$ACTION_*` fields
  fails `areAllActionIdsValid` and throws "Failed to find Server Action" (E975)
  → 500 (`action-handler.js:740-748, 1040-1086`). Probe: 500 "Internal Server
  Error".

## 4. Response semantics for the no-JS POST

- **Normal return**: the POST does **not** return a flight stream — Next runs
  `decodeAction`, executes the action, computes `decodeFormState`, and renders a
  **full HTML document** of the same page with 200 and `Cache-Control: no-cache,
  no-store…` (`action-handler.js:583-613 / 740-764` return `{type: 'done',
  result: undefined, formState}`; the render is wired through
  `node_modules/next/dist/server/app-render/app-render.js:1721-1762, 2236-2250`
  as the Fizz `formState` option). Probe: both useActionState POSTs → 200
  text/html, full `<!DOCTYPE html>` document.
- **How `useActionState` state surfaces**: two places in the response HTML.
  1. Rendered content: during the SSR re-render the hook's initial state *is*
     the action's return value (`…react-dom-server.node.development.js:4081-4092`), so
     `{state?.message}` paragraphs appear with the fresh message ("Validation
     failed: title required" / "State saved: works" in the probe). React also
     emits `<!--F!-->` (this hook's key matched the postback) or `<!--F-->`
     (didn't match) around the component's output — probe: exactly one
     `<!--F!-->` in the invalid-submit response (markers exist only when
     `formState != null`, i.e. only on POST responses — `…:5312-5332, 9943-9944`).
  2. Machine-readable inline payload: `self.__next_f.push([2, [<actionResult>,
     "<$ACTION_KEY value>", "<actionId>", <numberOfBoundArgs>]])` — the
     `decodeFormState` tuple, inlined verbatim by Next
     (`node_modules/next/dist/server/app-render/stream-ops.node.js:723-744`,
     `INLINE_FLIGHT_PAYLOAD_FORM_STATE = 2`). Captured from the probe response:
     `self.__next_f.push([2,[{"ok":false,"message":"Validation failed: title
     required"},"kb0ddaa66…","6034deff…",0]])`.
  A plain server-component form's return value has no state container — it is
  computed and dropped (only its side effects and any redirect are observable).
- **`redirect()`**: an HTTP **303 See Other** with a `Location` header and an
  empty body for the no-JS path (`action-handler.js:903-910` — `RedirectStatusCode.SeeOther`;
  `node_modules/next/dist/client/components/redirect-status-code.js:12`). No
  `x-action-redirect` header on this path (that header is the fetch-action
  mechanism, `action-handler.js:260-261`). Probe: 303, `Location: /other`,
  body length 0. The driver should follow the redirect with GET (the target
  page returned 200).
- **Errors / notFound()**: `notFound()` from an MPA action → `{type:
  'not-found'}` → 404 page; any other thrown error is rethrown → 500 error page
  (`action-handler.js:911-969`). Validation "errors" that are *returned* state
  are just 200s with the state in the HTML (above) — there is no non-2xx
  signal.
- **Success vs failure detection recipe** (from the re-rendered HTML only):
  200 + message string (or `__next_f.push([2, …])` tuple with the expected
  shape) = outcome visible to the user; 303 + Location = redirect success; 500
  = thrown error or stale/unknown action id; 413 = body limit; missing
  `$ACTION_KEY`/markers with an unchanged page = action returned nothing
  rendered. A rate-limit or validation message implemented as returned state is
  detected by searching the re-rendered HTML for the message (and/or parsing
  the `[2, …]` tuple).

## 5. Next 16 specifics (from the vendored docs)

- **Encrypted, rotating action IDs**: "Next.js creates encrypted,
  non-deterministic IDs … periodically recalculated between builds" —
  `node_modules/next/dist/docs/01-app/02-guides/data-security.md:285`; ids
  rotate "at most every 14 days, even when the source is unchanged" —
  `…/02-guides/server-actions.md:174`. Consequence for the driver: **harvest
  action ids from the served HTML at session start; never hardcode them**, and
  expect "Failed to find Server Action" (500) after a redeploy.
- **Turbopack default** for dev and prod builds (`…/02-guides/upgrading/version-16.md:166-178`,
  webpack via `--webpack` flag). The probe (Turbopack build) showed the same
  hidden-field protocol the webpack loader produces; no wire difference.
- New action-only cache APIs in 16 — `updateTag`, `refresh`, and the
  two-argument `revalidateTag` (`version-16.md:444-514`) — affect the
  fetch-action response contents (RSC payload co-delivered), not the no-JS
  form-POST protocol; the MPA path always re-renders full HTML.
- `serverActions` config: `allowedOrigins`, `bodySizeLimit` (`…/02-guides/server-actions.md:154-170`).
- **JS-disabled operation**: the `$ACTION_ID_`/`$ACTION_REF_` hidden inputs ARE
  the progressive-enhancement mechanism — they are in the static HTML (probe
  page is statically prerendered and contains them), no `noscript` markup is
  involved, and there is no separate discovery API. The only JS dependency is
  the "form replay runtime" React injects **when it cannot encode the action**
  (bound args contain `File`/`Blob` → "File/Blob fields are not yet supported
  in progressive forms. Will fallback to client hydration." → the form gets
  `action="javascript:throw new Error('React form unexpectedly submitted.')"`
  instead of hidden fields — `…react-dom-server.node.development.js:1268-1273,
  1338-1346, 9920-9941`). Documented `$ACTION_` prefix visibility:
  `…/02-guides/forms.md:70`.

## Empirical verification summary

Scratch app (temp dir, `next@16.3.3`/`react@19.2.8`, Turbopack build, `next
start`), one page with: a server-component form (unbound action), a client
`useActionState` form, a client `.bind` form, a redirect-action form, and a
never-rendered form. Results:

| Probe | Expected | Observed |
| --- | --- | --- |
| GET `/` hidden fields | `$ACTION_ID_*` for unbound forms; `$ACTION_REF_n` + `$ACTION_n:0/1` + `$ACTION_KEY` for bound ones | exact match, incl. HTML-escaped JSON values |
| `<form>` attributes | `action="" method="POST" enctype=multipart/form-data` | exact match |
| POST unbound action (multipart, no Origin header) | 200 full HTML, action executed | 200 text/html |
| POST useActionState (invalid input) | 200 + returned message in HTML + `[2,…]` tuple | 200, "Validation failed: title required", `self.__next_f.push([2,[{"ok":false,"message":"Validation failed: title required"},"kb0ddaa66…","6034deff…",0]])`, one `<!--F!-->` |
| POST useActionState (valid input) | 200 + success message | 200, "State saved: works" |
| POST redirect action | 303 + Location, empty body | 303, `Location: /other`, 0 bytes |
| POST urlencoded with valid `$ACTION_ID_` | unsupported → not an action | 200 page render, action skipped |
| POST multipart without `$ACTION_*` fields | rejected | 500 |
| POST with mismatched `Origin` | rejected by CSRF check | 500 |
| POST with matching `Origin` / no `Origin` | allowed | 303 / 200 |
| Never-rendered form's action id | absent from HTML | absent (also absent from flight payload) |
| Re-POST with the same action id | stable within a build | 200 (ids identical across responses) |

## Verdict for the stress driver

**Recipe A — server-component form (`action={serverAction}`, unbound):**

1. `GET` the page (with session cookies); find the target form's hidden input
   `name="$ACTION_ID_<id>"`.
2. `POST` to the **same URL** as `multipart/form-data` with fields:
   `$ACTION_ID_<id>` = `""`, plus the form's real fields (named inputs,
   including hidden inputs the app rendered). No special headers required:
   omit `Next-Action`; send `Origin` equal to the host or omit it.
3. Expect **200 text/html** (full re-render). Action return values are not
   observable here; detect success via effects in the re-rendered HTML, or a
   **303 + Location** if the action redirects. 500 = thrown error / unknown
   action id.

**Recipe B — client-component form (`useActionState`, or `.bind` args):**

1. From the GET HTML, collect the form's `$ACTION_REF_<n>` (name only, empty
   value), `$ACTION_<n>:0` and `$ACTION_<n>:1` (**HTML-unescape the JSON**
   values), and `$ACTION_KEY` (useActionState only).
2. `POST` multipart to the same URL with those four fields (the first three;
   `$ACTION_KEY` only for useActionState) plus the real form fields. Do not
   alter the JSON — it is the action id + bound args (`prevState` / bound
   arguments) the server decodes.
3. Expect **200 text/html** containing the action's returned state rendered by
   the hook (`<p>{state.message}</p>` etc.), one `<!--F!-->` marker, and the
   machine-readable `self.__next_f.push([2, [<result>, "<key>", "<id>",
   <n>]])` tuple — parse that tuple rather than scraping prose when possible.
   303 for `redirect()`, 500 for throws.

**Plain HTTP cannot reach (without private build internals):**

- Actions whose forms are **not in the SSR HTML** — closed dialogs, forms
  behind client-side state. Their ids may occasionally be recoverable from the
  inlined flight payload, but the exact `$ACTION_REF_n`/`$ACTION_KEY` field set
  is generated per rendered form, so there is no reliable no-JS POST recipe.
- Actions with **`File`/`Blob` bound args** (React falls back to a JS-only
  `javascript:throw…` form action — §5).
- Anything over the 1 MB body limit (413) and, after a redeploy, all old
  action ids (500 E975) — re-harvest ids per run.

Everything else — unbound server forms, `useActionState` forms, `.bind` forms,
`redirect()` actions, cookie-session auth — is fully drivable from served HTML
alone.

## Empirical confirmation on the target stack (ENG-41, secure-notes-app compose build)

The recipes above were derived and verified against a scratch app. They were then
re-played against the real compose stack (Next 16.3.3 production build,
`docker compose up web`, localhost:3000). Results diverged for the no-JS MPA
path and confirmed a second, more reliable protocol — the one the app's own JS
uses. All findings below are from the running stack, via stdlib HTTP clients.

### The no-JS MPA path (Recipes A/B) is unreliable on this stack

- The SSR hidden fields exist exactly as documented: `/register` renders
  `$ACTION_REF_1`, `$ACTION_1:0`
  (`{"id":"6071b113…267","bound":"$@1"}`), `$ACTION_1:1`
  (`[{"status":"idle"}]`), `$ACTION_KEY`. The id in `$ACTION_1:0` is
  byte-identical to the id the served client chunk registers for the same
  action, and both match the running server's
  `.next/server/server-reference-manifest.json` (42-char ids: 2-char info byte
  encoding bound-arg count, per
  `next/dist/shared/lib/server-reference-info.js:31-34`, plus 40-char digest).
- Replaying Recipe B verbatim (multipart, correct field names/values, valid
  Origin) against `/register` **did not execute the action**: the server logged
  `Failed to find Server Action` (E975, thrown by
  `areAllActionIdsValid`, `action-handler.js:586-594`) while a byte-identical
  replay of the validation logic offline (`areAllActionIdsValid` + the real
  manifest + a faithful `serverModuleMap` proxy) returned **valid**. After a
  container restart the same POST was answered from the static prerender
  without the action handler being reached at all (instrumented
  `handleAction` never fired). The failure is request-flow-dependent and was
  not chased further: the no-JS MPA POST is **not used by this app's users
  (the app ships JS), and the app's real protocol is the fetch path below**.

### The fetch-action path (`Next-Action` header) — what the driver uses

Captured from a real browser (Playwright, JS enabled) and replayed from plain
Python: every `useActionState` form POSTs to the **page URL** as
`multipart/form-data` with:

- header `Next-Action: <42-char id>` — the same id carried in the SSR
  `$ACTION_<n>:0` field, so it is harvestable from served HTML without any
  build internals;
- the form's fields prefixed `_1_` (the FormData is bound argument 1), e.g.
  `_1_email`, `_1_password`;
- one extra field `0` = `[<currentState>, "$K1"]` — the flight encoding of the
  bound args: current hook state plus a reference to the form data;
- header `Origin` matching the host (the CSRF check of §3 applies);
- session cookies for authenticated actions.

Response: `200 text/x-component` (a flight stream), where the action's returned
state is the row starting `1:` — e.g. `1:{"status":"success"}` or
`1:{"status":"error","message":"…"}`. A successful login additionally returns
`Set-Cookie: session=…` (the row is a redirect payload). Note: the server
console warns `Missing 'origin' header…` but allows an Origin-less request.

### Dialog-only actions (create/update note) over plain HTTP

The create-note and update-note forms live inside Radix dialogs that are closed
at SSR time, so their `$ACTION_*` fields are absent from the workspace HTML —
Recipe B cannot reach them. The **fetch path can**: every client-side server
reference is registered in the page's served JS chunks as
`createServerReference("<42-char-id>", …, "<exportedName>")`, e.g.
`…"604aec0d…97",l.callServer,void 0,l.findSourceMapURL,"createNoteAction"`.
The chunks are public assets (`/_next/static/chunks/…`), the exported name sits
next to the id, so the driver harvests `createNoteAction` / `updateNoteAction`
ids by name from served JavaScript — no private build internals. The note id
for updates is harvested from the workspace HTML's inlined flight payload
(`\"id\":\"<uuid>\",\"title\":\"<title>\"`).

### Verified end-to-end from plain Python (stdlib `http.client`)

| Journey | Request | Response evidence |
| --- | --- | --- |
| register | `POST /register`, `Next-Action: <registerAction id>`, `_1_email`, `_1_password`, `0=[{"status":"idle"},"$K1"]` | `1:{"status":"success"}`; row appears in `users` |
| sign in | same shape against `/login` | `Set-Cookie: session=…` |
| view workspace | `GET /` with cookie | 200 HTML |
| create note | `POST /`, `Next-Action: <createNoteAction id>`, `_1_title`, `_1_content`, `0=[…]` | `1:{"status":"success"}` |
| edit/save | `POST /`, `Next-Action: <updateNoteAction id>`, `_1_noteId`, `_1_title`, `_1_content`, `0=[…]` | `1:{"status":"success"}` |

Ids harvested per run (register/login from page HTML, create/update from served
chunks); never hardcoded. Rate-limit isolation uses a unique `x-forwarded-for`
per virtual user (the app's documented trusted-proxy header — same technique as
`e2e/helpers/test-account.ts`).

**Corrected verdict for the ENG-41 driver:** drive the app's real protocol —
the fetch-action path (`Next-Action` + `_1_`-prefixed multipart + `0` bound-args
field), with ids harvested from served HTML and chunks per run. The no-JS MPA
recipes (A/B) remain correct as documented for a from-scratch Next app but were
not reliable against this stack's static auth pages and are not used by the
driver.
