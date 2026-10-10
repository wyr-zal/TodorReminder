# Focus Memo Server API

## 状态与适用范围

- **Base URL**：`https://memo-api.cliproxy.com.cn`
- **API 版本**：`v1`
- **当前用途**：服务端部署在独立测试数据库 `focus_memo_server_test_20261010` 上，数据库中的待办为空。可用于 API 和客户端联调，不是生产数据服务。
- **TLS**：HTTPS 证书和公网健康检查已验证。
- **认证凭据**：API token 保存在服务器 root-only 环境文件中，不应写入本文档、源码、日志或 Git。

所有 JSON 响应均为 UTF-8。除 `GET /healthz` 外，所有接口都必须带认证头：

```http
Authorization: Bearer <API_TOKEN>
```

可选数据集保护头：

```http
X-Focus-Dataset-ID: <datasetId>
```

客户端设置该头后，服务端会校验请求是否仍针对该数据集；格式无效返回 `422`，数据集不匹配返回 `409`。

所有写入接口都必须带唯一的 UUID 幂等键：

```http
Idempotency-Key: <UUID>
```

同一次操作重试时必须复用原幂等键；新的逻辑操作必须生成新的 UUID。相同键若用于不同请求会返回 `409 idempotency_mismatch`。

## 接口总览

| 方法 | 路径 | 说明 | 认证 | 幂等键 |
| --- | --- | --- | --- | --- |
| `GET` | `/healthz` | 服务与数据库健康检查 | 不需要 | 不需要 |
| `GET` | `/api/v1/meta` | 获取数据集 ID 与 schema 版本 | 需要 | 不需要 |
| `POST` | `/api/v1/memos` | 创建待办 | 需要 | 必须 |
| `GET` | `/api/v1/memos` | 查询待办列表 | 需要 | 不需要 |
| `GET` | `/api/v1/memos/{id}` | 获取单条待办 | 需要 | 不需要 |
| `PATCH` | `/api/v1/memos/{id}` | 修改或恢复待办 | 需要 | 必须 |
| `DELETE` | `/api/v1/memos/{id}` | 软删除或永久删除待办 | 需要 | 必须 |
| `GET` | `/api/v1/sync/snapshot` | 获取全量同步快照 | 需要 | 不需要 |
| `POST` | `/api/v1/attachments` | 上传一张图片 | 需要 | 必须 |
| `GET` | `/api/v1/attachments/{id}` | 下载图片 | 需要 | 不需要 |

## 接口说明

### 健康检查

```http
GET /healthz
```

无需 token，但会检查数据库连接。成功响应 `200`：

```json
{"status":"ok"}
```

### 获取数据集信息

```http
GET /api/v1/meta
```

成功响应示例：

```json
{
  "datasetId": "<UUID>",
  "schemaVersion": 1
}
```

### 创建待办

```http
POST /api/v1/memos
Content-Type: application/json
Authorization: Bearer <API_TOKEN>
Idempotency-Key: <新操作 UUID>
```

请求示例：

```json
{
  "id": "<可选待办 UUID>",
  "content": "准备联调 API",
  "type": "text",
  "priority": "unimportant",
  "status": "not_started",
  "tags": ["测试"],
  "attachmentIds": [],
  "deviceId": "desktop"
}
```

字段规则：

- `content` 与 `attachmentIds` 至少有一项非空。
- `type` 为 `text` 或 `image`；省略时根据附件是否存在推断。
- `priority` 为 `important` 或 `unimportant`；默认 `unimportant`。
- `status` 为 `not_started`、`in_progress` 或 `completed`；默认 `not_started`。
- `tags`、`attachmentIds` 可省略，默认为空数组。附件 ID 必须是 UUID，且附件已就绪。
- `id` 可省略，由服务端分配；`deviceId` 可省略，最多 128 个字符。
- `createdAt`、`updatedAt`、`completedAt` 可选，使用 RFC 3339 时间格式；提供 `completedAt` 时，`status` 必须为 `completed`。

成功返回 `201`，包含待办 ID、应用版本及时间等回执字段。

### 查询待办列表

```http
GET /api/v1/memos?status=in_progress&priority=important&limit=100&offset=0
```

可选查询参数：

- `status`：`not_started`、`in_progress`、`completed`。
- `priority`：`important`、`unimportant`。
- `tag`：按标签精确筛选。
- `q`：按待办正文包含关系搜索。
- `deleted`：`true` 查询已软删除项，`false` 查询未删除项；默认 `false`。
- `limit`：每页数量，默认 `100`，范围 `1`–`500`。
- `offset`：分页偏移，默认 `0`，范围 `0`–`1000000`。

成功响应：

```json
{"memos": []}
```

### 获取单条待办

```http
GET /api/v1/memos/{id}
```

`{id}` 为待办 UUID。待办响应包含 `id`、`content`、`type`、`priority`、`status`、`tags`、`attachmentIds`、时间字段、`deviceId`、`version`、`deleted` 和 `purged`。

### 修改或恢复待办

```http
PATCH /api/v1/memos/{id}
Content-Type: application/json
Authorization: Bearer <API_TOKEN>
Idempotency-Key: <新操作 UUID>
```

请求必须包含当前 `baseVersion`，并至少包含一个要修改的字段：

```json
{
  "baseVersion": "1",
  "content": "更新后的内容",
  "status": "in_progress"
}
```

可修改字段：`content`、`type`、`priority`、`status`、`tags`、`attachmentIds`。可使用 `"deleted": false` 恢复软删除待办。`baseVersion` 是字符串；版本过期会返回 `409 version_conflict`，客户端应重新读取最新待办后决定如何处理，不要直接覆盖。

### 删除待办

软删除：

```http
DELETE /api/v1/memos/{id}?baseVersion=1
Authorization: Bearer <API_TOKEN>
Idempotency-Key: <新操作 UUID>
```

永久删除：

```http
DELETE /api/v1/memos/{id}?baseVersion=2&permanent=true
Authorization: Bearer <API_TOKEN>
Idempotency-Key: <新操作 UUID>
```

两种操作都需要当前版本号。永久删除只能用于已经软删除的待办，且不可恢复。

### 获取同步快照

```http
GET /api/v1/sync/snapshot
```

成功响应包含 `datasetId`、`schemaVersion`、`complete`、`totalRows`、`memos` 和 `attachments`。快照在同一只读事务中读取；客户端应确认 `complete` 为 `true` 后再将快照视为完整数据集。

### 上传图片

```http
POST /api/v1/attachments
Authorization: Bearer <API_TOKEN>
Idempotency-Key: <新操作 UUID>
Content-Type: multipart/form-data
```

表单中只能有一个文件字段，字段名必须为 `file`。例如：

```bash
curl -X POST 'https://memo-api.cliproxy.com.cn/api/v1/attachments' \
  -H "Authorization: Bearer ${FOCUS_MEMO_TOKEN}" \
  -H 'Idempotency-Key: <新操作 UUID>' \
  -F 'file=@./photo.png'
```

上传限制为单张图片最大 20 MiB、12 MP。成功返回 `201` 和附件元数据，包括 `id`、`mimeType`、`size`、`sha256`、`createdAt`。将返回的附件 `id` 放入待办的 `attachmentIds`。

### 下载图片

```http
GET /api/v1/attachments/{id}
Authorization: Bearer <API_TOKEN>
```

成功时响应体为图片二进制内容，并返回对应的 `Content-Type` 和 SHA-256 `ETag`。

## 错误响应

JSON 错误统一采用以下结构：

```json
{
  "error": {
    "code": "version_conflict",
    "message": "Server version changed"
  }
}
```

常见 HTTP 状态：

| 状态码 | 含义 |
| --- | --- |
| `401` | 缺少或无效的 Bearer token |
| `404` | 待办或附件不存在 |
| `409` | 版本冲突、数据集变化、幂等键冲突或状态不允许 |
| `413` | 请求体、图片大小或像素超过限制 |
| `415` | Content-Type 或图片格式不支持 |
| `422` | JSON、字段、UUID、筛选参数或操作前置条件无效 |
| `503` | 服务、数据库或附件存储暂不可用；写入重试时复用原幂等键 |

## 当前使用注意事项

1. 当前服务连接的是独立测试库，不包含生产待办；不要把它当作正式数据的唯一存储。
2. 客户端需要配置 Base URL 和 token 才能调用受保护接口；token 不应硬编码、提交 Git 或通过公开渠道传递。
3. 使用真实数据前，先完成桌面端端到端联测、冲突与离线恢复测试，并完成尚未结束的独立代码复审。
4. 当前 API 已通过公网 HTTPS 健康、未授权拒绝及有效 token 调用检查；这不等同于桌面端全流程已验收。
