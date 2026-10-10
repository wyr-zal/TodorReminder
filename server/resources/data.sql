USE `focus_memo`;
-- 仅开发测试：会清除测试数据。先将 resources/fixtures/attachments 的三个文件复制到测试附件目录。
DELETE FROM mutation_receipts;
DELETE FROM memos;
DELETE FROM attachments;
INSERT INTO attachments (id, storage_key, mime_type, size_bytes, sha256, ready) VALUES
('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', '2ad8aec8bb4279ea6c085355e1b5d5f4406e74801b772bea04ffdf8ab365a845', 'image/png', 69, 'b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640', 1),
('aaaaaaaa-aaaa-4aaa-8aaa-000000000002', '6e6071713f28305342336c15c81cd2273d434576cddbb82fdaa56397f262fac3', 'image/png', 69, '64abf93fb4c16b4258aa6eff5660a6b97b013a1b9c0cc877fcceb14c6764680f', 1),
('aaaaaaaa-aaaa-4aaa-8aaa-000000000003', '3e74f657bd757043426933f12c766755032be9bc413566a90a97274f66033fc9', 'image/png', 69, 'fce481932ea5d07a91c7991c09fdadb4bf78f9b4cc8f927188384231f9d12679', 1);

INSERT INTO memos (id, content, type, priority, status, tags, attachment_ids, created_at, updated_at, completed_at) VALUES
('00000000-0000-4000-8000-000000000001', '测试待办 1', 'text', 'unimportant', 'not_started', '["测试"]', '[]', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000', NULL),
('00000000-0000-4000-8000-000000000002', '测试待办 2', 'text', 'unimportant', 'not_started', '["测试"]', '[]', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000', NULL),
('00000000-0000-4000-8000-000000000003', '测试待办 3', 'image', 'important', 'not_started', '["测试"]', '["aaaaaaaa-aaaa-4aaa-8aaa-000000000001"]', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000', NULL),
('00000000-0000-4000-8000-000000000004', '测试待办 4', 'text', 'unimportant', 'in_progress', '["测试"]', '[]', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000', NULL),
('00000000-0000-4000-8000-000000000005', '测试待办 5', 'text', 'unimportant', 'in_progress', '["测试"]', '[]', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000', NULL),
('00000000-0000-4000-8000-000000000006', '测试待办 6', 'image', 'important', 'in_progress', '["测试"]', '["aaaaaaaa-aaaa-4aaa-8aaa-000000000002"]', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000', NULL),
('00000000-0000-4000-8000-000000000007', '测试待办 7', 'text', 'unimportant', 'completed', '["测试"]', '[]', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000'),
('00000000-0000-4000-8000-000000000008', '测试待办 8', 'text', 'unimportant', 'completed', '["测试"]', '[]', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000'),
('00000000-0000-4000-8000-000000000009', '测试待办 9', 'image', 'important', 'completed', '["测试"]', '["aaaaaaaa-aaaa-4aaa-8aaa-000000000003"]', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000', '2026-10-08 00:00:00.000');
