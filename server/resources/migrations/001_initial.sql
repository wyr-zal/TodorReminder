USE `focus_memo`;
-- 仅在已批准的专用数据库执行；建库、授权及备份由部署阶段单独确认。
CREATE TABLE IF NOT EXISTS service_meta (
 id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
 dataset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 schema_version INT UNSIGNED NOT NULL
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
