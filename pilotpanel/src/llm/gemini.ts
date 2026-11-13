/**
 * PilotPanel: Google Gemini LLM Provider Implementation
 * Connects directly to Google Generative Language API with streaming and function calling.
 */

import { LLMProvider, LLMMessage, ToolDeclaration, LLMConfig, LLMResponse } from './provider';
import { logger } from '../shared/logger';

export class GeminiProvider implements LLMProvider {
  private endpoint = 'https://generativelanguage.googleapis.com/v1beta/models';

  async streamChat(
    messages: LLMMessage[],
    tools: ToolDeclaration[],
    config: LLMConfig,
    onDelta?: (delta: string) => void
  ): Promise<LLMResponse> {
    if (!config.apiKey) {
      throw new Error('Gemini API key is missing. Please add your API key in Settings.');
    }

    const modelId = config.modelId.trim() || 'gemini-2.5-flash';
    const url = `${this.endpoint}/${modelId}:streamGenerateContent?alt=sse&key=${config.apiKey}`;

    const formattedContents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
        parts: m.parts.map((p) => {
          if (p.text) return { text: p.text };
          if (p.inlineData) return { inlineData: p.inlineData };
          if (p.functionCall) return { functionCall: p.functionCall };
          if (p.functionResponse) return { functionResponse: p.functionResponse };
          return { text: '' };
        }),
      }));

    const payload: Record<string, unknown> = {
      contents: formattedContents,
      generationConfig: {
        temperature: config.temperature ?? 0.2,
        maxOutputTokens: config.maxOutputTokens ?? 2048,
      },
    };

    if (config.systemPrompt) {
      payload.systemInstruction = {
        parts: [{ text: config.systemPrompt }],
      };
    }

    if (tools.length > 0) {
      payload.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    logger.debug('Gemini', `Dispatching streaming request to ${modelId}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: config.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let parsedError = errorText;
      try {
        const jsonErr = JSON.parse(errorText);
        parsedError = jsonErr.error?.message || errorText;
      } catch {
        // Use raw error text if not json
      }

      if (response.status === 400 && parsedError.includes('API_KEY_INVALID')) {
        throw new Error('Invalid Gemini API key. Please check your key in Settings.');
      } else if (response.status === 404) {
        throw new Error(`Model "${modelId}" not found. Verify the model name in Settings.`);
      }

      throw new Error(`Gemini API error (${response.status}): ${parsedError}`);
    }

    if (!response.body) {
      throw new Error('Response body is null.');
    }

    return this.consumeSSEStream(response.body, onDelta);
  }

  private async consumeSSEStream(
    stream: ReadableStream<Uint8Array>,
    onDelta?: (delta: string) => void
  ): Promise<LLMResponse> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const data = JSON.parse(jsonStr);
            const candidates = data.candidates || [];
            if (candidates.length === 0) continue;

            const parts = candidates[0].content?.parts || [];
            for (const part of parts) {
              if (part.text) {
                accumulatedText += part.text;
                if (onDelta) {
                  onDelta(part.text);
                }
              }
              if (part.functionCall) {
                functionCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args || {},
                });
              }
            }
          } catch (parseErr) {
            logger.debug('Gemini', 'Skipping non-JSON SSE chunk', parseErr);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      text: accumulatedText,
      functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
    };
  }
}

export const defaultGeminiProvider = new GeminiProvider();
