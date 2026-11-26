import { normalizeKbText } from "./kb-retriever.service";

export type BreakdownStep = {
  title: string;
  status: "todo";
  estimatedDuration: number;
  difficulty: "easy" | "medium" | "hard";
  description: string;
};

export type BreakdownTemplateMatch = {
  templateId: string;
  steps: BreakdownStep[];
  totalEstimatedDuration: number;
};

type TemplateDefinition = {
  id: string;
  pattern: RegExp;
  isCompatible?: (domainMode?: string) => boolean;
  steps: BreakdownStep[];
};

const HAS_ENDPOINT_RE = /\b(?:get|post|put|patch|delete)\s+\/[\w\/\-:{}]+/i;
const HAS_JSON_SHAPE_RE = /\{[^{}\n]{3,}\}/;
const HAS_SNAKE_CASE_RE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;

const TEMPLATES: TemplateDefinition[] = [
  {
    id: "frontend-page-ui",
    pattern:
      /\b(giao dien|man hinh|ui|ux|component|form|layout|responsive|frontend|react|vue|tailwind|css)\b/,
    isCompatible: (domainMode) =>
      !domainMode || !domainMode.startsWith("backend"),
    steps: [
      {
        title: "Chốt cấu trúc layout và các trạng thái giao diện",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Xác định wireframe, luồng tương tác chính và các state: loading, empty, error, success.",
      },
      {
        title: "Xây dựng component và bố cục responsive",
        status: "todo",
        estimatedDuration: 45,
        difficulty: "medium",
        description:
          "Cài đặt cấu trúc JSX/HTML, styling và đảm bảo hiển thị ổn định trên desktop và mobile.",
      },
      {
        title: "Quản lý state và validation dữ liệu đầu vào",
        status: "todo",
        estimatedDuration: 30,
        difficulty: "medium",
        description:
          "Kết nối state, kiểm tra dữ liệu hợp lệ và hiển thị thông báo lỗi rõ ràng cho người dùng.",
      },
      {
        title: "Tích hợp API và xử lý phản hồi bất đồng bộ",
        status: "todo",
        estimatedDuration: 30,
        difficulty: "medium",
        description:
          "Gọi service lấy/gửi dữ liệu, xử lý loading spinner, toast thông báo và fallback khi lỗi.",
      },
      {
        title: "Kiểm thử UI trên các kích thước màn hình và hoàn thiện",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Kiểm tra keyboard navigation, độ tương phản và dọn dẹp code trước khi commit.",
      },
    ],
  },
  {
    id: "auth-login-register",
    pattern:
      /\b(dang nhap|dang ky|login|register|auth|authentication|jwt|phan quyen|rbac)\b/,
    isCompatible: (domainMode) => domainMode !== "frontend_strict",
    steps: [
      {
        title: "Thiết kế luồng xác thực và cấu trúc payload/token",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Chốt schema User, định dạng dữ liệu đầu vào và cơ chế cấp phát/thu hồi token.",
      },
      {
        title: "Cài đặt đăng ký và mã hóa mật khẩu an toàn",
        status: "todo",
        estimatedDuration: 30,
        difficulty: "medium",
        description:
          "Validate email/mật khẩu, kiểm tra trùng tài khoản và hash password trước khi lưu DB.",
      },
      {
        title: "Cài đặt đăng nhập và phát hành access/refresh token",
        status: "todo",
        estimatedDuration: 35,
        difficulty: "medium",
        description:
          "Xác thực thông tin đăng nhập, sinh token có thời hạn rõ ràng và trả về user profile an toàn.",
      },
      {
        title: "Xây dựng middleware xác thực và phân quyền route",
        status: "todo",
        estimatedDuration: 25,
        difficulty: "medium",
        description:
          "Verify token trên các route bảo vệ, gắn thông tin user vào request và trả 401/403 đúng chuẩn.",
      },
      {
        title: "Viết test các kịch bản thành công và lỗi xác thực",
        status: "todo",
        estimatedDuration: 25,
        difficulty: "easy",
        description:
          "Kiểm tra sai mật khẩu, thiếu token, token hết hạn và xác nhận response trả về ổn định.",
      },
    ],
  },
  {
    id: "crud-api-backend",
    pattern: /\b(crud|rest api|restful|api|endpoint|backend|controller|service)\b/,
    isCompatible: (domainMode) =>
      !domainMode || !domainMode.startsWith("frontend"),
    steps: [
      {
        title: "Định nghĩa Schema/Model và ràng buộc dữ liệu",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Tạo model với kiểu dữ liệu, required fields và index cần thiết cho truy vấn.",
      },
      {
        title: "Viết lớp Repository/Service xử lý nghiệp vụ CRUD",
        status: "todo",
        estimatedDuration: 40,
        difficulty: "medium",
        description:
          "Cài đặt create, list (có phân trang/lọc), getById, update và delete theo đúng quyền user.",
      },
      {
        title: "Xây dựng Controller và validate request đầu vào",
        status: "todo",
        estimatedDuration: 30,
        difficulty: "medium",
        description:
          "Kiểm tra params/body hợp lệ, chuẩn hóa HTTP status code (200/201/400/404) và error handling.",
      },
      {
        title: "Đăng ký Router và gắn middleware xác thực",
        status: "todo",
        estimatedDuration: 15,
        difficulty: "easy",
        description:
          "Khai báo các endpoint vào router và bảo vệ bằng authMiddleware/rate-limit nếu cần.",
      },
      {
        title: "Kiểm thử toàn bộ endpoint và xử lý edge-case",
        status: "todo",
        estimatedDuration: 25,
        difficulty: "easy",
        description:
          "Test từng route với dữ liệu hợp lệ, dữ liệu thiếu, ID sai định dạng và lỗi quyền truy cập.",
      },
    ],
  },
  {
    id: "bug-fix-debug",
    pattern: /\b(fix bug|sua loi|debug|khac phuc loi|troubleshoot|bug)\b/,
    steps: [
      {
        title: "Tái hiện lỗi ổn định và thu thập log/stack trace",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Xác định chính xác bước tái hiện, dữ liệu đầu vào gây lỗi và thông báo lỗi trên console/network.",
      },
      {
        title: "Khoanh vùng nguyên nhân gốc (root cause)",
        status: "todo",
        estimatedDuration: 30,
        difficulty: "medium",
        description:
          "Đọc luồng xử lý liên quan, đặt log/breakpoint để tìm đúng dòng code hoặc điều kiện gây sai.",
      },
      {
        title: "Sửa lỗi và xử lý các trường hợp biên",
        status: "todo",
        estimatedDuration: 30,
        difficulty: "medium",
        description:
          "Áp dụng bản vá gọn nhẹ, không làm ảnh hưởng các luồng lân cận và kiểm tra null/undefined.",
      },
      {
        title: "Kiểm thử hồi quy và xác nhận lỗi đã dứt điểm",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Chạy lại kịch bản gây lỗi ban đầu và bộ test/type-check liên quan để đảm bảo không phát sinh lỗi mới.",
      },
    ],
  },
  {
    id: "presentation-slides",
    pattern: /\b(lam slide|thuyet trinh|powerpoint|pptx|canva|slide|deck)\b/,
    steps: [
      {
        title: "Xác định mục tiêu, đối tượng nghe và dàn ý chính",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Liệt kê 5-8 ý cốt lõi theo mạch: Vấn đề → Giải pháp → Chi tiết/Demo → Kết luận.",
      },
      {
        title: "Soạn nội dung ngắn gọn cho từng slide",
        status: "todo",
        estimatedDuration: 40,
        difficulty: "medium",
        description:
          "Viết gạch đầu dòng súc tích (mỗi slide 1 thông điệp), chuẩn bị số liệu và ví dụ minh họa.",
      },
      {
        title: "Thiết kế bố cục và chèn sơ đồ/hình ảnh trực quan",
        status: "todo",
        estimatedDuration: 35,
        difficulty: "medium",
        description:
          "Chọn template đồng bộ màu chữ/font, thay chữ dài bằng biểu đồ, bảng so sánh hoặc ảnh chụp màn hình.",
      },
      {
        title: "Rà soát chính tả và tập dượt trình bày theo thời gian",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Đọc thử toàn bộ slide để canh đúng thời lượng và chuẩn bị câu trả lời cho các câu hỏi phản biện.",
      },
    ],
  },
  {
    id: "report-essay",
    pattern:
      /\b(viet bao cao|bao cao|tieu luan|do an|luan van|tai lieu tong hop|report)\b/,
    steps: [
      {
        title: "Lập đề cương chi tiết và thu thập số liệu/tài liệu",
        status: "todo",
        estimatedDuration: 25,
        difficulty: "easy",
        description:
          "Chốt cấu trúc các chương/mục và gom đủ nguồn dẫn, số liệu hoặc kết quả thực nghiệm.",
      },
      {
        title: "Viết bản nháp các phần nội dung trọng tâm",
        status: "todo",
        estimatedDuration: 55,
        difficulty: "medium",
        description:
          "Triển khai từng mục bám sát đề cương, chèn bảng biểu/hình minh họa để làm rõ lập luận.",
      },
      {
        title: "Viết phần mở đầu, kết luận và tóm tắt",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Tổng hợp các phát hiện chính, đóng góp và đề xuất hướng phát triển/giải pháp tiếp theo.",
      },
      {
        title: "Chuẩn hóa định dạng, trích dẫn và rà lỗi chính tả",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Kiểm tra mục lục, đánh số hình/bảng, tài liệu tham khảo và xuất file hoàn chỉnh.",
      },
    ],
  },
  {
    id: "exam-study",
    pattern: /\b(on thi|on tap|kiem tra|luyen de|giai de|exam)\b/,
    steps: [
      {
        title: "Hệ thống hóa đề cương và phân loại chủ đề trọng tâm",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Liệt kê toàn bộ chương cần thi và đánh dấu phần kiến thức hay ra đề hoặc còn yếu.",
      },
      {
        title: "Ôn lý thuyết cốt lõi và công thức/mẫu câu quan trọng",
        status: "todo",
        estimatedDuration: 40,
        difficulty: "medium",
        description:
          "Ghi chú nhanh (cheat sheet) các khái niệm, công thức và lỗi sai thường gặp.",
      },
      {
        title: "Làm đề thi thử bấm giờ như thi thật",
        status: "todo",
        estimatedDuration: 45,
        difficulty: "hard",
        description:
          "Giải trọn vẹn 1 đề không mở tài liệu để luyện tốc độ phân bổ thời gian.",
      },
      {
        title: "Chấm chữa chi tiết các câu sai và ôn lại phần hổng",
        status: "todo",
        estimatedDuration: 25,
        difficulty: "medium",
        description:
          "Ghi lại lý do làm sai từng câu và giải lại các dạng bài tương tự để nhớ chắc.",
      },
    ],
  },
  {
    id: "ielts-english",
    pattern: /\b(tieng anh|ielts|toeic|tu vung|nghe noi|english|speaking|writing|listening|reading)\b/,
    steps: [
      {
        title: "Ôn và ghi chú cụm từ vựng/collocation theo chủ đề",
        status: "todo",
        estimatedDuration: 20,
        difficulty: "easy",
        description:
          "Chọn 12-15 từ/cụm từ thiết thực kèm ví dụ ngữ cảnh và luyện phát âm chuẩn.",
      },
      {
        title: "Luyện kỹ năng đầu vào (Listening/Reading) có kiểm tra đáp án",
        status: "todo",
        estimatedDuration: 35,
        difficulty: "medium",
        description:
          "Làm 1 bài nghe hoặc đọc hiểu ngắn, đối chiếu transcript để rút ra từ khóa bẫy.",
      },
      {
        title: "Thực hành đầu ra (Speaking/Writing) áp dụng từ mới",
        status: "todo",
        estimatedDuration: 35,
        difficulty: "hard",
        description:
          "Viết đoạn ngắn hoặc ghi âm trả lời câu hỏi theo chủ đề, dùng ít nhất 5 từ vừa học.",
      },
      {
        title: "Tự sửa lỗi ngữ pháp và tổng kết điểm cần cải thiện",
        status: "todo",
        estimatedDuration: 15,
        difficulty: "easy",
        description:
          "Rà lỗi chia thì, mạo từ, phát âm và lưu vào danh sách ôn tập cho buổi sau.",
      },
    ],
  },
];

export const scaleBreakdownSteps = <
  T extends { estimatedDuration?: number },
>(
  steps: T[],
  totalMinutes?: number,
): T[] => {
  if (!totalMinutes || totalMinutes <= 0 || steps.length === 0) {
    return steps;
  }

  const currentTotal = steps.reduce(
    (sum, s) => sum + (s.estimatedDuration ?? 60),
    0,
  );
  if (currentTotal <= 0) return steps;

  const scale = totalMinutes / currentTotal;
  const scaledDurations = steps.map((s) =>
    Math.max(5, (s.estimatedDuration ?? 60) * scale),
  );
  const roundedDurations = scaledDurations.map((d) => Math.floor(d / 5) * 5);

  const roundedTotal = roundedDurations.reduce((sum, d) => sum + d, 0);
  let remainder = totalMinutes - roundedTotal;

  const fractionalParts = scaledDurations.map((d, i) => ({
    index: i,
    fraction: d - roundedDurations[i],
  }));
  fractionalParts.sort((a, b) => b.fraction - a.fraction);

  for (let i = 0; i < fractionalParts.length && remainder >= 5; i++) {
    roundedDurations[fractionalParts[i].index] += 5;
    remainder -= 5;
  }

  if (remainder > 0) {
    roundedDurations[roundedDurations.length - 1] += remainder;
  }

  return steps.map((s, i) => ({
    ...s,
    estimatedDuration: Math.max(5, roundedDurations[i]),
  }));
};

export const matchBreakdownTemplate = (params: {
  title: string;
  description?: string;
  totalMinutes?: number;
  levelCode?: string;
  domainMode?: string;
}): BreakdownTemplateMatch | null => {
  const title = String(params.title ?? "").trim();
  const description = String(params.description ?? "").trim();
  if (!title) return null;

  // Never bypass LLM when description carries detailed custom specifications
  if (description.length >= 40) {
    return null;
  }

  const combinedRaw = `${title}\n${description}`;
  if (
    HAS_ENDPOINT_RE.test(combinedRaw) ||
    HAS_JSON_SHAPE_RE.test(combinedRaw) ||
    HAS_SNAKE_CASE_RE.test(combinedRaw.toLowerCase())
  ) {
    return null;
  }

  const normalizedTitle = normalizeKbText(title);
  const matched = TEMPLATES.find(
    (tpl) =>
      tpl.pattern.test(normalizedTitle) &&
      (!tpl.isCompatible || tpl.isCompatible(params.domainMode)),
  );

  if (!matched) return null;

  const isBeginner =
    params.levelCode === "intern" ||
    params.levelCode === "fresher" ||
    params.levelCode === "student";

  let steps: BreakdownStep[] = matched.steps.map((step) => ({
    ...step,
    estimatedDuration: isBeginner
      ? Math.max(5, Math.round((step.estimatedDuration * 1.15) / 5) * 5)
      : step.estimatedDuration,
  }));

  if (params.totalMinutes && params.totalMinutes > 0) {
    steps = scaleBreakdownSteps(steps, params.totalMinutes);
  }

  const totalEstimatedDuration =
    params.totalMinutes && params.totalMinutes > 0
      ? params.totalMinutes
      : steps.reduce((sum, s) => sum + s.estimatedDuration, 0);

  return {
    templateId: matched.id,
    steps,
    totalEstimatedDuration,
  };
};
