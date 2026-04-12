// memory-mcp: EmbeddingService — HTTP client to external embedding server
// The model runs in a separate process (Python/other); this is just an HTTP client.

import type { EmbedConfig, EmbedModelInfo, IEmbeddingService } from './interfaces.js';

interface EmbedApiResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

interface HealthResponse {
  status: string;
  model: string;
  backend: string;
  device: string;
  dim: number;
}

export class EmbeddingService implements IEmbeddingService {
  private readonly baseUrl: string;
  private readonly config: EmbedConfig;
  private ready = false;
  private modelId = '';
  private readonly modelRev = 'http-client';

  constructor(config: EmbedConfig) {
    this.config = config;
    this.baseUrl = config.embedUrl;
  }

  async load(): Promise<void> {
    // Try /health first (cat-cafe embed-api.py style), then fall back to a
    // probe embed request (LM Studio / llama.cpp / OpenAI-compatible style).
    try {
      const healthRes = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (healthRes.ok) {
        const health = (await healthRes.json()) as HealthResponse;
        if (health.status === 'ok') {
          this.ready = true;
          this.modelId = health.model || this.config.embedModel;
          return;
        }
      }
    } catch {
      // /health not available — try probe embed below
    }

    // Probe: send a minimal embed request to verify the server is alive
    try {
      const probeRes = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.embedModel, input: ['ping'] }),
        signal: AbortSignal.timeout(5000),
      });
      if (probeRes.ok) {
        this.ready = true;
        this.modelId = this.config.embedModel;
      }
    } catch {
      // fail-open: server not reachable → isReady()=false → lexical-only
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getModelInfo(): EmbedModelInfo {
    return {
      modelId: this.modelId || this.config.embedModel,
      modelRev: this.modelRev,
      dim: this.config.embedDim,
    };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready) throw new Error('EmbeddingService not ready — embedding server not available');

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.config.embedModel, input: texts }),
      signal: AbortSignal.timeout(this.config.embedTimeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Embed API error: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as EmbedApiResponse;
    const targetDim = this.config.embedDim;

    return body.data
      .sort((a, b) => a.index - b.index)
      .map((d) => {
        const arr = new Float32Array(targetDim);
        for (let i = 0; i < Math.min(d.embedding.length, targetDim); i++) {
          arr[i] = d.embedding[i]!;
        }
        return arr;
      });
  }

  dispose(): void {
    this.ready = false;
  }
}
