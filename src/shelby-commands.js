export const branding = {
  name: process.env.BOT_NAME?.trim() || 'Shelby+',
  fullName: process.env.BOT_FULL_NAME?.trim() || 'Shelby+ HD Status Bot',
  tagline: process.env.BOT_TAGLINE?.trim() || 'Your Status. Your Quality.',
  prefix: process.env.BOT_PREFIX?.trim() || '.'
};

if (!/^[^\p{L}\p{N}\s]{1,4}$/u.test(branding.prefix)) throw new Error('Invalid BOT_PREFIX');

const registrationDate = new Intl.DateTimeFormat('ms-MY', {
  dateStyle: 'long', timeZone: 'Asia/Kuala_Lumpur'
});

function cleanName(value) {
  if (value.length > 256) return null;
  const name = value.normalize('NFKC').replace(/\p{Zs}+/gu, ' ').trim();
  if ([...name].length > 50 || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .’'\-]*$/u.test(name)) return null;
  return name;
}

export async function commandReply(text, jid, accounts, brand = branding) {
  const { name, fullName, tagline, prefix } = brand;
  const title = section => `*${name.toUpperCase()} | ${section}*`;
  const registerHint = `Daftar dengan ${prefix}daftar Nama.`;
  const commands = [
    `${prefix}daftar Nama — Daftar akaun`, `${prefix}status — Semak akaun`,
    `${prefix}menu — Menu utama`, `${prefix}help — Bantuan`
  ].join('\n');
  const value = text.trim();
  const [command, argument = ''] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(value)?.slice(1) || [];
  const action = command?.startsWith(prefix) ? command.slice(prefix.length).toLowerCase() : command?.toLowerCase();
  if (action === 'ping') return '🏓 Pong!';
  if (action === 'menu') return [
    title('MAIN MENU'), tagline,
    '🎬 *HD VIDEO*\nHantar video MP4 atau MOV untuk diproses dalam kualiti tinggi.',
    '🖼️ *HD IMAGE*\nHantar gambar JPEG, PNG atau HEIC untuk diproses tanpa mengecilkan resolusi secara tidak perlu.',
    `👤 *ACCOUNT*\n${commands}`,
    '💎 Pelan: Unlimited Free\n⚡ Tiada kredit diperlukan.',
    `${name} — ${tagline}`
  ].join('\n\n');
  if (action === 'help') return [
    title('BANTUAN'), fullName,
    'Hantar video MP4 atau MOV sehingga 150 MB dan 60 saat. Untuk gambar, hantar JPEG, PNG atau HEIC. Hantar sebagai dokumen untuk mengekalkan fail sumber.',
    'Media dipulangkan tanpa kapsyen. WhatsApp mungkin memampatkan semula media apabila anda menyiarkannya ke Status.',
    commands, tagline
  ].join('\n\n');
  if (action === 'daftar' && command.startsWith(prefix)) {
    const displayName = cleanName(argument);
    if (!displayName) {
      const existing = await accounts.get(jid);
      if (existing.registeredAt) return `${title('PENDAFTARAN')}\n\nAkaun anda sudah aktif.\nNama: ${existing.name}\nSemak akaun dengan ${prefix}status.`;
      return `Nama tidak sah. Gunakan 1–50 aksara, termasuk huruf, nombor, ruang, noktah, apostrof atau sempang. ${registerHint}`;
    }
    const { account, changed } = await accounts.register(jid, displayName);
    return [
      title('PENDAFTARAN'), changed ? '✅ Pendaftaran berjaya!' : 'Akaun anda sudah aktif.',
      `Nama: ${account.name}\nStatus: Aktif\nPelan: Unlimited Free\nKredit: Tidak diperlukan`,
      changed ? `Selamat datang ke ${name}.` : `Semak akaun dengan ${prefix}status.`
    ].join('\n\n');
  }
  if (action === 'status' && command.startsWith(prefix)) {
    const account = await accounts.get(jid);
    if (!account.registeredAt) return `${title('MY ACCOUNT')}\n\nAnda belum berdaftar. ${registerHint}`;
    return [
      title('MY ACCOUNT'),
      `👤 Nama: ${account.name}\n✅ Status: Aktif\n💎 Pelan: Unlimited Free\n🎬 Video diproses: ${account.videos}\n🖼️ Gambar diproses: ${account.images}\n📅 Tarikh daftar: ${registrationDate.format(new Date(account.registeredAt))}`,
      tagline
    ].join('\n\n');
  }
}
