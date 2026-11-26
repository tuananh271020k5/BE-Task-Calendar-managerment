import { Types } from "mongoose";
import { DailyRoutine } from "../routine/routine.model";
import { Task } from "../task/task.model";

export type ApplyCalendarActionResult = {
  success: true;
  appliedCount: number;
  message: string;
  details: string[];
};

const escapeRegex = (raw: string): string =>
  raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const aiCalendarActionService = {
  applyActions: async (
    userId: string,
    params: { targetDate: string; actions: any[] },
  ): Promise<ApplyCalendarActionResult> => {
    const { targetDate, actions } = params;
    const userObjectId = new Types.ObjectId(userId);
    let appliedCount = 0;
    const details: string[] = [];

    for (const item of actions) {
      if (item?.checked === false) continue;

      if (item.action === "cancel_routine") {
        let routineMatch = null;
        if (item.routineId && Types.ObjectId.isValid(item.routineId)) {
          routineMatch = await DailyRoutine.findOne({
            _id: new Types.ObjectId(item.routineId),
            userId: userObjectId,
          });
        }
        if (!routineMatch && item.title) {
          routineMatch = await DailyRoutine.findOne({
            userId: userObjectId,
            title: { $regex: new RegExp(escapeRegex(String(item.title)), "i") },
          });
        }

        if (routineMatch) {
          const dateToExclude = targetDate || item.date;
          if (dateToExclude) {
            await DailyRoutine.updateOne(
              { _id: routineMatch._id },
              { $addToSet: { excludedDates: dateToExclude } },
            );
            appliedCount++;
            details.push(
              `Đã bỏ thói quen "${routineMatch.title}" ngày ${dateToExclude}`,
            );
          }
        }
      } else if (item.action === "replace") {
        if (item.oldTitle) {
          const oldRoutine = await DailyRoutine.findOne({
            userId: userObjectId,
            title: {
              $regex: new RegExp(escapeRegex(String(item.oldTitle)), "i"),
            },
          });
          const dateToExclude =
            targetDate || (item.start ? String(item.start).slice(0, 10) : "");
          if (oldRoutine && dateToExclude) {
            await DailyRoutine.updateOne(
              { _id: oldRoutine._id },
              { $addToSet: { excludedDates: dateToExclude } },
            );
          }
        }

        const title = item.newTitle || item.title;
        if (title && item.start && item.end) {
          await Task.create({
            userId: userObjectId,
            title,
            type: "event",
            priority: "medium",
            status: "scheduled",
            scheduledTime: {
              start: new Date(item.start),
              end: new Date(item.end),
              aiPlanned: true,
              reason:
                item.reason ||
                (item.oldTitle ? `Thay thế ${item.oldTitle}` : "AI điều phối"),
            },
          });
          appliedCount++;
          details.push(`Đã đổi thành "${title}" (${item.time || ""})`);
        }
      } else if (item.action === "create_event" || item.action === "create") {
        const title = item.title;
        if (title && item.start && item.end) {
          if (item.taskId && Types.ObjectId.isValid(item.taskId)) {
            await Task.updateOne(
              { _id: new Types.ObjectId(item.taskId), userId: userObjectId },
              {
                $set: {
                  status: "scheduled",
                  scheduledTime: {
                    start: new Date(item.start),
                    end: new Date(item.end),
                    aiPlanned: true,
                    reason: item.reason || "Lên lịch theo đề xuất AI",
                  },
                },
              },
            );
            appliedCount++;
            details.push(`Đã lên lịch cho task "${title}"`);
          } else {
            await Task.create({
              userId: userObjectId,
              title,
              type: "event",
              priority: item.category === "work" ? "high" : "medium",
              status: "scheduled",
              scheduledTime: {
                start: new Date(item.start),
                end: new Date(item.end),
                aiPlanned: true,
                reason: item.reason || "Lên lịch theo đề xuất AI",
              },
            });
            appliedCount++;
            details.push(`Đã thêm lịch "${title}" (${item.time || ""})`);
          }
        }
      }
    }

    return {
      success: true,
      appliedCount,
      message: `Đã áp dụng thành công ${appliedCount} thay đổi lên lịch trình!`,
      details,
    };
  },
};
