USE `focus_memo`;
-- 仅供经确认的开发库重建，禁止作为生产升级脚本或自动启动初始化。
DROP TABLE IF EXISTS memo_change_cursor;
DROP TABLE IF EXISTS sync_change_state;
DROP TABLE IF EXISTS mutation_receipts;
DROP TABLE IF EXISTS memos;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS service_meta;

CREATE TABLE IF NOT EXISTS service_meta (
 id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
 dataset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 schema_version INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sync_change_state (
 id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
 sequence BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO sync_change_state (id, sequence) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS memo_change_cursor (
 memo_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 sequence BIGINT UNSIGNED NOT NULL,
 KEY idx_memo_change_sequence (sequence, memo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attachments (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 storage_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 mime_type VARCHAR(64) NOT NULL,
 size_bytes BIGINT UNSIGNED NOT NULL,
 sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 ready TINYINT(1) NOT NULL DEFAULT 0,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY uk_attachment_storage (storage_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS memos (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 content LONGTEXT NOT NULL,
 type VARCHAR(16) NOT NULL DEFAULT 'text',
 priority VARCHAR(16) NOT NULL DEFAULT 'unimportant',
 status VARCHAR(16) NOT NULL DEFAULT 'not_started',
 tags JSON NOT NULL,
 attachment_ids JSON NOT NULL,
 created_at DATETIME(3) NOT NULL,
 updated_at DATETIME(3) NOT NULL,
 completed_at DATETIME(3) NULL,
 device_id VARCHAR(128) NOT NULL DEFAULT 'api',
 version BIGINT UNSIGNED NOT NULL DEFAULT 1,
 deleted TINYINT(1) NOT NULL DEFAULT 0,
 purged TINYINT(1) NOT NULL DEFAULT 0,
 KEY idx_memo_status (deleted, status),
 KEY idx_memo_priority (deleted, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mutation_receipts (
 operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 kind VARCHAR(32) NOT NULL,
 result_json JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
