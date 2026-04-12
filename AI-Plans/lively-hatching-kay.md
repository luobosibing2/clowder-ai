# Plan: 支持外部 OpenAI 兼容服务替代本地 Python 脚本

## Context

项目有四个本地 Python sidecar 脚本（TTS/ASR/Embedding/LLM-postprocess），全部基于 MLX + Apple Silicon GPU。用户希望跳过运行这些脚本，直接将服务指向已有的外部 OpenAI 兼容服务（如 LM Studio）。三个服务都设计为 OpenAI 兼容接口 + env var 配置，架构天然支持替换，但 Embedding 有几处小阻塞需要改代码。

## 兼容性总览

| 服务 | 接口 | 现状 | 需要改代码？ |
|------|------|------|------------|
| **Embedding** | `POST /v1/embeddings` | 健康检查已修（`/health` → `/v1/models` fallback）；但模型名白名单 + 请求体缺 `model` 字段 | **是（4处）** |
| **TTS** | `POST /v1/audio/speech` | `MlxAudioTtsProvider` 已完全兼容 OpenAI 格式，Qwen3 扩展字段可选 | **否** |
| **ASR** | `POST /v1/audio/transcriptions` | 服务端 `WhisperSttProvider` 完全兼容；浏览器直连可能有 CORS 问题 | **可能（CORS）** |

## Phase 1: Embedding 代码修改（4 处必改 + 1 测试）

### 1.1 放宽 `embedModel` 类型（interfaces.ts:175）
```
# 文件: packages/api/src/domains/memory/interfaces.ts
- embedModel: 'qwen3-embedding-0.6b' | 'multilingual-e5-small';
+ embedModel: string;
```

### 1.2 移除模型白名单校验（interfaces.ts:196,202）
```
- const VALID_EMBED_MODELS = new Set(['qwen3-embedding-0.6b', 'multilingual-e5-small']);
  (删除整行)

- if (!VALID_EMBED_MODELS.has(model)) throw new Error(`Invalid embedModel: ${model}`);
  (删除整行)
```

### 1.3 请求体加 `model` 字段（EmbeddingService.ts:99）
```
# 文件: packages/api/src/domains/memory/EmbeddingService.ts
- body: JSON.stringify({ input: texts }),
+ body: JSON.stringify({ input: texts, model: this.config.embedModel }),
```
原因：OpenAI 兼容 API（LM Studio、OpenAI 等）要求请求体包含 `model` 字段。

### 1.4 透传 env vars 到 embed config（index.ts:408）
```
# 文件: packages/api/src/index.ts
- embed: process.env.EMBED_MODE ? { embedMode: process.env.EMBED_MODE as 'off' | 'shadow' | 'on' } : undefined,
+ embed: process.env.EMBED_MODE ? {
+   embedMode: process.env.EMBED_MODE as 'off' | 'shadow' | 'on',
+   ...(process.env.EMBED_MODEL ? { embedModel: process.env.EMBED_MODEL } : {}),
+   ...(process.env.EMBED_DIM ? { embedDim: Number(process.env.EMBED_DIM) } : {}),
+ } : undefined,
```

### 1.5 更新测试（embed-config.test.js）
```
# 文件: packages/api/test/memory/embed-config.test.js
原 "rejects invalid embedModel" 用例 → 改为 "accepts arbitrary embedModel"
```

## Phase 2: TTS — 零代码改动

已完全兼容。`MlxAudioTtsProvider.ts` 发送标准 OpenAI `/v1/audio/speech` 请求：
- Qwen3 扩展字段（`ref_audio`, `ref_text`, `instruct`, `lang_code`）仅在有值时发送
- 外部服务会忽略不认识的字段
- 缺少 `X-Audio-Format` 响应头时有 fallback

唯一注意：外部服务的 voice name 要匹配（如 OpenAI 用 `alloy`/`nova`，可通过 `CAT_OPUS_TTS_VOICE=alloy` 等 env var 覆盖）。

## Phase 3: ASR — 服务端零改动，浏览器可能要处理 CORS

- 服务端 `WhisperSttProvider.ts`：标准 multipart `POST /v1/audio/transcriptions`，直接改 `WHISPER_URL` 即可
- 浏览器 `useVoiceInput.ts`：直连 ASR 服务（不经过 API 代理），外部服务需要允许 CORS
  - 先测试：很多自建服务默认 `Access-Control-Allow-Origin: *`
  - 如果不行：在 `packages/web/next.config.js` 加 rewrite proxy

## 配置速查

```bash
# === Embedding ===
EMBED_MODE=on
EMBED_URL=http://127.0.0.1:1234
EMBED_MODEL=text-embedding-nomic-embed-text-v1.5
# EMBED_DIM=768  # 默认 768，模型输出维度不同时才改

# === TTS（零代码改动）===
TTS_ENABLED=1
TTS_URL=http://your-tts-server:port

# === ASR（零代码改动）===
ASR_ENABLED=1
WHISPER_URL=http://your-asr-server:port
NEXT_PUBLIC_WHISPER_URL=http://your-asr-server:port
```

## 关键文件

| 文件 | 改动 |
|------|------|
| `packages/api/src/domains/memory/interfaces.ts` | 放宽类型 + 移除白名单 |
| `packages/api/src/domains/memory/EmbeddingService.ts` | 请求体加 `model` + 健康检查 fallback（已改） |
| `packages/api/src/index.ts:408` | 透传 `EMBED_MODEL` / `EMBED_DIM` env vars |
| `packages/api/test/memory/embed-config.test.js` | 更新模型校验测试 |

## 验证

1. **Embedding**: 设 env vars → 重启 API → `search_evidence` MCP 工具应能返回语义相关结果
2. **TTS**: 设 `TTS_URL` → 前端发语音 → 确认音频正常播放
3. **ASR**: 设 `WHISPER_URL` → 前端语音输入 → 确认转录正常；如浏览器控制台报 CORS 错误再加 proxy
4. 运行 `pnpm check && pnpm test` 确认无回归
