# Focus Memo Agent CLI

The Agent CLI exposes the memo HTTP API as a JSON command. It uses the active app configuration and never reads or writes `memos.db` directly.

## Commands

List unfinished memos, search text, and filter by status, priority, or tag:

```bash
npm run memo:agent -- list --status not_started --q report --limit 50
npm run memo:agent -- list --tag work --deleted true
```

Read one memo:

```bash
npm run memo:agent -- get 22222222-2222-4222-8222-222222222222
```

Create, update, complete, restore, and delete:

```bash
npm run memo:agent -- add --content "Prepare the report" --priority important --tag work
npm run memo:agent -- update 22222222-2222-4222-8222-222222222222 --base-version 3 --status in_progress
npm run memo:agent -- complete 22222222-2222-4222-8222-222222222222 --base-version 4
npm run memo:agent -- restore 22222222-2222-4222-8222-222222222222 --base-version 5
npm run memo:agent -- delete 22222222-2222-4222-8222-222222222222 --base-version 6
```

`delete` is a soft delete by default. Permanent deletion requires the explicit `--permanent` flag and a current version:

```bash
npm run memo:agent -- delete 22222222-2222-4222-8222-222222222222 --base-version 7 --permanent
```

Permanent deletion cannot be undone. Read a memo with `get` or `list` first and use its current `version` as `--base-version`; the API rejects stale versions with `version_conflict`. The CLI reports conflicts and does not retry a write automatically.

All normal command output is one JSON object on stdout. Errors also return JSON and a nonzero exit code. Use `--pretty` for indented output. Write responses include the `idempotencyKey`; if you need to retry the same logical operation, pass that exact value using `--idempotency-key`.

## Configuration

By default, the CLI locates `%APPDATA%\focus-memo\storage-location.json`, follows its version 1 `path` to the active data directory, then reads that directory's `cloud-config.json`. If no pointer exists, it uses `%APPDATA%\focus-memo` as the data directory. On non-Windows systems, set `FOCUS_MEMO_USER_DATA_DIR` or pass `--user-data-dir` to the app's user-data directory.

Configuration precedence:

1. Active data directory: `--data-dir`, then `FOCUS_MEMO_DATA_DIR`, then the storage pointer resolved from `--user-data-dir` / `FOCUS_MEMO_USER_DATA_DIR` / `%APPDATA%\focus-memo`.
2. Config file: `--config`, then `FOCUS_MEMO_CONFIG`, then `<active-data-dir>/cloud-config.json`.
3. API URL: `--base-url`, then `FOCUS_MEMO_BASE_URL`, then `url` in `cloud-config.json`.
4. Dataset ID: `--dataset-id`, then `FOCUS_MEMO_DATASET_ID`, otherwise `GET /api/v1/meta` supplies the ID.

Example for an alternate data directory:

```bash
npm run memo:agent -- list --data-dir "D:\\FocusMemoData" --limit 100
```

The API is unauthenticated by design. The CLI sends `X-Focus-Dataset-ID` after resolving the dataset and sends a fresh UUID `Idempotency-Key` for each write. It never sends an `Authorization` header. Creating a memo defaults to `status: not_started`, `priority: unimportant`, and the `TODO` tag when no tag is supplied.

## Validation

Run the isolated CLI tests with:

```bash
npm run test:agent-cli
```

They use a local mock HTTP server and temporary config; they do not contact the configured service or access the desktop database.
