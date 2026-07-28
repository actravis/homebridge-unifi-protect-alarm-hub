import type { CameraController, CameraStreamingDelegate, HAP } from 'homebridge';

/**
 * Build a HomeKit CameraController for a delegate. The declared resolutions/profiles are the
 * standard camera set; the delegate maps a request to the right RTSPS substream (see
 * `selectStreamQuality`). Audio / two-way is added in a later sub-phase.
 */
export function buildCameraController(hap: HAP, delegate: CameraStreamingDelegate): CameraController {
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
      // `audio` is intentionally omitted (video-only), matching the canonical hap-nodejs example
      // camera: hap-nodejs fakes an audio codec so HomeKit is satisfied, and the delegate returns
      // NO audio in its PrepareStreamResponse. Advertising audio and then returning an audio
      // endpoint we never feed makes iOS wait for audio and refuse to render video at all.
      // Real camera audio is a separate follow-up (add the codec here AND the response block).
    },
  });
}
