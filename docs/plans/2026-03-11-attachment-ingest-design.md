# Attachment Ingest Design (Main Chat + Feishu)

## Background
Current OpenUltron chat flow is text-first. Main chat input does not provide a unified attachment pipeline, and Feishu inbound messages are primarily handled as plain text. This causes inconsistent behavior and prevents AI from reliably consuming user-sent files/images across channels.

## Goals
- Support user-selected files/images in main chat input and make them readable by AI.
- Support Feishu inbound files/images and make them readable by AI in the same way.
- Enforce limits:
  - Per file: 20MB
  - Per round total: 100MB
- Keep behavior consistent between main chat and Feishu.

## Non-goals
- Full document parsing for all binary formats (e.g., PDF/DOCX semantic extraction).
- Long-term object storage optimization or deduplication across all sessions.
- New third-party channel support in this phase (Telegram/DingTalk can reuse later).

## Recommended Architecture
Add a unified ingestion module in Electron main process:
- New module: `electron/ai/attachment-ingest.js`
- Inputs:
  - Main chat uploads (renderer -> ipc)
  - Feishu inbound attachments (adapter -> downloader -> ingest)
- Outputs:
  - Saved attachment artifacts under workspace
  - Normalized attachment descriptors for chat message injection

Storage layout:
- `~/.openultron/workspace/attachments/<sessionId>/<timestamp>-<safeName>`
- Sidecar metadata file per attachment: `meta.json`

## Data Flow
1. Attachment arrives (main chat selection / Feishu event).
2. Validate size constraints (single + round total).
3. Persist file to session-scoped attachment folder.
4. Classify by mime/ext:
   - text-like: extract UTF-8 text with truncation.
   - image-like: try visual/OCR path; fallback to metadata if unavailable.
   - binary-like: keep metadata + local path only.
5. Build normalized injection blocks into user message.
6. Continue existing orchestrator flow with augmented message content.

## Message Injection Contract
Each attachment becomes one normalized block with fields:
- `attachment_id`
- `source` (`main` | `feishu`)
- `kind` (`text` | `image` | `file`)
- `name`, `mime`, `size_bytes`, `local_path`
- `status` (`ok` | `degraded` | `failed`)
- optional `extracted_text`
- optional `vision_text`
- optional `error`

Injection strategy:
- text: include metadata + extracted content snippet
- image: include metadata + vision/OCR text if available
- binary: include metadata + local path (AI can read via tools if needed)

## Error Handling and Degrade Rules
- Oversized single file (>20MB): reject this attachment.
- Oversized round total (>100MB): reject overflow attachments.
- Extraction failure: mark `degraded`, keep metadata/path.
- Download failure (Feishu): mark `failed`, continue remaining attachments.
- Timeouts in OCR/vision: degrade to metadata/path.

## UI/UX Changes
Main chat input (`ChatPanel`):
- Add attachment button
- Support drag-and-drop files
- Support paste image
- Show selected attachment chips/list with remove and status

Feishu channel:
- Parse inbound image/file payload from event.
- Download and ingest before calling AI.
- Keep chat continuity if some attachments fail.

## Observability
- Log ingest summary per round (count, total size, accepted/rejected).
- Keep `meta.json` for traceability.
- Surface concise reasons to user/channel when attachments fail.

## Security Considerations
- Sanitize filenames and prevent path traversal.
- Restrict writes to workspace attachment root.
- Avoid executing any attachment content.
- Truncate extracted text to avoid context explosion.

## Acceptance Criteria
- Main chat can send files/images and AI receives normalized readable context.
- Feishu inbound files/images reach AI through same ingestion path.
- Limits (20MB file, 100MB round) enforced and visible.
- No regression on plain text-only chat flow.
