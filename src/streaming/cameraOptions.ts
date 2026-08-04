import type { CameraController, CameraStreamingDelegate, HAP } from 'homebridge';
import type { AudioCodecChoice } from './audioCodec';

/**
 * Build a HomeKit CameraController for a delegate. The declared resolutions/profiles are the
 * standard camera set; the delegate maps a request to the right RTSPS substream (see
 * `selectStreamQuality`).
 *
 * `audio` must be omitted unless the delegate will genuinely send audio packets. hap-nodejs fakes
 * a codec when this is absent and iOS renders video happily without audio — but advertising a
 * codec and then sending nothing makes iOS wait for the audio stream and refuse to render the
 * video at all. Pass only a codec that has been functionally probed (see audioCodec.ts).
 */
export function buildCameraController(
  hap: HAP,
  delegate: CameraStreamingDelegate,
  audio?: AudioCodecChoice,
  twoWayAudio = false,
): CameraController {
  return new hap.CameraController({
    cameraStreamCount: 2, // allow a couple of simultaneous viewers
    delegate,
    streamingOptions: {
      supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: {
          profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
          levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
        },
        resolutions: [
          [1920, 1080, 30],
          [1280, 720, 30],
          [1024, 768, 30],
          [640, 360, 30],
          [480, 270, 30],
          [320, 180, 30],
        ],
      },
      // Declared only when a real encoder was found. Mono because HomeKit camera audio is mono;
      // 16/24 kHz are the rates verified working with the Opus encoder against real hardware.
      ...(audio
        ? {
            audio: {
              // Declaring twoWayAudio makes iOS show a microphone button. Only set it when
              // talkback is genuinely enabled: offering a button that does nothing is worse than
              // not offering one.
              twoWayAudio,
              codecs: [
                {
                  type: audio.hapCodec,
                  audioChannels: 1,
                  samplerate: [hap.AudioStreamingSamplerate.KHZ_16, hap.AudioStreamingSamplerate.KHZ_24],
                },
              ],
            },
          }
        : {}),
    },
  });
}
