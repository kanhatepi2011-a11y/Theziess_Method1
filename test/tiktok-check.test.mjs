import { describe, expect, it } from "vitest";
import {
  extractTikTokDataFromHtml,
  normalizeExternalMethodName,
} from "../server/routes/tiktok/check.js";

describe("TikTok video checker metadata parser", () => {
  it("returns the exact Method/Artist value extracted by checker variants", () => {
    expect(normalizeExternalMethodName({ method_name: "TheziessMethod.site" }))
      .toBe("TheziessMethod.site");
    expect(normalizeExternalMethodName({ format: { tags: { artist: "Actual Artist Tag" } } }))
      .toBe("Actual Artist Tag");
    expect(normalizeExternalMethodName({ method_detected: false }))
      .toBeNull();
  });

  it("extracts resolution, bitrate, fps, duration and size", () => {
    const state = {
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": {
          itemInfo: {
            itemStruct: {
              id: "1234567890123456789",
              desc: "Sample TikTok video",
              author: { uniqueId: "sampleuser" },
              video: {
                width: 1080,
                height: 1920,
                duration: 15,
                bitrateInfo: [
                  {
                    Bitrate: 1450000,
                    FPS: 30,
                    DataSize: 2718750,
                    CodecType: "h264",
                    PlayAddr: {
                      UrlList: ["https://v16.tiktokcdn.com/video.mp4"],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };

    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(state)}</script>`;
    const result = extractTikTokDataFromHtml(
      html,
      "https://www.tiktok.com/@sampleuser/video/1234567890123456789",
    );

    expect(result.videoId).toBe("1234567890123456789");
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.bitrate).toBe(1450000);
    expect(result.fps).toBe(30);
    expect(result.duration).toBe(15);
    expect(result.fileSize).toBe(2718750);
  });
  it("ignores FPS values written only in the caption", () => {
    const state = {
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": {
          itemInfo: {
            itemStruct: {
              id: "9876543210987654321",
              desc: "Test 600Fpa #120fps #6000fps",
              author: { uniqueId: "captiononly" },
              video: { width: 1080, height: 1920, duration: 18 },
            },
          },
        },
      },
    };

    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(state)}</script>`;
    const result = extractTikTokDataFromHtml(
      html,
      "https://www.tiktok.com/@captiononly/video/9876543210987654321",
    );

    expect(result.fps).toBeNull();
    expect(result).not.toHaveProperty("claimedFps");
  });

});
