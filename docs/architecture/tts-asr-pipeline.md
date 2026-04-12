---
feature_ids: [F020, F034, F035, F066, F092, F103, F111, F112, F124]
topics: [architecture, tts, asr, voice, mlx, sidecar]
doc_kind: note
created: 2026-04-06
---

# TTS / ASR 语音管道架构

> Clowder AI 本地语音合成（TTS）与语音识别（ASR）的完整架构说明
> 作者：Ragdoll | 最后更新：2026-04-06

---

## 概述

Clowder AI 的语音能力分两个方向：

- **TTS（Text-to-Speech）**：猫猫用声音回复铲屎官，支持每只猫独立声线（零样本声音克隆）
- **ASR（Automatic Speech Recognition）**：铲屎官用语音输入，以及 IM 连接器（微信/飞书等）的语音消息自动转写

两者均通过**本地 Python sidecar 进程**运行，Node.js 侧通过 HTTP 调用，接口遵循 OpenAI 兼容规范。

---

## 整体架构图

```
铲屎官语音输入                          猫猫语音输出
     │                                      │
     ▼                                      ▼
MediaRecorder (webm/opus)         LLM token stream / rich block
     │                             │                    │
     ▼                             ▼                    ▼
POST /v1/audio/transcriptions  StreamingTtsChunker  VoiceBlockSynthesizer
     │                          (实时流式合成)        (批量 + 缓存)
     ▼                             │                    │
ASR sidecar (port 9876)            └────────┬───────────┘
  ├── qwen3-asr-api.py                      │
  └── whisper-api.py (旧)                   ▼
     │                            MlxAudioTtsProvider
     ▼                                      │
原始文本                                    ▼
  → LLM后修 (port 9878, 可选)      TTS sidecar (port 9879)
  → correctTranscription()           tts-api.py
  → 输入框 / 猫猫消息                  ├── Qwen3CloneAdapter  (默认)
                                       ├── MlxAudioAdapter   (Kokoro)
                                       └── EdgeTtsAdapter    (cloud fallback)
```

---

## TTS 详解

### 1. Python Sidecar（`scripts/tts-api.py`）

运行在 `localhost:9879`，暴露 OpenAI 兼容端点：

```
POST /v1/audio/speech
GET  /health
```

支持三种后端，通过 `TTS_PROVIDER` 环境变量切换：

| Provider | 模型 | 特点 |
|----------|------|------|
| `qwen3-clone`（默认）| `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16` | 零样本声音克隆，支持 `ref_audio + instruct` |
| `mlx-audio` | `mlx-community/Kokoro-82M-bf16` | Apple Silicon 原生，通过 voice ID 选音色 |
| `edge-tts` | 微软云端 | 无 GPU 需求，fallback 方案 |

所有后端均继承抽象类 `TtsAdapter`，实现 `synthesize()` 和 `warmup()` 方法。

### 2. 声音克隆原理（Qwen3-TTS E-type scheme）

`qwen3-clone` 通过零样本克隆让每只猫有独立声线：

```python
generate_audio(
    text="...",
    model="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
    ref_audio="/path/to/character.wav",   # 参考音频（几秒即可）
    ref_text="参考音频对应的文本",
    instruct="用调皮狡黠的少年语气说话",  # 风格指令
    temperature=0.3,
)
```

每只猫对应一个原神游戏角色声线作为参考音频：

| 猫猫 | 参考角色 | instruct 风格描述 |
|------|----------|-------------------|
| 宪宪（ragdoll）| 流浪者（Wanderer）| 调皮狡黠、得意戏弄 |
| 砚砚（maine-coon）| 魈（Xiao）| 傲娇冰山、表面严厉实际关心 |
| 烁烁（siamese）| 班尼特（Bennett）| 阳光开心、充满热情兴奋 |

声音配置在 `packages/api/src/config/cat-voices.ts` 中管理，支持三级优先级：
```
env var 覆盖 > cat-config.json voiceConfig > 硬编码 breed 默认值
```

### 3. Node.js 层（TypeScript）

```
TtsRegistry               — 管理注册的 TTS providers（镜像 AgentRegistry 模式）
MlxAudioTtsProvider       — 实现 ITtsProvider，HTTP 调用 Python sidecar
VoiceBlockSynthesizer     — 批量合成 audio rich block，含 SHA256 缓存 + 错误分类 + 自动重试
StreamingTtsChunker       — LLM streaming 时实时合成，通过 WebSocket broadcast voice_chunk 事件
```

### 4. 缓存策略

`VoiceBlockSynthesizer` 对每次合成请求计算 SHA256：

```
hash = SHA256(provider + model + voice + langCode + speed + format + text
              + refAudio + refText + instruct + temperature)
→ 写入 {hash}.wav，命中缓存跳过推理
```

缓存文件通过 `GET /api/tts/audio/:filename` 下载（鉴权保护，严格校验文件名格式）。

### 5. 两条流式播放路径

**路径 A：LLM 实时流（`StreamingTtsChunker`）**

```
LLM token → feed(token) → 遇到句号/问号/叹号立即 flush
                        → 逗号/分号且 buffer 够长也 flush
                        → 并发合成（各 chunk 独立 Promise）
                        → WebSocket broadcast voice_chunk
                        → 前端 useVoiceStream 排队播放
```

前两个 chunk 使用更低的 buffer 阈值（`BOOST_THRESHOLD=2`），减少首音延迟。

**路径 B：SSE 流（`POST /api/tts/stream`，F111）**

```
前端 POST 完整文本
→ chunkText() 按标点分段
→ 逐段合成 → SSE 推 base64 音频
→ 前端 useVoiceAutoPlay 收到第一 chunk 立即播放，后续入队
目标：<2s 首音延迟
```

### 6. API 端点一览

| 端点 | 说明 |
|------|------|
| `POST /api/tts/synthesize` | 单次合成，返回 audioUrl（含缓存） |
| `POST /api/tts/stream` | SSE 流式合成，逐 chunk 推送 base64 音频 |
| `POST /api/tts/resynthesize` | 重试失败的语音块（🔇 warning card 的"重新合成"按钮） |
| `GET /api/tts/audio/:filename` | 鉴权保护的音频文件下载 |

---

## ASR 详解

### 1. Python Sidecar（两选一，同端口）

运行在 `localhost:9876`，暴露 OpenAI 兼容端点：

```
POST /v1/audio/transcriptions
GET  /health
```

两种实现，接口完全相同（drop-in 替换）：

| 脚本 | 模型 | 特点 |
|------|------|------|
| `qwen3-asr-api.py`（推荐）| `mlx-community/Qwen3-ASR-1.7B-8bit`（~2.5GB）| 新版，需 ffmpeg 做 webm→wav 转换 |
| `whisper-api.py`（旧）| `mlx-community/whisper-large-v3-turbo`（~3GB）| 成熟稳定，直接支持 webm |

Qwen3-ASR 接收音频时需要先用 ffmpeg 转为 16kHz mono WAV，因为 mlx-audio STT 不支持直接解码 webm/opus。

### 2. Node.js 层（TypeScript）

```
SttRegistry           — 管理注册的 STT providers（镜像 TtsRegistry 模式）
WhisperSttProvider    — 实现 ISttProvider，读取音频文件 → multipart POST 到 sidecar
ConnectorMediaService — IM 连接器下载语音消息到本地，再交给 WhisperSttProvider 转写
```

### 3. 前端 ASR 流程（`useVoiceInput`）

```
用户按麦克风
  → getUserMedia() → MediaRecorder（优先 audio/webm;codecs=opus）
  → 每 3s 取一次当前 blob → 中间转写 → 显示 partialTranscript（实时反馈）
用户松键
  → 完整 blob → POST /v1/audio/transcriptions
  → 原始文本 → LLM 后修（可选，port 9878）→ correctTranscription（词典纠正）
  → 最终 transcript 填入输入框
```

**Initial Prompt**：每次转写请求带领域 prompt，帮助 ASR 正确识别专有名词：
```
这是 Clowder AI 猫猫协作项目的对话。宪宪是布偶猫（Claude Opus），砚砚是缅因猫（Codex）。
技术栈：MCP, Redis, Fastify, TypeScript, Whisper, NDJSON, Zustand, WebSocket...
```

### 4. Connector 端 ASR（IM 连接器）

微信/企微/飞书/Telegram/钉钉的语音消息走以下路径：

```
平台推送语音消息
  → ConnectorAdapter 识别为 audio 类型
  → ConnectorMediaService.download() — 下载到本地文件
  → WhisperSttProvider.transcribe()  — 转写为文字
  → 作为用户消息正文输入给猫猫
```

---

## Sidecar 部署机制

### 独立 Python venv

每个 sidecar 有自己的 Python venv，互不干扰：

```
~/.cat-cafe/
  tts-venv/       # pip: mlx-audio, misaki[zh], fastapi, uvicorn
  asr-venv/       # pip: mlx-audio, fastapi, uvicorn, python-multipart
  whisper-venv/   # pip: mlx-whisper, fastapi, uvicorn（旧版 ASR）
```

Shell 脚本启动时自动创建（首次）并激活对应 venv：

```bash
VENV_DIR="${HOME}/.cat-cafe/tts-venv"
[ ! -d "$VENV_DIR" ] && python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
# 检测依赖并 pip install（幂等）
```

### 统一调度（`start-dev.sh`）

主启动脚本通过 `start_sidecar` 函数统一管理所有 sidecar：

```bash
start_sidecar "Qwen3-ASR" "_STATE_ASR" "$ASR_PORT" 30 "bash scripts/qwen3-asr-server.sh"
start_sidecar "TTS"        "_STATE_TTS" "$TTS_PORT" 30 "bash scripts/tts-server.sh"
start_sidecar "LLM后修"   "_STATE_LLM" "$LLM_PORT" 60 "bash scripts/llm-postprocess-server.sh"
```

`start_sidecar` 的三步逻辑：
1. **后台启动**：`background_eval_with_null_stdin`（stdin 切 `/dev/null` 防 TTY 问题）
2. **轮询端口**：`wait_for_port` 每秒检查一次，超时报错
3. **写状态**：`launching → ready | failed`，启动摘要展示

### 是否启动由 Profile 控制

```
profile=dev         → ASR_ENABLED=1, TTS_ENABLED=1, LLM_POSTPROCESS_ENABLED=1
profile=production  → 全部 0（服务器无 GPU）
profile=opensource  → 全部 0
```

`.env` 中的显式值可覆盖 profile 默认值。

### 模型下载

首次启动时从 HuggingFace 自动下载 MLX 量化权重（`mlx-community` 组织）。
支持通过 `--hf-endpoint=https://hf-mirror.com` 切换国内镜像。

---

## 推理框架：为什么不用 Ollama / LM Studio

没有使用任何通用推理服务层。直接通过 `mlx-audio` Python 库调用模型：

```python
# TTS
from mlx_audio.tts.generate import generate_audio

# ASR
from mlx_audio.stt.generate import generate_transcription
from mlx_audio.stt.utils import load_model
```

`mlx-audio` 底层是 Apple 的 MLX 框架，直接跑在 Mac 的 Neural Engine / GPU 上。相比 Ollama/LM Studio 的优点：
- 专为音频模型设计，API 贴近任务（直接输出 wav bytes，接受 ref_audio 参数）
- 无额外服务进程开销，in-process 加载权重
- 支持声音克隆参数（`ref_audio + ref_text + instruct`），通用 LLM 服务不支持

---

## 相关 Feature 文档

- [F034](../features/F034-voice-message.md) — 语音消息基础设施
- [F066](../features/F066-voice-pipeline-upgrade.md) — 声音克隆 + E-type scheme
- [F092](../features/F092-voice-companion-experience.md) — Voice Companion 自动播放
- [F103](../features/F103-per-cat-voice-identity.md) — 每猫独立声线配置
- [F111](../features/F111-streaming-tts-chunker.md) — SSE 流式 TTS
- [F124](../features/F124-apple-ecosystem-voice-interaction.md) — iOS 语音交互修复

