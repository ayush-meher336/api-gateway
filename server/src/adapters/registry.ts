import type { ProviderType } from '../db/types.js';
import type { ProviderAdapter } from './types.js';
import { openaiCompatAdapter } from './openaiCompat.js';

const BASE_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  together: 'https://api.together.xyz/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  custom_openai: '',
};

const special: Partial<Record<ProviderType, ProviderAdapter>> = {};

export function registerAdapter(type: ProviderType, a: ProviderAdapter) {
  special[type] = a;
}

export function getAdapter(type: ProviderType): ProviderAdapter {
  return special[type] ?? openaiCompatAdapter;
}

export function defaultBaseUrl(type: ProviderType): string {
  return BASE_URLS[type];
}
