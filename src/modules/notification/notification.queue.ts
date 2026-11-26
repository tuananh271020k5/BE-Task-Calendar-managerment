import { Queue, Job } from "bullmq";
import { Types } from "mongoose";
import { getRedisConfig, supportsBullMQ } from "../../services/redis.service";
import { emailService } from "./email.service";
import { notificationRepository } from "./notification.repository";

export interface NotificationJobData {
  userId: string;
  type: string;
  title: string;
  content: string;
  data?: any;
  channels?: {
    inApp?: boolean;
    email?: boolean;
    push?: boolean;
  };
}

export interface EmailJobData {
  userId: string;
  email: string;
  subject: string;
  html: string;
  notificationId: string;
}

export interface InviteEmailJobData {
  to: string;
  subject: string;
  html: string;
  taskTitle: string;
  organizerEmail?: string;
}

type NotificationQueueType = Queue<
  NotificationJobData | EmailJobData | InviteEmailJobData
>;

let notificationQueueInstance: NotificationQueueType | null = null;
let warnedUnsupported = false;

const getNotificationQueue = async (): Promise<NotificationQueueType | null> => {
  if (notificationQueueInstance) {
    return notificationQueueInstance;
  }

  const { supported, version } = await supportsBullMQ();
  if (!supported) {
    if (!warnedUnsupported) {
      warnedUnsupported = true;
      console.warn(
        `[NotificationQueue] Redis ${version ?? "unknown"} < 5.0.0 — BullMQ disabled, using direct delivery fallback.`,
      );
    }
    return null;
  }

  const queue: NotificationQueueType = new Queue("notification", {
    connection: getRedisConfig(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  });

  queue.on("error", (err) => {
    console.error("[NotificationQueue] Queue error:", err.message);
  });

  notificationQueueInstance = queue;
  return queue;
};

export const notificationQueueService = {
  // Add notification job to queue
  add: async (
    data: NotificationJobData,
    options?: { delay?: number; priority?: number },
  ): Promise<Job | null> => {
    const queue = await getNotificationQueue();
    if (!queue) return null;

    return queue.add("send-notification", data, {
      ...options,
      jobId: `${data.userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    });
  },

  // Add email notification job
  addEmail: async (data: {
    userId: string;
    email: string;
    subject: string;
    html: string;
    notificationId: string;
  }): Promise<Job | null> => {
    const queue = await getNotificationQueue();
    if (!queue) {
      const result = await emailService.send({
        to: data.email,
        subject: data.subject,
        html: data.html,
      });
      if (
        result.success &&
        data.notificationId &&
        Types.ObjectId.isValid(data.notificationId)
      ) {
        await notificationRepository.markEmailSent(data.notificationId);
      }
      return null;
    }

    return queue.add("send-email", data, {
      priority: 2,
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
    });
  },

  // Add invite email job (no notificationId required)
  addInviteEmail: async (data: InviteEmailJobData): Promise<Job | null> => {
    const queue = await getNotificationQueue();
    if (!queue) {
      await emailService.send({
        to: data.to,
        subject: data.subject,
        html: data.html,
      });
      return null;
    }

    return queue.add("send-invite-email", data, {
      priority: 3,
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
    });
  },

  // Get queue status
  getStatus: async () => {
    const queue = await getNotificationQueue();
    if (!queue) {
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }

    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);

    return { waiting, active, completed, failed };
  },

  // Clean old jobs
  clean: async (gracePeriodMs: number = 24 * 60 * 60 * 1000) => {
    const queue = await getNotificationQueue();
    if (!queue) return;

    await queue.clean(gracePeriodMs, 100, "completed");
    await queue.clean(gracePeriodMs, 100, "failed");
  },

  // Get failed jobs for retry
  getFailedJobs: async (limit: number = 50) => {
    const queue = await getNotificationQueue();
    if (!queue) return [];

    return queue.getFailed(limit);
  },
};
