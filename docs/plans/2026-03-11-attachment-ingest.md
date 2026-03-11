# Attachment Ingest (Main Chat + Feishu) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users send files/images from main chat and Feishu, ingest them through one pipeline, and inject readable attachment context into AI messages with strict limits (20MB/file, 100MB/round).

**Architecture:** Add a unified main-process ingest module (`electron/ai/attachment-ingest.js`) that validates, stores, extracts/degrades attachment content, and returns normalized blocks. Wire both renderer uploads and Feishu inbound attachments to this module, then append normalized attachment context to the user message before orchestrator execution.

**Tech Stack:** Electron main/preload IPC, Vue 3 ChatPanel, existing Feishu adapter/notify stack, Node.js fs/path/crypto, existing OpenUltron AI gateway/orchestrator flow.

---

### Task 1: Add attachment ingest core module

**Files:**
- Create: `electron/ai/attachment-ingest.js`
- Modify: `electron/app-root.js`
- Test: `electron/ai/__tests__/attachment-ingest.test.js`

**Step 1: Write the failing test**

```js
// electron/ai/__tests__/attachment-ingest.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestRoundAttachments } from '../attachment-ingest.js'

test('rejects file larger than 20MB', async () => {
  const over = 20 * 1024 * 1024 + 1
  const out = await ingestRoundAttachments({
    sessionId: 's1',
    source: 'main',
    attachments: [{ name: 'big.bin', mime: 'application/octet-stream', size: over, data: Buffer.alloc(16) }]
  })
  assert.equal(out.accepted.length, 0)
  assert.equal(out.rejected.length, 1)
})
```

**Step 2: Run test to verify it fails**

Run: `node --test electron/ai/__tests__/attachment-ingest.test.js`
Expected: FAIL with module/function missing

**Step 3: Write minimal implementation**

```js
// export async function ingestRoundAttachments({ sessionId, source, attachments })
// return { accepted: [], rejected: [], blocks: [], totalAcceptedBytes: 0 }
```

Implement:
- file size limit: 20MB
- round size limit: 100MB
- save accepted files under `~/.openultron/workspace/attachments/<sessionId>/`
- create per-file `meta.json`
- classify types: text/image/file
- text extraction with truncation
- image OCR/vision placeholder hook with degrade fallback

**Step 4: Run test to verify it passes**

Run: `node --test electron/ai/__tests__/attachment-ingest.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add electron/ai/attachment-ingest.js electron/app-root.js electron/ai/__tests__/attachment-ingest.test.js
git commit -m "feat(ai): add unified attachment ingest core"
```

### Task 2: Expose renderer upload IPC and preload API

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.js`
- Modify: `src/api/browserPolyfill.js`

**Step 1: Write the failing test/manual check case**

Create a temporary renderer call in ChatPanel dev path:
```js
await window.electronAPI.ai.uploadAttachments({ sessionId: 'x', files: [] })
```
Expected before implementation: `uploadAttachments is not a function`

**Step 2: Run check to verify failure**

Run app in dev and trigger call.
Expected: renderer API missing

**Step 3: Write minimal implementation**

Add IPC channel:
- `ai-upload-attachments` in `electron/main.js`
- Preload API: `electronAPI.ai.uploadAttachments(payload)`
- Polyfill fallback mapping in `src/api/browserPolyfill.js`

Payload shape:
- `sessionId`
- `source: 'main'`
- `attachments: [{ name, mime, size, dataBase64 }]`

Return shape:
- `{ success, accepted, rejected, blocks, totalAcceptedBytes }`

**Step 4: Run check to verify pass**

Run app and call once from renderer.
Expected: Promise resolves with structured result

**Step 5: Commit**

```bash
git add electron/main.js electron/preload.js src/api/browserPolyfill.js
git commit -m "feat(ipc): expose attachment upload API for renderer"
```

### Task 3: Main chat input attachment UX and send flow

**Files:**
- Modify: `src/components/ai/ChatPanel.vue`
- Modify: `src/composables/useI18n.js`

**Step 1: Write failing UI behavior spec (manual)**

Expected behavior (currently missing):
- select files/images from chat input
- drag/drop file into chat panel
- paste image into input
- selected attachment list visible/removable

**Step 2: Verify current behavior fails**

Run: `npm run electron:dev`
Expected: no attachment picker/list or no send integration

**Step 3: Write minimal implementation**

In `ChatPanel.vue`:
- add attachment button + hidden `<input type="file" multiple>`
- add drag/drop handlers on input container
- add paste handler for clipboard image files
- maintain `pendingAttachments` state
- on send:
  - convert selected files to base64 payload
  - call `electronAPI.ai.uploadAttachments`
  - append returned attachment context text to outgoing user content
  - clear attachments on success; keep failed entries with reason

In `useI18n.js`:
- add zh/en copy for attachment labels/errors/limits

**Step 4: Run verification**

Run: `npm run build`
Expected: PASS

Manual:
- add txt + png + zip and send one round
- verify message includes attachment context

**Step 5: Commit**

```bash
git add src/components/ai/ChatPanel.vue src/composables/useI18n.js
git commit -m "feat(chat): support file/image selection drag-drop and paste in input"
```

### Task 4: Feishu inbound attachment ingestion

**Files:**
- Modify: `electron/ai/feishu-ws-receive.js`
- Modify: `electron/extensions/adapters/feishu.js`
- Modify: `electron/ai/feishu-notify.js` (if download helper needed)

**Step 1: Write failing behavior spec (manual)**

Current failure:
- Feishu inbound image/file not consistently injected as readable AI context

**Step 2: Verify failure**

Send image/file to Feishu bot.
Expected: AI receives only text or misses attachment content

**Step 3: Write minimal implementation**

- parse image/file payload from Feishu events in receiver layer
- download attachment bytes to buffer/temp file
- call `ingestRoundAttachments({ source: 'feishu' ... })`
- compose inbound message text:
  - original user text
  - normalized attachment blocks summary
- emit `chat.message.received` with merged user content

Failure handling:
- if one attachment fails, continue others
- optionally reply concise failure note only when all fail

**Step 4: Run verification**

Manual end-to-end:
- send text+image, text+file, file-only from Feishu
Expected: AI can reference attachment-derived context

**Step 5: Commit**

```bash
git add electron/ai/feishu-ws-receive.js electron/extensions/adapters/feishu.js electron/ai/feishu-notify.js
git commit -m "feat(feishu): ingest inbound image/file attachments for AI context"
```

### Task 5: Context format hardening and guardrails

**Files:**
- Modify: `electron/ai/orchestrator.js`
- Modify: `electron/main.js`

**Step 1: Write failing test/check case**

Case: large extracted content can bloat context and trigger provider errors.

**Step 2: Verify failure risk**

Simulate long text attachment (>100k chars) and observe message payload growth.

**Step 3: Write minimal implementation**

- enforce per-attachment extracted text cap (e.g. 8KB)
- enforce per-round injected attachment text cap
- include truncation markers
- ensure injected blocks are plain user content, not tool call payload

**Step 4: Run verification**

Run:
- `node --check electron/ai/orchestrator.js`
- `npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add electron/ai/orchestrator.js electron/main.js
git commit -m "fix(ai): cap attachment context injection to avoid prompt bloat"
```

### Task 6: Docs and final verification

**Files:**
- Modify: `README.md`
- Modify: `README.en.md` (if present)
- Modify: `docs/plans/2026-03-11-attachment-ingest-design.md` (link implementation status)

**Step 1: Write failing acceptance checklist**

Checklist:
- main chat attachments work
- Feishu inbound attachments work
- 20MB/100MB limits enforced
- graceful degrade for unsupported formats

**Step 2: Run full verification**

Run:
- `node --test electron/ai/__tests__/attachment-ingest.test.js`
- `npm run build`
- `npm run electron:dev` manual E2E (main + Feishu)

Expected: all pass

**Step 3: Write docs**

Document:
- supported file types behavior
- limits and error messages
- storage path and privacy notes

**Step 4: Commit**

```bash
git add README.md README.en.md docs/plans/2026-03-11-attachment-ingest-design.md
git commit -m "docs: add attachment ingest usage and limits"
```
