// Скачивание файла, присланного в Telegram (голосовые). Лимит Bot API на скачивание: 20 МБ.
export const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export async function downloadFile(env, api, fileId) {
  const file = await api.getFile(fileId);
  if (!file.file_path) return null;
  const root = env.TG_API_ROOT ?? 'https://api.telegram.org';
  const res = await fetch(`${root}/file/bot${env.TG_BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) return null;
  return { bytes: await res.arrayBuffer(), path: file.file_path };
}
