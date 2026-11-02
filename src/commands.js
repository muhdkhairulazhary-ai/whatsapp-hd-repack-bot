export function parseCommand(text = '') {
  const command = text.trim().split(/\s+/, 1)[0].toLowerCase();
  if (['media', '/media'].includes(command)) return 'media';
  if (['help', '/help', 'menu'].includes(command)) return 'help';
  if (['ping', '/ping'].includes(command)) return 'ping';
  if (['status', '/status'].includes(command)) return 'status';
  return null;
}

export const HELP_TEXT = [
  '🎬 *WhatsApp HD Repack Bot*',
  '',
  'Send me a video and I will repack it as MP4 (H.264 + AAC, yuv420p), keeping its aspect ratio.',
  '',
  '*Commands*',
  '• MEDIA — hantar video sebagai dokumen (MP4/MOV)',
  '• HELP — show this guide',
  '• PING — check if the bot is responding',
  '• STATUS — show service status',
  '',
  'Send one video per message. Large or unsupported videos may be rejected.'
].join('\n');
