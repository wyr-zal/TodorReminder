USE `focus_memo_prod_20261010`;

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
