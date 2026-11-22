// VBV can start with up to half a second of video bits in its buffer.
const BUFFER_SECONDS = 0.5;
const CONTAINER_RESERVE_BYTES = 128 * 1024;

export function planHevcSize({ duration, video, audio, maxBytes }, retryKbps) {
  const [frames, seconds] = (video.avg_frame_rate || '').split('/').map(Number);
  const fps = frames / seconds;
  const pixelsPerSecond = video.width * video.height * (Number.isFinite(fps) && fps > 0 ? fps : 30);
  const minimumKbps = Math.ceil(Math.max(350, pixelsPerSecond * 0.045 / 1000));
  const preferredKbps = Math.max(minimumKbps, pixelsPerSecond * 0.075 / 1000,
    (Number(video.bit_rate) || 0) * 2 / 1000);
  const audioKbps = Math.max(192, (Number(audio?.bit_rate) || 0) / 1000);
  const budgetBits = (maxBytes * 0.95 - CONTAINER_RESERVE_BYTES) * 8;
  const capKbps = Math.floor((budgetBits / 1000 - audioKbps * duration) / (duration + BUFFER_SECONDS));
  const videoKbps = Math.floor(Math.min(preferredKbps, capKbps, retryKbps ?? Infinity));
  return {
    videoKbps, minimumKbps, bufferKbits: Math.ceil(videoKbps * BUFFER_SECONDS),
    estimatedBytes: Math.ceil((videoKbps * (duration + BUFFER_SECONDS) + audioKbps * duration) * 1000 / 8 +
      CONTAINER_RESERVE_BYTES)
  };
}
