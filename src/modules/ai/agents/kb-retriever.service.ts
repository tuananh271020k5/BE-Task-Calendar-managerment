import crypto from "crypto";
import fs from "fs";
import path from "path";
import { cosineSimilarity, embeddingService } from "./embedding.service";

export type KbModule =
  | "tasks"
  | "calendar"
  | "teams"
  | "notifications"
  | "chat-and-profile";

export interface KbChunk {
  id: string;
  module: KbModule;
  file: string;
  route: string;
  title: string;
  content: string;
  normalizedTitle: string;
  titleTokens: string[];
  contentTokens: string[];
}

export interface KbSearchResult {
  chunk: KbChunk;
  score: number;
}

const VALID_MODULES: Record<string, KbModule> = {
  tasks: "tasks",
  calendar: "calendar",
  teams: "teams",
  notifications: "notifications",
  "chat-and-profile": "chat-and-profile",
};

const SYNONYM_EXPANSIONS: Array<{ pattern: RegExp; extra: string }> = [
  { pattern: /\bcv\b/g, extra: "cong viec task" },
  { pattern: /\bdl\b/g, extra: "deadline han chot" },
  { pattern: /\btb\b/g, extra: "thong bao notification" },
  {
    pattern: /\b(thoi quen|lich lap|routine|routines)\b/g,
    extra: "lich hang ngay daily routines",
  },
  {
    pattern: /\b(chia nho|tach nho|breakdown)\b/g,
    extra: "ai breakdown subtask",
  },
  { pattern: /\b(nhom|team)\b/g, extra: "team nhom" },
  { pattern: /\b(tam an|hoan|snooze)\b/g, extra: "snooze tam an" },
  {
    pattern: /\b(ho so|profile|habits)\b/g,
    extra: "profile user habits ho so ca nhan thoi quen lam viec",
  },
  {
    pattern: /\b(toi uu lich|xep lich)\b/g,
    extra: "ai toi uu lich calendar",
  },
  {
    pattern: /\b(khong lam phien|quiet)\b/g,
    extra: "quiet hours khong lam phien",
  },
  { pattern: /\b(gia han)\b/g, extra: "gia han han chot deadline" },
  { pattern: /\bmk\b/g, extra: "mat khau password" },
  { pattern: /\btk\b/g, extra: "tai khoan profile" },
  { pattern: /\btv\b/g, extra: "thanh vien member" },
  { pattern: /\bls\b/g, extra: "lich su" },
  { pattern: /\b(nhac|bao thuc)\b/g, extra: "thong bao nhac nho notification" },
  { pattern: /\b(ko|kh)\b/g, extra: "khong" },
  { pattern: /\bdc\b/g, extra: "duoc" },
  { pattern: /\b(loi|bug|lag)\b/g, extra: "bao loi su co ho tro" },
  {
    pattern: /\b(quyen|role|admin)\b/g,
    extra: "truong nhom phan quyen thanh vien",
  },
  { pattern: /\b(de xuat|goi y)\b/g, extra: "ai toi uu lich goi y" },
];

export const normalizeKbText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9/\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (normalizedText: string): string[] =>
  normalizedText
    .split(/[\s/_-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

const expandQueryTokens = (query: string): { normalized: string; tokens: string[] } => {
  let normalized = normalizeKbText(query);
  const extras: string[] = [];
  for (const rule of SYNONYM_EXPANSIONS) {
    if (rule.pattern.test(normalized)) {
      extras.push(rule.extra);
    }
    rule.pattern.lastIndex = 0;
  }
  const expanded = extras.length ? `${normalized} ${extras.join(" ")}` : normalized;
  return {
    normalized,
    tokens: Array.from(new Set(tokenize(expanded))),
  };
};

const resolveKbDir = (): string | null => {
  const candidates = [
    path.resolve(__dirname, "../kb"),
    path.resolve(process.cwd(), "src/modules/ai/kb"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
};

let cachedChunks: KbChunk[] | null = null;
let cachedDocFreq: Map<string, number> = new Map();
let cachedAvgContentLen = 1;

const loadKbIndex = (): KbChunk[] => {
  if (cachedChunks) return cachedChunks;

  const kbDir = resolveKbDir();
  if (!kbDir) {
    cachedChunks = [];
    return cachedChunks;
  }

  const files = fs
    .readdirSync(kbDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const chunks: KbChunk[] = [];
  for (const file of files) {
    const baseName = file.replace(/\.md$/i, "");
    const kbModule: KbModule = VALID_MODULES[baseName] ?? "chat-and-profile";
    const raw = fs.readFileSync(path.join(kbDir, file), "utf8");

    const routeMatch = raw.match(/^Route:\s*(.+)$/m);
    const route = routeMatch ? routeMatch[1].trim() : `/${kbModule}`;

    const sections = raw.split(/\n##\s+/);
    // Skip preamble before the first ## section
    for (let i = 1; i < sections.length; i++) {
      const sec = sections[i];
      const nlIdx = sec.indexOf("\n");
      const title = (nlIdx === -1 ? sec : sec.slice(0, nlIdx)).trim();
      const body = (nlIdx === -1 ? "" : sec.slice(nlIdx + 1)).trim();
      if (!title || !body) continue;

      const normalizedTitle = normalizeKbText(title);
      const titleTokens = tokenize(normalizedTitle);
      const contentTokens = tokenize(normalizeKbText(`${kbModule} ${title} ${body}`));

      chunks.push({
        id: `${kbModule}#${i}`,
        module: kbModule,
        file,
        route,
        title,
        content: body,
        normalizedTitle,
        titleTokens,
        contentTokens,
      });
    }
  }

  const df = new Map<string, number>();
  let totalLen = 0;
  for (const chunk of chunks) {
    totalLen += chunk.contentTokens.length;
    const unique = new Set([...chunk.titleTokens, ...chunk.contentTokens]);
    for (const tok of unique) {
      df.set(tok, (df.get(tok) || 0) + 1);
    }
  }

  cachedChunks = chunks;
  cachedDocFreq = df;
  cachedAvgContentLen = chunks.length > 0 ? totalLen / chunks.length : 1;
  return cachedChunks;
};

const scoreBm25 = (
  chunk: KbChunk,
  queryNormalized: string,
  queryTokens: string[],
  preferredModule: KbModule | undefined,
  totalDocs: number,
): number => {
  if (queryTokens.length === 0 || totalDocs === 0) return 0;

  const k1 = 1.5;
  const b = 0.75;
  const docLen = Math.max(1, chunk.contentTokens.length);

  const contentTf = new Map<string, number>();
  for (const tok of chunk.contentTokens) {
    contentTf.set(tok, (contentTf.get(tok) || 0) + 1);
  }
  const titleSet = new Set(chunk.titleTokens);

  let score = 0;
  for (const qt of queryTokens) {
    const df = cachedDocFreq.get(qt) || 0;
    if (df === 0) continue;

    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
    const tf = contentTf.get(qt) || 0;
    if (tf > 0) {
      const denom = tf + k1 * (1 - b + (b * docLen) / cachedAvgContentLen);
      score += idf * ((tf * (k1 + 1)) / denom);
    }
    if (titleSet.has(qt)) {
      score += idf * 2.5;
    }
  }

  // Exact substring / bigram overlap boost in title
  const rawQueryWords = tokenize(queryNormalized);
  if (rawQueryWords.length >= 2) {
    for (let i = 0; i < rawQueryWords.length - 1; i++) {
      const bigram = `${rawQueryWords[i]} ${rawQueryWords[i + 1]}`;
      if (chunk.normalizedTitle.includes(bigram)) {
        score += 3.0;
      }
    }
  }

  if (preferredModule && chunk.module === preferredModule) {
    score *= 1.5;
  }

  return score;
};

export type HybridRetrievalMode =
  | "hybrid-openai"
  | "hybrid-gemini"
  | "hybrid-local"
  | "bm25-only";

const computeKbHash = (chunks: KbChunk[]): string => {
  const payload = chunks
    .map((c) => `${c.id}|${c.title}|${c.content}`)
    .join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
};

export const kbRetriever = {
  searchKb: (
    query: string,
    options?: { module?: KbModule; topK?: number },
  ): KbSearchResult[] => {
    const chunks = loadKbIndex();
    if (chunks.length === 0) return [];

    const topK = options?.topK ?? 3;
    const { normalized, tokens } = expandQueryTokens(query);
    if (tokens.length === 0) return [];

    const rank = (pool: KbChunk[], preferred?: KbModule): KbSearchResult[] =>
      pool
        .map((chunk) => ({
          chunk,
          score: scoreBm25(chunk, normalized, tokens, preferred, chunks.length),
        }))
        .filter((r) => r.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

    if (options?.module) {
      const scoped = rank(
        chunks.filter((c) => c.module === options.module),
        options.module,
      );
      if (scoped.length > 0 && scoped[0].score >= 2.0) {
        return scoped;
      }
      // Fallback to all modules if scoped match is empty or weak
      return rank(chunks, options.module);
    }

    return rank(chunks);
  },

  searchKbHybrid: async (
    query: string,
    options?: { module?: KbModule; topK?: number },
  ): Promise<{ results: KbSearchResult[]; mode: HybridRetrievalMode }> => {
    const chunks = loadKbIndex();
    if (chunks.length === 0) {
      return { results: [], mode: "bm25-only" };
    }

    const topK = options?.topK ?? 3;
    const { normalized, tokens } = expandQueryTokens(query);

    // 1. BM25 scores across all chunks (unbiased module score before RRF fusion)
    const bm25Scores = chunks.map((chunk) => ({
      chunk,
      score:
        tokens.length > 0
          ? scoreBm25(chunk, normalized, tokens, undefined, chunks.length)
          : 0,
    }));
    const bm25Ranked = [...bm25Scores]
      .filter((item) => item.score > 0.2)
      .sort((a, b) => b.score - a.score);

    const bm25RankMap = new Map<string, number>();
    bm25Ranked.forEach((item, idx) => {
      bm25RankMap.set(item.chunk.id, idx + 1);
    });
    const bm25ScoreMap = new Map<string, number>();
    bm25Scores.forEach((item) => {
      bm25ScoreMap.set(item.chunk.id, item.score);
    });

    // 2. Vector embeddings for KB chunks + query
    const kbHash = computeKbHash(chunks);
    const kbTexts = chunks.map(
      (c) => `[${c.module}] ${c.title}\n${c.content}`,
    );
    const kbEmb = await embeddingService.getOrComputeKbEmbeddings(
      kbHash,
      kbTexts,
    );

    const expandedQueryForLocal = Array.from(new Set([normalized, ...tokens]))
      .join(" ")
      .trim();
    const queryText =
      kbEmb.provider === "local" ? expandedQueryForLocal || query : query;
    const queryVec = await embeddingService.getOrComputeQueryEmbedding(
      queryText,
      kbEmb.provider,
    );

    const sampleVecLen = kbEmb.vectors[0]?.length ?? 0;
    if (
      !queryVec ||
      sampleVecLen === 0 ||
      queryVec.length !== sampleVecLen ||
      kbEmb.vectors.length !== chunks.length
    ) {
      return {
        results: kbRetriever.searchKb(query, options),
        mode: "bm25-only",
      };
    }

    const minCosine = kbEmb.provider === "local" ? 0.18 : 0.28;
    const vecRanked = chunks
      .map((chunk, idx) => ({
        chunk,
        cosine: cosineSimilarity(queryVec, kbEmb.vectors[idx]),
      }))
      .sort((a, b) => b.cosine - a.cosine);

    const vecRankMap = new Map<string, number>();
    const vecScoreMap = new Map<string, number>();
    vecRanked.forEach((item, idx) => {
      vecRankMap.set(item.chunk.id, idx + 1);
      vecScoreMap.set(item.chunk.id, item.cosine);
    });

    // 3. Reciprocal Rank Fusion (RRF)
    const RRF_K = 60;
    const W_BM25 = 0.55;
    const W_VEC = 0.45;

    const fused: KbSearchResult[] = [];
    for (const chunk of chunks) {
      const bm25Score = bm25ScoreMap.get(chunk.id) ?? 0;
      const cosine = vecScoreMap.get(chunk.id) ?? 0;
      const passesBm25 = bm25Score > 0.2;
      const passesVec = cosine >= minCosine;

      if (!passesBm25 && !passesVec) continue;

      let rrf = 0;
      if (passesBm25) {
        const rank = bm25RankMap.get(chunk.id)!;
        rrf += W_BM25 / (RRF_K + rank);
      }
      if (passesVec) {
        const rank = vecRankMap.get(chunk.id)!;
        rrf += W_VEC / (RRF_K + rank);
      }

      if (options?.module && chunk.module === options.module) {
        rrf *= 1.25;
      }

      fused.push({ chunk, score: rrf });
    }

    fused.sort((a, b) => b.score - a.score);

    return {
      results: fused.slice(0, topK),
      mode: `hybrid-${kbEmb.provider}` as HybridRetrievalMode,
    };
  },

  clearCache: (): void => {
    cachedChunks = null;
    cachedDocFreq = new Map();
    cachedAvgContentLen = 1;
    embeddingService.clearCache();
  },
};
