/**
 * PilotPanel: LLM Provider Contract
 * Abstract interface for language model transport, streaming, and tool execution.
 */

export interface LLMMessagePart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string; // base64 string
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

export interface LLMMessage {
  role: 'user' | 'model' | 'assistant' | 'system';
  parts: LLMMessagePart[];
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LLMConfig {
  apiKey: string;
  modelId: string;
  temperature?: number;
  maxOutputTokens?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
}

export interface LLMResponse {
  text: string;
  functionCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
}

export interface LLMProvider {
  streamChat(
    messages: LLMMessage[],
    tools: ToolDeclaration[],
    config: LLMConfig,
    onDelta?: (delta: string) => void
  ): Promise<LLMResponse>;
}
