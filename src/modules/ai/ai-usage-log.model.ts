import mongoose, { Schema, Types } from "mongoose";

export type AiUsageFeature =
  | "chat"
  | "chat_stream"
  | "task_breakdown"
  | "priority_suggest"
  | "schedule_plan"
  | "smart_reschedule"
  | "mcp_client";

export type AiUsageStatus = "ok" | "error" | "blocked";

export type AiUsageLogAttrs = {
  userId: Types.ObjectId;
  conversationId?: Types.ObjectId;
  feature: AiUsageFeature;
  route?: string;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
  cacheHit?: boolean;
  guardrailTriggered?: string;
  status?: AiUsageStatus;
  errorCode?: string;
  meta?: Record<string, unknown>;
};

export type AiUsageLogDoc = AiUsageLogAttrs & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

type AiUsageLogModel = mongoose.Model<AiUsageLogDoc>;

const aiUsageLogSchema = new Schema<AiUsageLogDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    conversationId: { type: Schema.Types.ObjectId },
    feature: {
      type: String,
      required: true,
      enum: [
        "chat",
        "chat_stream",
        "task_breakdown",
        "priority_suggest",
        "schedule_plan",
        "smart_reschedule",
        "mcp_client",
      ],
      index: true,
    },
    route: { type: String },
    model: { type: String },
    provider: { type: String },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    estimatedCostUsd: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    cacheHit: { type: Boolean, default: false },
    guardrailTriggered: { type: String },
    status: {
      type: String,
      enum: ["ok", "error", "blocked"],
      default: "ok",
      index: true,
    },
    errorCode: { type: String },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

aiUsageLogSchema.index({ userId: 1, createdAt: -1 });
aiUsageLogSchema.index({ feature: 1, createdAt: -1 });

export const AiUsageLog =
  (mongoose.models.AiUsageLog as AiUsageLogModel) ||
  mongoose.model<AiUsageLogDoc>("AiUsageLog", aiUsageLogSchema, "ai_usage_logs");
