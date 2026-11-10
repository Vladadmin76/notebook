// Голос в текст через Groq Whisper.
// Документация: https://console.groq.com/docs/speech-to-text
export const STT_MODEL = 'whisper-large-v3-turbo';
const TIMEOUT_MS = 40_000;

// Возвращает распознанный текст (может быть пустой строкой) или null при ошибке
export async function transcribe(env, bytes, filename = 'voice.ogg', mime = 'audio/ogg') {
  const root = env.GROQ_API_ROOT ?? 'https://api.groq.com';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), filename);
  form.append('model', STT_MODEL);
  form.append('language', 'ru');
  form.append('response_format', 'json');
  form.append('temperature', '0');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${root}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
      signal: ctl.signal,
    });
    if (!res.ok) { console.error('groq http', res.status); return null; }
    const data = await res.json();
    return typeof data.text === 'string' ? data.text.trim() : null;
  } catch (e) {
    console.error('groq error', e?.name ?? e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
