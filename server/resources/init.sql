USE `focus_memo`;
-- 在初始迁移后执行；重复执行不替换现有数据集标识，不包含默认凭证。
INSERT INTO service_meta (id, dataset_id, schema_version)
VALUES (1, UUID(), 1)
ON DUPLICATE KEY UPDATE id = id;
