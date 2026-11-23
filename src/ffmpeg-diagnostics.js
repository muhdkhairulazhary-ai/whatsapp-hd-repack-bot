// FFmpeg may quote paths, URLs, or metadata in stderr. Only fixed identifiers
// from this table may leave the subprocess wrapper.
const signatures = [
  ['memory_allocation', /cannot allocate memory|out of memory|failed to allocate|allocation failed/i],
  ['disk_full', /no space left on device/i],
  ['decoder_unavailable', /decoder\s*\(codec [^)]+\) not found|unknown decoder\b|no decoder found for:|decoding requested, but no decoder found|decoder .* not found for (?:input stream|codec)/i],
  ['decoder_failed', /error while decoding|error submitting (?:a )?packet to (?:the )?decoder|invalid nal unit|could not find ref with poc|error parsing nal/i],
  ['input_invalid', /invalid data found when processing input|moov atom not found|partial file|packet corrupt/i],
  ['stream_mapping', /stream map .* matches no streams|matches no streams|cannot map stream/i],
  ['pixel_format_or_filter', /impossible to convert between the formats|failed to configure output pad|invalid pixel format|pixel format .* is not supported|error reinitializing filters/i],
  ['hdr_metadata', /dolby vision|dovi configuration|invalid color (?:space|transfer|primaries)/i],
  ['encoder_options', /error initializing output stream|error while opening encoder|error opening encoder|unrecognized option|error setting option|vbv buffer underflow|invalid video bitrate/i],
  ['muxer_failed', /could not write header|error writing trailer|tag .* incompatible with output codec|could not find tag for codec|non-monotonous dts/i],
  ['access_or_io', /permission denied|input\/output error|resource temporarily unavailable/i]
];

export function createStderrDiagnostics() {
  let tail = '';
  let bytes = 0;
  const seen = new Set();
  return {
    observe(chunk) {
      bytes = Math.min(1_000_000_000, bytes + chunk.length);
      // Scan each bounded chunk window before discarding it. Keep overlap for
      // phrases split between chunks, without retaining the full stderr.
      for (let offset = 0; offset < chunk.length; offset += 4096) {
        const window = tail + chunk.subarray(offset, offset + 4096);
        for (const [label, pattern] of signatures) {
          if (!seen.has(label) && pattern.test(window)) seen.add(label);
        }
        tail = window.slice(-512);
      }
    },
    has(label) { return seen.has(label); },
    summary() {
      return { stderrBytes: bytes, stderrCategories: signatures.filter(([label]) => seen.has(label)).map(([label]) => label) };
    }
  };
}

const VIDEO_CODECS = new Set(['hevc', 'h264', 'prores', 'mpeg4', 'mjpeg', 'av1', 'vp9']);
const AUDIO_CODECS = new Set(['aac', 'pcm_s16le', 'pcm_s24le', 'alac', 'ac3', 'eac3', 'opus', 'mp3', 'apac']);
const AUDIO_TAGS = new Set(['apac', 'mp4a', 'alac', 'lpcm', 'sowt', 'twos']);
const PIXEL_FORMATS = new Set(['yuv420p', 'yuv420p10le', 'yuv422p', 'yuv422p10le', 'yuv444p', 'yuv444p10le', 'yuvj420p', 'p010le', 'nv12']);
const TRANSFERS = new Set(['bt709', 'smpte2084', 'arib-std-b67', 'iec61966-2-1', 'bt2020-10', 'bt2020-12']);

export function describeFfmpegInput({ video, audio }, { videoMode, audioMode, videoKbps }) {
  const safe = (set, value) => set.has(value) ? value : 'other_or_unknown';
  return {
    videoCodec: safe(VIDEO_CODECS, video.codec_name),
    audioCodec: audio ? safe(AUDIO_CODECS, audio.codec_name) : 'none',
    videoStream: video.index,
    audioStream: audio?.index,
    audioFormatTag: audio ? safe(AUDIO_TAGS, audio.codec_tag_string) : 'none',
    width: video.width,
    height: video.height,
    pixelFormat: safe(PIXEL_FORMATS, video.pix_fmt),
    colorTransfer: safe(TRANSFERS, video.color_transfer),
    dolbyVision: ['dvh1', 'dvhe'].includes(video.codec_tag_string) ||
      Boolean(video.side_data_list?.some(data => data.side_data_type === 'DOVI configuration record')),
    videoMode, audioMode, videoKbps
  };
}
