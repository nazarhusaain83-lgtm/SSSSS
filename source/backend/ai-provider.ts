import { secrets } from '@appdeploy/sdk';

export type AiProvider = 'auto' | 'gemini' | 'groq';
export type AiResult = {
  text: string;
  provider: 'gemini' | 'groq';
  model: string;
};

class ProviderError extends Error {
  status: number;
  provider: 'gemini' | 'groq';
  constructor(provider: 'gemini' | 'groq', status: number, message: string) {
    super(message);
    this.provider = provider;
    this.status = status;
  }
}

async function requestGemini(
  apiKey: string,
  system: string,
  prompt: string,
  maxTokens: number,
  jsonMode: boolean
) {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      method: 'POST',
      signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: 'gemini-3.8-flash',
        input: prompt,
        system_instruction: system,
        store: false,
        generation_config: {
          max_output_tokens: maxTokens,
          thinking_level: 'medium',
        },
        ...(jsonMode
          ? {
              response_format: {
                type: 'text',
                mime_type: 'application/json',
                schema: { type: 'object' },
              },
            }
          : {}),
      }),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || 'Gemini request failed.';
    throw new ProviderError(
      'gemini',
      response.status,
      String(message).slice(0, 400)
    );
  }
  if (
    data?.status === 'failed' ||
    data?.status === 'incomplete' ||
    data?.status === 'budget_exceeded'
  ) {
    const message =
      data?.errors?.[0]?.message ||
      'Gemini could not complete the interaction.';
    throw new ProviderError('gemini', 502, String(message).slice(0, 400));
  }
  const text = (data?.steps || [])
    .filter((step: any) => step.type === 'model_output')
    .flatMap((step: any) => step.content || [])
    .filter((part: any) => part.type === 'text')
    .map((part: any) => part.text || '')
    .join('');
  if (!text)
    throw new ProviderError(
      'gemini',
      502,
      'Gemini returned an empty response.'
    );
  return { text, provider: 'gemini' as const, model: 'gemini-3.8-flash' };
}

async function requestGroq(
  apiKey: string,
  system: string,
  prompt: string,
  maxTokens: number,
  temperature: number,
  jsonMode: boolean
) {
  const response = await fetch(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      signal: AbortSignal.timeout(45000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        temperature,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || 'Groq request failed.';
    throw new ProviderError(
      'groq',
      response.status,
      String(message).slice(0, 400)
    );
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim())
    throw new ProviderError('groq', 502, 'Groq returned an empty response.');
  return { text, provider: 'groq' as const, model: 'openai/gpt-oss-20b' };
}

function canFallback(err: unknown) {
  if (!(err instanceof ProviderError)) return true;
  return (
    err.status === 408 ||
    err.status === 409 ||
    err.status === 425 ||
    err.status === 429 ||
    err.status >= 500
  );
}

export async function generateWithFreeProviders(input: {
  system: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  provider?: AiProvider;
  jsonMode?: boolean;
}): Promise<AiResult> {
  const names = await secrets.listSecretNames();
  const hasGemini = names.includes('GEMINI_API_KEY');
  const hasGroq = names.includes('GROQ_API_KEY');
  const preferred = input.provider || 'auto';
  const order: Array<'gemini' | 'groq'> =
    preferred === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const configured = order.filter(provider =>
    provider === 'gemini' ? hasGemini : hasGroq
  );
  if (!configured.length)
    throw new Error(
      'No free AI provider is configured. Add a Gemini or Groq API key in AppDeploy secrets.'
    );

  let lastError: unknown = null;
  for (let index = 0; index < configured.length; index++) {
    const provider = configured[index];
    try {
      const key = await secrets.readSecret(
        provider === 'gemini' ? 'GEMINI_API_KEY' : 'GROQ_API_KEY'
      );
      if (provider === 'gemini') {
        return await requestGemini(
          key,
          input.system,
          input.prompt,
          input.maxTokens,
          !!input.jsonMode
        );
      }
      return await requestGroq(
        key,
        input.system,
        input.prompt,
        input.maxTokens,
        input.temperature,
        !!input.jsonMode
      );
    } catch (err) {
      lastError = err;
      const isGroqJsonGenerationFailure =
        input.jsonMode &&
        provider === 'groq' &&
        err instanceof ProviderError &&
        err.status === 400 &&
        /failed_generation|failed to generate json/i.test(err.message);
      if (isGroqJsonGenerationFailure) {
        try {
          const key = await secrets.readSecret('GROQ_API_KEY');
          return await requestGroq(
            key,
            input.system +
              '\\nReturn exactly one valid JSON object and nothing else. Do not use markdown fences or explanatory text.',
            input.prompt +
              '\\nIMPORTANT: Output a complete valid JSON object only. Do not stop mid-value. Keep the structure concise and satisfy every required field.',
            input.maxTokens,
            input.temperature,
            false
          );
        } catch (retryErr) {
          lastError = retryErr;
        }
      }
      if (index < configured.length - 1 && canFallback(err)) continue;
      break;
    }
  }
  if (lastError instanceof ProviderError) {
    if (lastError.status === 429)
      throw new Error(
        lastError.provider.toUpperCase() +
          ' free quota is currently reached. Try again later or switch provider.'
      );
    if (lastError.status === 401 || lastError.status === 403)
      throw new Error(
        lastError.provider.toUpperCase() +
          ' rejected its API key. Check the key in AppDeploy secrets.'
      );
    throw new Error(
      lastError.message || 'The AI provider could not complete the request.'
    );
  }
  if (lastError instanceof Error)
    throw new Error(lastError.message.slice(0, 400));
  throw new Error(
    'Both free AI providers are temporarily unavailable. Please retry in a moment.'
  );
}
