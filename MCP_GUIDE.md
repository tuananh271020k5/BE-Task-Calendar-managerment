# Hướng dẫn sử dụng MCP trong TaskMind AI

TaskMind AI hỗ trợ giao thức **Model Context Protocol (MCP)** giúp bạn kết nối trực tiếp hệ thống công việc/lịch trình vào các IDE và AI client như **Cursor, Claude Desktop, VS Code, Antigravity**.

---

## 1. TaskMind MCP Server (Chiều VÀO — dành cho người dùng / IDE)

File triển khai chính:
- Server & Tools: `src/modules/ai/mcp/taskmind-mcp.server.ts`
- Streamable HTTP Endpoint (`/mcp`): `src/modules/ai/mcp/mcp.routes.ts`
- Local Stdio Entrypoint: `src/modules/ai/mcp/stdio.ts`

### 6 Tools được cung cấp
1. `list_tasks` — Liệt kê công việc của user hiện tại (hỗ trợ lọc `status`, `priority`, `keyword`, `limit`).
2. `create_task` — Tạo mới task/sự kiện vào lịch trình (ngày `YYYY-MM-DD`, giờ `HH:mm`, độ ưu tiên).
3. `breakdown_task` — Chia nhỏ công việc bằng `aiBreakdownService` (tự động dùng Shared Redis Cache, Template KB 0-token và Daily Quota Guardrail).
4. `get_free_busy` — Xem khung giờ bận/rảnh trong khoảng `[from, to]`.
5. `propose_schedule` — Đề xuất slot xếp lịch hợp lý (chỉ đề xuất, không tự ghi DB).
6. `search_kb` — Tra cứu tài liệu hướng dẫn sử dụng TaskMind AI qua Hybrid Search (`BM25 + Vector RRF`).

### 1 Resource được cung cấp
- `taskmind://kb/overview` — Tóm tắt các module, route giao diện và danh sách MCP tools.

---

## 2. Cách kết nối vào IDE / AI Client

File mẫu đặt tại `.mcp.example.json`. Copy nội dung cần dùng vào file cấu hình MCP của IDE (ví dụ `.mcp.json` hoặc cấu hình MCP của Cursor / Claude Desktop).

### Cách A: Kết nối qua Streamable HTTP (`taskmind-http`)
1. Khởi động Backend (`npm run dev`, mặc định cổng `3002`).
2. Đăng nhập ứng dụng trên trình duyệt hoặc qua `POST /auth/login` để lấy JWT Access Token.
3. Dán token vào header:
   ```json
   "Authorization": "Bearer <YOUR_TASKMIND_JWT>"
   ```
4. Lưu ý kỹ thuật: Client HTTP MCP chuẩn phải gửi header `Accept: application/json, text/event-stream` khi gọi `POST http://localhost:3002/mcp`.

### Cách B: Kết nối cục bộ qua Stdio (`taskmind-stdio`)
1. Lấy `_id` người dùng của bạn trong collection `users` trên MongoDB (chuỗi ObjectId 24 ký tự).
2. Điền vào biến môi trường `TASKMIND_MCP_USER_ID` trong cấu hình `taskmind-stdio` hoặc chạy test nhanh:
   ```bash
   TASKMIND_MCP_USER_ID="<YOUR_MONGO_USER_OBJECT_ID>" npm run mcp:stdio
   ```
3. Toàn bộ log trong chế độ `stdio` đã được chuyển hướng sang `stderr` để không làm nhiễu khung JSON-RPC trên `stdout`.

---

## 3. Outbound MCP Client Hub (Chiều RA — `/mcp/connectors`)

Ngoài việc làm MCP Server, TaskMind AI có **MCP Client Hub** cho phép backend kết nối tới các MCP server bên ngoài để lấy dữ liệu cho user:

- **`github`**: Đọc GitHub Issues / PR (`MCP_GITHUB_URL`, mặc định `https://api.githubcopilot.com/mcp/`).
- **`notion`**: Đọc trang spec / ghi chú Notion (`MCP_NOTION_URL`, mặc định `https://mcp.notion.com/mcp`).
- **`google_calendar`**: Đồng bộ lịch với Google Calendar (dùng Google OAuth token khi user đăng nhập Google hoặc cấu hình `MCP_GCAL_URL`).

File triển khai:
- Registry connector (whitelist phía server, chống SSRF): `src/modules/ai/mcp/mcp-connectors.config.ts`
- Client Manager (timeout 15s, output guardrail, ghi `ai_usage_logs`): `src/modules/ai/mcp/mcp-client.manager.ts`

### Endpoints REST (yêu cầu đăng nhập JWT)
- `GET /mcp/connectors`: Xem danh sách 3 connector và trạng thái sẵn sàng của user hiện tại.
- `POST /mcp/connectors/:connectorId/tools`: Liệt kê danh sách tools từ connector đó.
- `POST /mcp/connectors/:connectorId/call`: Gọi 1 tool cụ thể từ connector.

Ví dụ test nhanh với GitHub PAT qua header `x-mcp-token`:
```bash
curl -X POST http://localhost:3002/mcp/connectors/github/tools \
  -H "Authorization: Bearer <YOUR_TASKMIND_JWT>" \
  -H "x-mcp-token: <YOUR_GITHUB_PAT>"

curl -X POST http://localhost:3002/mcp/connectors/github/call \
  -H "Authorization: Bearer <YOUR_TASKMIND_JWT>" \
  -H "x-mcp-token: <YOUR_GITHUB_PAT>" \
  -H "Content-Type: application/json" \
  -d '{"toolName":"list_issues","arguments":{"owner":"<org>","repo":"<repo>"}}'
```

---

## 4. Bộ Dev MCP dành riêng cho lập trình viên (Hướng B2)

Trong `.mcp.example.json` có sẵn 2 MCP server public phục vụ lúc phát triển & kiểm thử:
- **`mongodb-dev`** (`mongodb-mcp-server`): Soi schema collection, kiểm tra index, dọn collection thừa (`free_times` vs `freetimes`) và xem nhanh log trong `ai_usage_logs`.
- **`playwright-dev`** (`@playwright/mcp`): Tự động mở trình duyệt kiểm thử giao diện Calendar, Kanban, Notifications và Chatbot.

---

## 5. Lưu ý bảo mật (BẮT BUỘC)
- **Không commit secret thật:** Không bao giờ đưa JWT, MongoDB URI thật hoặc API Key vào `.mcp.example.json` hay git. Nếu tạo file `.mcp.json` cá nhân để dùng local, hãy đảm bảo `.mcp.json` nằm trong `.gitignore`.
- **Không mở Dev MCP cho user cuối:** `mongodb-dev` và `playwright-dev` chỉ chạy trên máy lập trình viên trong IDE, **tuyệt đối không** gắn vào chatbot web của người dùng.
- **Cách ly theo `userId` & Chống SSRF:**
  - Tất cả tool của `taskmind-mcp-server` luôn lấy `userId` từ JWT/env, không nhận từ tham số LLM.
  - Danh sách URL/command của connector ngoài bị khoá cứng trong whitelist phía server (`mcp-connectors.config.ts`); mọi token của user truyền qua `x-mcp-token` không bao giờ bị ghi vào `ai_usage_logs` hay log console, và toàn bộ text trả về đều đi qua output guardrail để che key nếu lỡ rò rỉ.
