# Quản lý Công việc (/tasks)

Route: `/tasks`

## Tạo công việc mới và ước lượng thời gian
- Vào trang [Công việc](/tasks) và nhấn nút **+ Thêm công việc**.
- Điền các thông tin: **Tiêu đề**, **Mô tả**, **Mức ưu tiên** (Thấp / Trung bình / Cao / Khẩn cấp), **Ngày bắt đầu** và **Hạn chót (Deadline)**.
- Nhập **Thời gian dự kiến** (ví dụ: `90m`, `2h`) và **Mục tiêu mỗi ngày** (ví dụ: `30-60 phút`) để thuật toán AI chia buổi và lên lịch chính xác hơn.
- Có thể gắn **Thẻ (Tags)** để phân loại công việc theo môn học hoặc dự án.

## Xem theo Danh sách và Bảng Kanban
- Trang [Công việc](/tasks) hỗ trợ chuyển đổi giữa chế độ **Dạng danh sách** (bảng chi tiết) và **Bảng Kanban**.
- Ở chế độ Kanban, bạn có thể kéo thả thẻ công việc giữa các cột trạng thái (Chưa xử lý / Đã lên lịch / Đang làm / Hoàn thành) để cập nhật tiến độ nhanh chóng.
- Để chỉnh sửa hoặc xóa một công việc, nhấn biểu tượng **...** ở cuối dòng hoặc thẻ công việc.

## Công việc quá hạn và Gia hạn hạn chót
- Khi công việc vượt quá thời gian Deadline mà chưa hoàn thành, hệ thống tự động hiển thị nhãn đỏ **Quá hạn**.
- Với **công việc cá nhân**, bạn có thể bấm trực tiếp vào nhãn **Quá hạn** hoặc mở menu **...** → chọn **Gia hạn hạn chót** để chọn deadline mới.
- Với **công việc nhóm**, Thành viên cần bấm **Yêu cầu gia hạn** và nhập lý do để Trưởng nhóm/Chủ dự án phê duyệt.

## Chia nhỏ công việc với AI Breakdown
- Tại công việc muốn chia nhỏ, nhấn biểu tượng hoặc menu **...** → chọn **AI Breakdown**.
- AI sẽ phân tích tiêu đề, mô tả và thời lượng để tách thành danh sách các bước thực hiện (**subtask**) kèm độ khó (Dễ / Trung bình / Khó) và thời gian ước tính.
- Nhấp vào tên bất kỳ bước nào để mở [Chat AI](/chat) hoặc widget Chatbot kèm sẵn ngữ cảnh của bước đó.

## Trợ lý AI Copilot trong chi tiết công việc
- Click vào một dòng công việc để mở modal chi tiết, sau đó chuyển sang tab **Trợ lý AI Copilot**.
- Tại đây bạn có thể hỏi đáp riêng cho công việc đó, nhờ AI gợi ý lộ trình, tài liệu hoặc giải đáp vướng mắc mà không lẫn sang việc khác.
