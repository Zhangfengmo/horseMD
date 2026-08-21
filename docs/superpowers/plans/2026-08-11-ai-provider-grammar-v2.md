# Desktop AI Provider and Selection Grammar Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one desktop-only, OpenAI-compatible AI connection and let a writer manually grammar-check one selected plain-text range from the existing selection toolbar, then insert the suggestion as a CriticMarkup substitution for normal Review accept/reject.

**Architecture:** The renderer can configure and invoke only a narrow preload API; API keys and all HTTP remain in Electron's main process. A streaming, OpenAI-compatible adapter produces the existing `AiEvent` contract, while a grammar service sends only the selected text and creates a Phase-0 `ChangeProposal`. The renderer revalidates that proposal against the current Markdown immediately before creating the CriticMarkup substitution.

**Tech Stack:** Electron 34 `net.fetch`, `safeStorage`, Node ESM, React 18, Milkdown/ProseMirror, existing CriticMarkup review plugin, node assertion scripts, Electron CDP helper.

---

## Frozen product scope

- **One connection shape, not a vendor matrix:** an OpenAI-compatible endpoint with `baseUrl`, `model`, and API key. The default is `https://api.openai.com/v1`; it also supports compatible hosted or loopback endpoints. Do not add separate OpenAI, Anthropic, CLI, SDK, provider-picker, model discovery, or plugin implementations in this change.
- **One grammar entry point:** desktop rich-editor selection toolbar only. There is no sidebar, chat, command palette item, source-mode command, automatic/on-type check, document/section context, or mobile UI.
- **One safe selection shape:** a non-empty, single-line range in one ordinary ProseMirror textblock whose visible selection exactly matches its raw Markdown slice. Code blocks, math, table cells, images, review markers, mixed formatting, multi-block ranges, source mode, and unmappable source are rejected locally before any request.
- **One review outcome:** when the correction differs, show an anchored card with old/new text and explanation. `Apply as review` inserts `{~~before~>after~~}`; it never writes the corrected text directly. The existing Review controls own accept/reject afterwards.
- **No silent information expansion:** the network payload contains the selected text and the grammar instruction only. Full Markdown travels only over local IPC so main can make/validate a proposal.
- **Explicitly deferred:** assistant panel, streaming text UI, multilingual language selector, custom prompt templates, model testing/listing, multiple saved connections, mobile secure storage, and cross-block substitutions.

## User-visible success criteria

1. Settings → AI lets a desktop user save an OpenAI-compatible base URL, model, and API key. The settings UI can learn only whether a key exists; it never receives a persisted key.
2. Selecting plain prose exposes **Grammar** in the existing floating toolbar. A configured provider can be called, cancelled, retried after a recoverable error, or dismissed.
3. A valid changed result shows the selected text, its proposed correction, and the model explanation in a small anchored card. All model strings use `textContent`; they are never inserted as HTML.
4. Applying an unchanged proposal is refused. Applying a changed proposal first verifies document revision, raw range, and original text, then adds a CriticMarkup substitution in one editor transaction and marks the document dirty.
5. Configuration, adapter parser/error/cancel/timeout behavior, selection eligibility, stale-proposal rejection, review insertion, and the real toolbar flow are covered by focused tests. Desktop build, mobile shared-renderer build, guide check, and the affected existing regressions pass.

## File map

| Path | Responsibility |
| --- | --- |
| `src/shared/ai-contracts.js` | Stable provider-config, event, and error-value validation shared by all main AI modules. |
| `src/main/ai/ai-provider-config.js` | Normalizes the one allowed endpoint configuration and enforces URL/scheme limits. |
| `src/main/ai/ai-credential-store.js` | AI-only encrypted key storage under the Electron user-data directory; does not refactor sync storage. |
| `src/main/ai/openai-compatible-adapter.js` | Request construction, SSE decoding, and provider-error mapping; accepts injected `fetch` for Node tests. |
| `src/main/ai/provider-registry.js` | Resolves the configured adapter and owns request-id cancellation. |
| `src/main/ai/grammar-service.js` | Builds the fixed grammar request, accumulates adapter events, validates JSON, and creates/validates proposals. |
| `src/main/ai-ipc.js` | Registers the narrow provider settings and grammar IPC handlers. |
| `src/main/index.js` | Imports and registers the AI IPC after `app.whenReady()` dependencies exist. |
| `src/preload/index.js` / `src/renderer/src/platform/capacitor-api.js` | Expose desktop `api.ai`; advertise `capabilities.ai` true on desktop and false on mobile. |
| `src/renderer/src/hooks/useAiProviderSettings.js` | Loads/saves the redacted provider summary for the settings page. |
| `src/renderer/src/components/settings/AiSettings.jsx` | Desktop settings form and local status/error states. |
| `src/renderer/src/components/SettingsView.jsx`, `settings/SettingsNav.jsx`, `App.jsx`, `i18n.jsx` | Mount, route, and translate the AI settings section. |
| `src/renderer/src/components/editor-api.js` | Creates an exact selection snapshot and applies a validated grammar substitution. |
| `src/renderer/src/reviewMarkup.js`, `components/editor-review.js` | Builds a safe substitution marker and applies it in one ProseMirror transaction. |
| `src/renderer/src/components/editor-grammar.js` | Owns the toolbar-card state machine and local IPC calls. |
| `src/renderer/src/components/editor-toolbar.js`, `editor-dom-bindings.js`, `Editor.jsx`, `components/shell/EditorArea.jsx` | Inject the Grammar toolbar item, connect the editor API, and cancel a hidden editor's request without growing `App.jsx`. |
| `src/renderer/src/styles/app.css` | Anchored card layout, loading/error states, keyboard focus, and narrow-window rules. |
| `scripts/test-ai-provider.mjs`, `scripts/test-ai-grammar.mjs`, `scripts/test-ai-grammar-ui.mjs` | Deterministic provider, grammar/review, and end-to-end toolbar coverage. |
| `guide/customization/settings.md`, `guide/productivity/review.md`, `CHANGELOG.md`, `package.json`, `package-lock.json` | User documentation and patch release metadata. |

## Task 1: Lock down the main-process provider contract

**Files:**
- Modify: `src/shared/ai-contracts.js`
- Modify: `scripts/test-ai-core.mjs`
- Create: `scripts/test-ai-provider.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add failing contract tests before adapter code.**

  In `scripts/test-ai-provider.mjs`, assert these public behaviors without importing Electron:

  ```js
  import assert from 'node:assert/strict'
  import { normalizeAiProviderConfig } from '../src/main/ai/ai-provider-config.js'

  assert.deepEqual(
    normalizeAiProviderConfig({ baseUrl: 'https://api.example.com/v1/', model: 'grammar-1' }),
    { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'grammar-1' }
  )
  assert.throws(() => normalizeAiProviderConfig({ baseUrl: 'file:///tmp/key', model: 'x' }), /invalid-ai-base-url/)
  assert.throws(() => normalizeAiProviderConfig({ baseUrl: 'http://example.com/v1', model: 'x' }), /invalid-ai-base-url/)
  assert.throws(() => normalizeAiProviderConfig({ baseUrl: 'https://api.example.com/v1', model: '' }), /invalid-ai-model/)
  ```

  Also extend `scripts/test-ai-core.mjs` to prove an adapter must return an async iterable from `invoke`, and add `npm run test:ai-provider` plus an aggregate `test:ai` script. Keep the existing `test:ai-core` and `test:core` entries; do not add a second copy of either core test.

- [ ] **Step 2: Run the new test and record the red failure.**

  Run: `node scripts/test-ai-provider.mjs`

  Expected: failure `ERR_MODULE_NOT_FOUND` for `ai-provider-config.js`.

- [ ] **Step 3: Define the smallest stable shared shapes.**

  In `src/shared/ai-contracts.js`, retain existing constants and add only the values used below:

  ```js
  export const AI_PROVIDER_KIND = 'openai-compatible'

  export function assertAiEventStream(stream) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('invalid-ai-event-stream')
    }
    return stream
  }
  ```

  Update `assertProviderAdapter` so it still checks the four method names and additionally validates `adapter.invoke(...)` only at call sites with `assertAiEventStream`; do not call a provider during shape validation.

- [ ] **Step 4: Implement endpoint normalization, then rerun the tests.**

  Create `src/main/ai/ai-provider-config.js` with an exported `normalizeAiProviderConfig(input)` that:

  ```js
  const url = new URL(String(input?.baseUrl || '').trim())
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) throw new Error('invalid-ai-base-url')
  if (url.username || url.password || url.hash || url.search) throw new Error('invalid-ai-base-url')
  const model = String(input?.model || '').trim()
  if (!model || model.length > 200) throw new Error('invalid-ai-model')
  return { kind: 'openai-compatible', baseUrl: url.href.replace(/\/$/, ''), model }
  ```

  The final implementation must also reject `file:`, custom schemes, credentials, and non-loopback cleartext HTTP. It must preserve a configured base path such as `/v1`, not append `/v1` twice.

  Run: `npm run test:ai-core && npm run test:ai-provider`

  Expected: both pass.

- [ ] **Step 5: Commit the contract.**

  ```bash
  git add src/shared/ai-contracts.js src/main/ai/ai-provider-config.js scripts/test-ai-core.mjs scripts/test-ai-provider.mjs package.json
  git commit -m "feat(ai): define compatible provider contract"
  ```

## Task 2: Add encrypted settings, streaming adapter, and grammar service

**Files:**
- Create: `src/main/ai/ai-credential-store.js`
- Create: `src/main/ai/ai-provider-store.js`
- Create: `src/main/ai/openai-compatible-adapter.js`
- Create: `src/main/ai/provider-registry.js`
- Create: `src/main/ai/grammar-service.js`
- Modify: `scripts/test-ai-provider.mjs`
- Create: `scripts/test-ai-grammar.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write deterministic adapter failures first.**

  Expand `scripts/test-ai-provider.mjs` with an injected response stream split in the middle of an SSE JSON line:

  ```js
  const events = []
  for await (const event of adapter.invoke({
    request: { provider: 'openai-compatible', model: 'grammar-1', messages: [{ role: 'user', content: 'x' }] },
    signal: new AbortController().signal
  })) events.push(event)
  assert.deepEqual(events.map(({ type, text }) => [type, text || null]), [
    ['start', null], ['delta', '{"after":"better"}'], ['finish', null]
  ])
  ```

  Cover six more cases: `[DONE]`; a 401 response maps to `auth`; 429 maps to `rate-limit`; a malformed SSE JSON frame maps to `invalid-response`; an abort maps to `canceled`; and timeout maps to `timeout`. The mock `fetch` must capture a POST to `<baseUrl>/chat/completions`, `Authorization: Bearer test-key`, `stream: true`, and `store: false`.

- [ ] **Step 2: Run tests to see the missing-adapter failure.**

  Run: `node scripts/test-ai-provider.mjs`

  Expected: failure that `openai-compatible-adapter.js` cannot be imported.

- [ ] **Step 3: Implement the storage boundaries.**

  Create two AI-local stores rather than changing `src/main/sync/credential-store.js`:

  - `AiCredentialStore({ userDataPath, safeStorage })` writes only encrypted base64 values to `userDataPath/ai/credentials.json`, using mode `0600`, a random temp filename, and atomic rename. `get('default')` returns `null` for a missing key; `set` throws `ai-credential-unavailable` when `safeStorage.isEncryptionAvailable()` is false.
  - `AiProviderStore({ userDataPath })` atomically stores the nonsecret normalized `{ kind, baseUrl, model }` in `userDataPath/ai/provider.json`. Its public `get()` returns `null` for a missing file; `set()` accepts only `normalizeAiProviderConfig` output.

  Test each store with a temporary directory and a reversible fake `safeStorage`; assert the credentials file never contains `test-key` as plaintext. Do not reuse or change the sync credentials path or its user-facing errors.

- [ ] **Step 4: Implement the adapter as an event stream.**

  `createOpenAiCompatibleAdapter({ fetch })` must return the `capabilities`, `validateConfig`, `invoke`, and `cancel` methods required by Phase 0. `invoke({ request, config, apiKey, signal })` must:

  ```js
  const endpoint = new URL('chat/completions', `${config.baseUrl}/`).href
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: request.model, messages: request.messages, stream: true, store: false }),
    signal,
    redirect: 'error',
    bypassCustomProtocolHandlers: true
  })
  ```

  Yield `createAiEvent('start')`, decode UTF-8 SSE frames across arbitrary chunk boundaries, yield nonempty `choices[0].delta.content` values as `delta`, stop only after `[DONE]`, then yield `finish`. Reject a successful response with no content or no `[DONE]` as `invalid-response`. Read at most 256 KiB of error text before mapping it. Never follow a redirect while carrying the API key; reject a response whose final URL is not same-origin as the configured endpoint.

  The adapter must not import `electron`; production injects `net.fetch`, tests inject a fake fetch. `redirect: 'error'` is required because credentials must never be replayed to a redirect target; do not inspect `Response.url` because Electron documents it as unreliable for `net.fetch`. `cancel` delegates to a registry-owned `AbortController`, not to a renderer-supplied process handle.

- [ ] **Step 5: Implement registry and service from failing grammar tests.**

  In `scripts/test-ai-grammar.mjs`, first assert that `GrammarService.check`:

  ```js
  const result = await service.check({
    requestId: 'r1', markdown: 'This are sentence.', start: 0, end: 18
  })
  assert.equal(result.proposal.before, 'This are sentence.')
  assert.equal(result.proposal.after, 'This is a sentence.')
  assert.equal(result.explanation, 'Subject-verb agreement.')
  assert.equal(result.proposal.source, 'ai-grammar')
  ```

  Add failing cases for: absent configuration/key (`auth`); empty or unchanged `after`; JSON wrapped in a code fence; a response with an extra key; multiline `after`; after text containing `~~` or `~>`; cancel; timeout; and stale validation after Markdown changes.

  Then implement `ProviderRegistry` with a `Map<requestId, AbortController>`, `cancel(requestId)`, and `invoke(requestId, request)`. Implement `GrammarService` to:

  1. Create `createContextSnapshot({ markdown, scope: 'selection', selection: { start, end } })`.
  2. Send only `snapshot.content` in a fixed system instruction that requires exactly `{"after":"...","explanation":"..."}` and forbids newlines/Markdown markers.
  3. Accumulate `delta` events up to 64 KiB, parse exactly one JSON object, validate its two string keys and bounds, and call `createChangeProposal({ markdown, start, end, after, source: 'ai-grammar' })`.
  4. Expose `validate({ markdown, proposal })` by delegating to `validateChangeProposal` and reject another `source` value.
  5. Delete the request ID in `finally`, including cancellation and parser failures.

  Run: `npm run test:ai-provider && node scripts/test-ai-grammar.mjs`

  Expected: both pass without a network connection.

- [ ] **Step 6: Commit the main-process core.**

  ```bash
  git add src/main/ai scripts/test-ai-provider.mjs scripts/test-ai-grammar.mjs package.json
  git commit -m "feat(ai): add compatible grammar provider service"
  ```

## Task 3: Register narrow desktop IPC and the redacted renderer contract

**Files:**
- Create: `src/main/ai-ipc.js`
- Modify: `src/main/index.js`
- Modify: `src/preload/index.js`
- Modify: `src/renderer/src/platform/capacitor-api.js`
- Modify: `scripts/test-ai-grammar.mjs`
- Modify: `scripts/test-main-security.mjs`

- [ ] **Step 1: Add failing IPC/security assertions.**

  Test the handler factory directly with fake `ipcMain.handle`, `safeStorage`, and `net.fetch`. Assert the renderer-visible settings object is exactly:

  ```js
  { configured: true, provider: { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'grammar-1' }, hasApiKey: true }
  ```

  Assert no handler returns `apiKey`, credential ciphertext, `userDataPath`, or arbitrary `fetch` arguments. Assert unknown provider fields and an arbitrary URL scheme are rejected.

- [ ] **Step 2: Run the test and confirm missing IPC registration.**

  Run: `node scripts/test-ai-grammar.mjs && node scripts/test-main-security.mjs`

  Expected: AI IPC import/handler assertions fail; existing security assertions still pass.

- [ ] **Step 3: Implement `registerAiIpc`.**

  `src/main/ai-ipc.js` must construct its own stores/registry/service from `{ app, ipcMain, safeStorage, net }` and register only these handlers:

  ```js
  'ai:provider:get'       // -> redacted provider summary
  'ai:provider:save'      // accepts { baseUrl, model, apiKey? }, stores a key only when nonempty
  'ai:provider:removeKey' // removes only the default AI credential
  'ai:grammar:check'      // accepts { requestId, markdown, start, end }
  'ai:grammar:cancel'     // accepts { requestId }
  'ai:grammar:validate'   // accepts { markdown, proposal }
  ```

  The preload names are `window.api.ai.providerGet`, `providerSave`, `providerRemoveKey`, `grammarCheck`, `grammarCancel`, and `grammarValidate`; each is a fixed `ipcRenderer.invoke` wrapper around the corresponding channel. Do not expose generic `invoke`, `fetch`, or a caller-selected channel.

  Enforce maximum local IPC sizes before passing data to the service: Markdown 500,000 chars, selection 20,000 chars, request id 128 chars. `src/main/index.js` must call this factory after `app.whenReady()` and before renderer interactions are accepted.

  `src/preload/index.js` exposes the same six methods below `api.ai`; `capabilities.ai` is true only for desktop. `capacitor-api.js` exposes no `ai` object and adds `ai: false` to capabilities. The React UI must use `capabilities.ai`, never platform-name checks alone.

- [ ] **Step 4: Verify the contract and build a commit.**

  Run: `npm run test:ai && npm run test:security && npm run build:mobile`

  Expected: passes; the mobile build contains no Node/Electron import.

  ```bash
  git add src/main/ai-ipc.js src/main/index.js src/preload/index.js src/renderer/src/platform/capacitor-api.js scripts/test-ai-grammar.mjs scripts/test-main-security.mjs
  git commit -m "feat(ai): expose redacted desktop grammar IPC"
  ```

## Task 4: Add desktop AI settings without retaining a key in React state

**Files:**
- Create: `src/renderer/src/hooks/useAiProviderSettings.js`
- Create: `src/renderer/src/components/settings/AiSettings.jsx`
- Modify: `src/renderer/src/components/settings/SettingsNav.jsx`
- Modify: `src/renderer/src/components/SettingsView.jsx`
- Modify: `src/renderer/src/App.jsx`
- Modify: `src/renderer/src/i18n.jsx`
- Modify: `src/renderer/src/styles/app.css`
- Modify: `scripts/test-settings-view-ui.mjs`

- [ ] **Step 1: Write the UI test before the form.**

  Extend `scripts/test-settings-view-ui.mjs` to open Settings, assert the AI navigation item is absent when `capabilities.ai` is false, then with desktop capability enabled assert:

  ```js
  assert.equal(await text('[data-settings-section="ai"] h2'), 'AI')
  assert.equal(await inputType('[name="ai-api-key"]'), 'password')
  assert.equal(await value('[name="ai-api-key"]'), '')
  assert.equal(await text('[data-ai-key-status]'), 'API key saved')
  ```

  Submit a base URL/model/key and assert the invoked preload method receives the key once; reload the section and assert the field is blank although `hasApiKey` remains true. Add a clear-key assertion.

- [ ] **Step 2: Run the test and observe the absent section.**

  Run: `npm run test:settings-ui`

  Expected: failure because `data-settings-section="ai"` does not exist.

- [ ] **Step 3: Implement a dedicated hook and form.**

  `useAiProviderSettings` loads `window.api.ai.providerGet()` only when `window.api.capabilities.ai`; it stores a redacted `summary`, a `save({ baseUrl, model, apiKey })` action, and `removeKey()`. It must not mirror the key into `localStorage` or app settings.

  `AiSettings.jsx` keeps its password input in local component state only. It uses:

  ```jsx
  <input name="ai-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
  ```

  After a successful save it calls `setApiKey('')`. Add an AI `SettingsNav` item only when the `ai` prop is true and render `AiSettings` only for `active === 'ai'`. Pass the hook output from `App.jsx` through `SettingsView`; do not introduce AI settings into the global `horsemd.settings.v1` object.

  Add concise Chinese and English strings for AI, compatible endpoint, model, API key, saved/not configured, save, remove key, and URL validation. CSS must reuse existing `.settings-*` controls and keep a 44px minimum action target; it must not introduce a card-inside-card layout.

- [ ] **Step 4: Run settings and shared-renderer verification.**

  Run: `npm run test:settings-ui && npm run build:mobile`

  Expected: pass; mobile has no visible AI navigation entry.

- [ ] **Step 5: Commit settings.**

  ```bash
  git add src/renderer/src/hooks/useAiProviderSettings.js src/renderer/src/components/settings/AiSettings.jsx src/renderer/src/components/settings/SettingsNav.jsx src/renderer/src/components/SettingsView.jsx src/renderer/src/App.jsx src/renderer/src/i18n.jsx src/renderer/src/styles/app.css scripts/test-settings-view-ui.mjs
  git commit -m "feat(ai): add desktop compatible provider settings"
  ```

## Task 5: Make selection snapshots and CriticMarkup application exact

**Files:**
- Modify: `src/renderer/src/reviewMarkup.js`
- Modify: `src/renderer/src/components/editor-review.js`
- Modify: `src/renderer/src/components/editor-api.js`
- Modify: `scripts/review-markup.test.mjs`
- Create: `scripts/test-ai-grammar-selection.mjs`

- [ ] **Step 1: Add pure review tests before changing the editor.**

  Add to `scripts/review-markup.test.mjs`:

  ```js
  assert.equal(makeSubstitutionMarkup('She go home.', 'She goes home.'), '{~~She go home.~>She goes home.~~}')
  assert.throws(() => makeSubstitutionMarkup('two\nlines', 'one line'), /multiline/)
  assert.throws(() => makeSubstitutionMarkup('x', 'x~~y'), /unsafe-substitution/)
  ```

  `scripts/test-ai-grammar-selection.mjs` must construct small ProseMirror documents and prove `getGrammarSelection()` returns the raw `{ markdown, start, end, text }` only for an exact inline paragraph selection. Assert a link/strong-mark selection, code block, hard line break, table cell, multi-block selection, empty selection, existing CriticMarkup, and a deliberately unmappable source return a stable error code and never call AI IPC.

- [ ] **Step 2: Run the focused tests and confirm they fail.**

  Run: `npm run test:review && node scripts/test-ai-grammar-selection.mjs`

  Expected: failure because `makeSubstitutionMarkup` and `getGrammarSelection` are absent.

- [ ] **Step 3: Implement safe marker construction and one-transaction insertion.**

  Export `makeSubstitutionMarkup(before, after)` from `reviewMarkup.js`. It must require nonempty, different, single-line strings and reject any `~~`, `~>`, `{~~`, or newline in either field. It returns exactly:

  ```js
  return `{~~${before}~>${after}~~}`
  ```

  Add `applyGrammarSubstitutionInView(view, before, after)` to `editor-review.js`. It must compare `view.state.doc.textBetween(from, to, '\n')` to `before`, replace that one selection with `makeSubstitutionMarkup(before, after)`, select the inserted marker text as appropriate for the existing review plugin, dispatch one `scrollIntoView()` transaction, focus the view, and return `{ ok: true }`. A mismatch returns `{ ok: false, reason: 'selection-changed' }` without dispatching.

- [ ] **Step 4: Add exact editor API methods.**

  In `createEditorApi`, add:

  ```js
  getGrammarCurrentMarkdown()
  getGrammarSelection()
  applyGrammarProposal(proposal)
  ```

  `getGrammarCurrentMarkdown()` is the sole public grammar source accessor: it returns `flushMarkdown({ force: true })` or `null` when source preservation cannot prove the current rich transaction. `getGrammarSelection()` calls it first, verifies one non-code textblock, maps both current ProseMirror endpoints with `pmPosToMarkdownOffset`, requires `markdown.slice(start, end) === textBetween`, and returns the four-field snapshot. It must not use DOM text, global text search, or a best-effort duplicate-text match.

  `applyGrammarProposal(proposal)` forces a fresh flush, uses `markdownOffsetToPmPos` for both proposal endpoints, ensures current Markdown equals the proposal baseline is already validated by main, rechecks the ProseMirror `before` text, calls `applyGrammarSubstitutionInView`, and calls `markUserEdit()` only on success. It returns its failure reason rather than silently applying to another range.

- [ ] **Step 5: Run the selection and review regression set.**

  Run: `npm run test:review && node scripts/test-ai-grammar-selection.mjs && npm run test:source-map && node scripts/test-strike-guard.mjs`

  Expected: all pass; no review parser behavior changes outside safe substitutions.

- [ ] **Step 6: Commit the narrow editing primitive.**

  ```bash
  git add src/renderer/src/reviewMarkup.js src/renderer/src/components/editor-review.js src/renderer/src/components/editor-api.js scripts/review-markup.test.mjs scripts/test-ai-grammar-selection.mjs
  git commit -m "feat(ai): apply grammar proposals as review substitutions"
  ```

## Task 6: Add the toolbar Grammar card and lifecycle guards

**Files:**
- Create: `src/renderer/src/components/editor-grammar.js`
- Modify: `src/renderer/src/components/editor-toolbar.js`
- Modify: `src/renderer/src/components/editor-dom-bindings.js`
- Modify: `src/renderer/src/components/Editor.jsx`
- Modify: `src/renderer/src/components/shell/EditorArea.jsx`
- Modify: `src/renderer/src/i18n.jsx`
- Modify: `src/renderer/src/styles/app.css`
- Create: `scripts/test-ai-grammar-ui.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create an end-to-end test with a local mock provider.**

  `scripts/test-ai-grammar-ui.mjs` must use `scripts/lib/electron-test-app.mjs` background launch and an ephemeral loopback HTTP server that emits chunk-split SSE. It must drive the real settings form, select `This are sentence.` in a rich document, and assert all of these user-visible states:

  ```js
  await expectVisible('.hm-grammar-card[data-state="loading"]')
  await expectText('.hm-grammar-before', 'This are sentence.')
  await expectText('.hm-grammar-after', 'This is a sentence.')
  await click('[data-ai-grammar-apply]')
  await expectEditorMarkdown('{~~This are sentence.~>This is a sentence.~~}')
  ```

  Add independent cases for unconfigured provider, cancel, a 401 message, retry after a 429 response, selection changed before Apply, tab switch while waiting, and close/unmount during a pending request. The test must confirm model-provided `<img onerror=...>` renders as text and never creates an image element.

- [ ] **Step 2: Run it before implementation.**

  Run: `node scripts/test-ai-grammar-ui.mjs`

  Expected: failure because there is no Grammar toolbar item.

- [ ] **Step 3: Implement a self-contained card controller.**

  `editor-grammar.js` owns one card per editor API and exposes `runGrammarCheck({ toolbar, t })` plus `destroy()`. On click it snapshots first; only then creates a request id. Its state machine is:

  ```text
  idle -> loading -> ready -> applying -> idle
                 \-> error -> loading (retry)
                 \-> canceled -> idle
  ```

  It must cancel the exact request on Cancel, card close, editor destroy, or when its editor becomes hidden after a tab/source-mode change. Pass `isEditorVisible={inView && !sourceMode}` from `components/shell/EditorArea.jsx` into `Editor.jsx`; an effect calls the controller's `cancel()` when it turns false. Before Apply it gets `api.getGrammarCurrentMarkdown()` and calls `window.api.ai.grammarValidate({ markdown, proposal })`; only an `{ ok: true }` result may call `api.applyGrammarProposal(proposal)`. A stale/mismatch result replaces the card with a retryable `selection changed` state; it must not apply the old correction.

  Build every model-owned label/value via `document.createElement` and `textContent`. Set `role="dialog"`, an accessible label, Escape-to-close, a visible close button, `aria-busy` during loading, and button disabled states. Keep focus on the editor selection while opening the card; do not steal selection on `mousedown`.

- [ ] **Step 4: Inject only one toolbar action.**

  Extend `createToolbarScanner` with an `hm-grammar-item` injected after existing Review. Its click resolves the focused editor exactly like the existing injected controls and calls that editor's grammar controller. Update the title-selector exclusion list so the five built-in toolbar tooltips remain aligned.

  Thread only the controller factory through `editor-dom-bindings.js` and `Editor.jsx`. Do not add long-lived AI state to `App.jsx`, add a second toolbar observer, or make requests from the renderer. The item is absent unless `window.api.capabilities.ai` is true.

- [ ] **Step 5: Style the anchored card as a compact review tool.**

  In `app.css`, position `.hm-grammar-card` relative to the selection toolbar with a constrained width (`min(360px, calc(100vw - 32px))`), use existing surface/border/shadow variables, and let long words wrap. Render before/after with existing review deletion/addition colors. Include visible focus outlines and a `@media (max-width: 480px)` position rule. Do not create a modal overlay, sidebar, or new page shell.

- [ ] **Step 6: Run focused UI and editor checks, then commit.**

  Run: `npm run test:selection-toolbar-ui && npm run test:review-ui && node scripts/test-ai-grammar-ui.mjs`

  Expected: all pass using the new background Electron helper and a freshly built app.

  ```bash
  git add src/renderer/src/components/editor-grammar.js src/renderer/src/components/editor-toolbar.js src/renderer/src/components/editor-dom-bindings.js src/renderer/src/components/Editor.jsx src/renderer/src/components/shell/EditorArea.jsx src/renderer/src/i18n.jsx src/renderer/src/styles/app.css scripts/test-ai-grammar-ui.mjs package.json
  git commit -m "feat(ai): add selection grammar review card"
  ```

## Task 7: Document, release, and verify the completed feature

**Files:**
- Modify: `guide/customization/settings.md`
- Modify: `guide/productivity/review.md`
- Modify: `guide/public/llms.txt`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `ROADMAP.md`
- Modify: `docs/ai-vmark-phase-plan.md`

- [ ] **Step 1: Update user documentation with actual scope.**

  Add a short AI section to `guide/customization/settings.md`: desktop only, compatible endpoint/model/key, operating-system protected key, selected text is sent only after the user invokes Grammar, and removing the key disables requests. Add an entry to `guide/productivity/review.md`: choose text → Grammar → inspect before/after → Apply as review → use existing accept/reject. State that code, tables, multi-line/multi-block text, source mode, and mobile are intentionally unsupported.

  Update `guide/public/llms.txt` only if a new `/customization/ai` page is created; this plan instead extends existing pages, so do not add a dead route. Do not add a screenshot unless it is captured from the rebuilt, freshly installed current application using an isolated profile and contains no local paths.

- [ ] **Step 2: Align roadmap claims with shipped behavior.**

  In `ROADMAP.md` and `docs/ai-vmark-phase-plan.md`, record that a limited desktop selection grammar flow is available as a deliberately scoped bridge between read-only Provider and Review-first Phase 2. Preserve the deferred multi-provider/assistant/agent scope; do not mark those phases complete.

- [ ] **Step 3: Bump the patch release and changelog.**

  Change version `0.13.29` to `0.13.30` in `package.json`, regenerate `package-lock.json` with `npm install --package-lock-only`, and add one `CHANGELOG.md` entry describing compatible provider configuration and manual selected-text grammar review. Do not change the minor version.

- [ ] **Step 4: Run the release verification matrix.**

  Run, in this order:

  ```bash
  npm run test:ai
  npm run test:security
  npm run test:source-map
  npm run test:review
  npm run test:criticmarkup
  npm run test:settings-ui
  npm run test:selection-toolbar-ui
  npm run test:review-ui
  node scripts/test-ai-grammar-ui.mjs
  npm run build
  npm run build:mobile
  npm run guide:check
  ```

  Expected: every command exits 0. If any existing regression fails, use `superpowers:systematic-debugging` before changing implementation; do not mask it by weakening the test.

- [ ] **Step 5: Install and inspect the actual desktop app before manual handoff.**

  Build an unsigned macOS directory app, terminate any old HorseMD/Electron processes, copy the rebuilt app to `/Applications/HorseMD.app`, clear quarantine, launch it with an isolated profile, and verify its `app.asar` has version `0.13.30` and the Grammar marker string. Capture desktop and narrow-window screenshots only after these checks. Then commit:

  ```bash
  git add guide/customization/settings.md guide/productivity/review.md CHANGELOG.md ROADMAP.md docs/ai-vmark-phase-plan.md package.json package-lock.json
  git commit -m "docs: document AI grammar review"
  ```

## Final review checklist

- [ ] No code from the deleted `codex/ai-provider-grammar-check` branch was copied wholesale; all touched files are reconciled against `ea4415b`.
- [ ] There is exactly one provider configuration kind and no provider SDK dependency.
- [ ] `apiKey` is absent from all renderer return values, localStorage, logs, errors, screenshots, test snapshots, and source comments.
- [ ] `net.fetch` is called only in the Electron main process with an allowed `https:` or loopback `http:` target and `bypassCustomProtocolHandlers: true`.
- [ ] Grammar request body includes only fixed instructions and selected text; full Markdown never crosses the network boundary.
- [ ] A changed document, changed selection, cancellation, tab change, or unmount cannot apply an old proposal.
- [ ] All model output uses text nodes and all mutation flows through existing CriticMarkup review semantics.
- [ ] Desktop UI is gated by `capabilities.ai`; mobile builds remain functional with the feature absent.
