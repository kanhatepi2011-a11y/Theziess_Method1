import { getSession } from "../_session.js";
import { pythonTikTokCheckerEnabled, runPythonTikTokChecker } from "../_tiktok-python-checker.js";

const PAGE_TIMEOUT_MS = 7000;
const MEDIA_TIMEOUT_MS = 6000;
const OEMBED_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_JSON_NODES = 180000;
const INITIAL_PROBE_BYTES = 2 * 1024 * 1024;
const END_PROBE_BYTES = 4 * 1024 * 1024;
const MAX_MOOV_BYTES = 10 * 1024 * 1024;
const MAX_SUPPORTED_FPS = 10000;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function isTikTokPageHost(hostname) {
  const host = normalizeHostname(hostname);
  return host === "tiktok.com" || host.endsWith(".tiktok.com");
}

function isTikTokMediaHost(hostname) {
  const host = normalizeHostname(hostname);
  const suffixes = [
    ".tiktokcdn.com",
    ".tiktokv.com",
    ".muscdn.com",
    ".byteoversea.com",
    ".ibytedtos.com",
    ".akamaized.net",
    ".bytecdn.cn",
  ];

  return isTikTokPageHost(host) || suffixes.some((suffix) => host.endsWith(suffix));
}

function normalizeTikTokUrl(input) {
  let value = String(input || "").trim();
  if (!value) {
    throw Object.assign(new Error("Paste a TikTok video link first."), {
      code: "MISSING_TIKTOK_URL",
    });
  }

  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("The TikTok link is not valid."), {
      code: "INVALID_TIKTOK_URL",
    });
  }

  if (!isTikTokPageHost(url.hostname)) {
    throw Object.assign(
      new Error("Only links from tiktok.com, vm.tiktok.com or vt.tiktok.com are supported."),
      { code: "UNSUPPORTED_TIKTOK_HOST" },
    );
  }

  url.protocol = "https:";
  url.hash = "";
  return url.toString();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PAGE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(new Error("TikTok took too long to respond."), {
        code: "TIKTOK_TIMEOUT",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Ignore stream cancellation failures.
  }
}

async function fetchTikTokPage(startUrl) {
  let currentUrl = startUrl;

  for (let redirects = 0; redirects <= 6; redirects += 1) {
    const response = await fetchWithTimeout(
      currentUrl,
      {
        method: "GET",
        redirect: "manual",
        headers: BROWSER_HEADERS,
      },
      PAGE_TIMEOUT_MS,
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await cancelBody(response);

      if (!location) {
        throw Object.assign(new Error("TikTok returned an invalid redirect."), {
          code: "INVALID_TIKTOK_REDIRECT",
        });
      }

      const nextUrl = new URL(location, currentUrl);
      if (!isTikTokPageHost(nextUrl.hostname)) {
        throw Object.assign(new Error("TikTok redirected to an unsupported website."), {
          code: "UNSAFE_TIKTOK_REDIRECT",
        });
      }

      currentUrl = nextUrl.toString();
      continue;
    }

    if (!response.ok) {
      await cancelBody(response);
      throw Object.assign(
        new Error(`TikTok returned HTTP ${response.status}. The video may be private or unavailable.`),
        { code: "TIKTOK_PAGE_UNAVAILABLE", status: response.status },
      );
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_HTML_BYTES) {
      await cancelBody(response);
      throw Object.assign(new Error("The TikTok page response is too large to inspect safely."), {
        code: "TIKTOK_PAGE_TOO_LARGE",
      });
    }

    const html = await readLimitedText(response, MAX_HTML_BYTES);
    return {
      html,
      finalUrl: currentUrl,
    };
  }

  throw Object.assign(new Error("TikTok redirected too many times."), {
    code: "TOO_MANY_TIKTOK_REDIRECTS",
  });
}

async function readLimitedText(response, maximumBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      throw Object.assign(new Error("TikTok returned too much page data."), {
        code: "TIKTOK_PAGE_TOO_LARGE",
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw Object.assign(new Error("TikTok returned too much page data."), {
          code: "TIKTOK_PAGE_TOO_LARGE",
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures.
    }
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(decodeHtmlEntities(value).trim());
  } catch {
    return null;
  }
}

function hasVideoShape(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.video &&
      typeof value.video === "object" &&
      (value.id || value.video.id || value.video.playAddr || value.video.bitrateInfo),
  );
}

function findItemStruct(root) {
  if (!root || typeof root !== "object") return null;

  const preferred = [
    root?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct,
    root?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStructV2,
    root?.props?.pageProps?.itemInfo?.itemStruct,
    root?.itemInfo?.itemStruct,
  ];

  for (const candidate of preferred) {
    if (hasVideoShape(candidate)) return candidate;
  }

  if (root.ItemModule && typeof root.ItemModule === "object") {
    for (const candidate of Object.values(root.ItemModule)) {
      if (hasVideoShape(candidate)) return candidate;
    }
  }

  const stack = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  let visited = 0;

  while (stack.length > 0 && visited < MAX_JSON_NODES) {
    const current = stack.pop();
    const value = current?.value;
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    visited += 1;

    if (hasVideoShape(value)) return value;
    if (current.depth >= 15) continue;

    const children = Array.isArray(value) ? value : Object.values(value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child && typeof child === "object") {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function unescapeJsonString(value) {
  if (typeof value !== "string") return "";
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value
      .replace(/\\u002F/gi, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/");
  }
}

function findJsonString(html, key) {
  const expression = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "i");
  const match = expression.exec(html);
  if (!match) return "";

  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return unescapeJsonString(match[1]);
  }
}

function findJsonNumber(html, keys) {
  for (const key of keys) {
    const expression = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, "i");
    const match = expression.exec(html);
    if (match) return Number(match[1]);
  }
  return null;
}

function pickUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return unescapeJsonString(value);
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const url = pickUrl(candidate);
      if (url) return url;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  const candidates = [
    value.UrlList,
    value.urlList,
    value.url_list,
    value.urls,
    value.url,
    value.src,
  ];

  for (const candidate of candidates) {
    const url = pickUrl(candidate);
    if (url) return url;
  }

  return "";
}

function toFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function normalizeFpsValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const match = String(value).trim().match(/-?\d+(?:\.\d+)?/);
    const number = match ? Number(match[0]) : Number(value);
    if (Number.isFinite(number) && number > 0 && number <= MAX_SUPPORTED_FPS) {
      return number;
    }
  }
  return null;
}

function chooseBitrateEntry(video) {
  const entries = video?.bitrateInfo || video?.bitrate_info || video?.bitRateInfo;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  return [...entries].sort((left, right) => {
    const leftRate = toFiniteNumber(left?.Bitrate, left?.bitrate, left?.bit_rate) || 0;
    const rightRate = toFiniteNumber(right?.Bitrate, right?.bitrate, right?.bit_rate) || 0;
    return rightRate - leftRate;
  })[0];
}

function extractVideoData(item, html, finalUrl) {
  const video = item?.video || {};
  const bitrateEntry = chooseBitrateEntry(video);
  const title = String(item?.desc || item?.title || "").trim();
  const metadataFps = normalizeFpsValue(
    bitrateEntry?.FPS,
    bitrateEntry?.fps,
    video.fps,
    video.frameRate,
    video.frame_rate,
    video.frameRateNum,
    video.frame_rate_num,
    findJsonNumber(html, ["FPS", "fps", "frameRate", "frame_rate"]),
  );
  const mediaUrl =
    pickUrl(bitrateEntry?.PlayAddr) ||
    pickUrl(bitrateEntry?.playAddr) ||
    pickUrl(video.playAddrH264) ||
    pickUrl(video.playAddr) ||
    pickUrl(video.downloadAddr) ||
    findJsonString(html, "playAddr") ||
    findJsonString(html, "downloadAddr");

  const author = item?.author || item?.authorInfo || {};
  const videoId =
    String(item?.id || item?.awemeId || "") ||
    finalUrl.match(/\/video\/(\d+)/)?.[1] ||
    html.match(/"(?:awemeId|videoId|itemId)"\s*:\s*"?(\d{8,})"?/)?.[1] ||
    "";

  return {
    videoId,
    title,
    author: String(author?.uniqueId || author?.unique_id || author?.nickname || "").trim(),
    width: toFiniteNumber(
      bitrateEntry?.PlayAddr?.Width,
      bitrateEntry?.playAddr?.width,
      video.width,
      video.videoWidth,
      findJsonNumber(html, ["width", "videoWidth"]),
    ),
    height: toFiniteNumber(
      bitrateEntry?.PlayAddr?.Height,
      bitrateEntry?.playAddr?.height,
      video.height,
      video.videoHeight,
      findJsonNumber(html, ["height", "videoHeight"]),
    ),
    duration: toFiniteNumber(
      video.duration,
      item?.videoDuration,
      item?.duration,
      findJsonNumber(html, ["duration", "videoDuration"]),
    ),
    fps: metadataFps,
    fpsSource: metadataFps ? "tiktok_metadata" : null,
    frameCount: toFiniteNumber(
      video.frameCount,
      video.frame_count,
      video.nbFrames,
      video.nb_frames,
      bitrateEntry?.FrameCount,
      bitrateEntry?.frameCount,
      findJsonNumber(html, ["frameCount", "frame_count", "nbFrames", "nb_frames"]),
    ),
    bitrate: toFiniteNumber(
      bitrateEntry?.Bitrate,
      bitrateEntry?.bitrate,
      bitrateEntry?.bit_rate,
      video.bitrate,
      video.bitRate,
      findJsonNumber(html, ["Bitrate", "bitrate", "bitRate"]),
    ),
    fileSize: toFiniteNumber(
      bitrateEntry?.DataSize,
      bitrateEntry?.dataSize,
      bitrateEntry?.data_size,
      video.size,
      video.fileSize,
      findJsonNumber(html, ["DataSize", "dataSize", "fileSize"]),
    ),
    codec: String(
      bitrateEntry?.CodecType || bitrateEntry?.codecType || video.codecType || "",
    ).trim(),
    mediaUrl,
    thumbnail:
      pickUrl(video.cover) ||
      pickUrl(video.originCover) ||
      pickUrl(video.dynamicCover) ||
      "",
  };
}

export function extractTikTokDataFromHtml(html, finalUrl) {
  const scripts = [];
  const scriptExpression =
    /<script\b[^>]*(?:id=["'](?:__UNIVERSAL_DATA_FOR_REHYDRATION__|SIGI_STATE|__NEXT_DATA__)["']|type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;

  let match;
  while ((match = scriptExpression.exec(html)) !== null) {
    const parsed = parseJsonSafely(match[1]);
    if (parsed) scripts.push(parsed);
  }

  let item = null;
  for (const parsed of scripts) {
    item = findItemStruct(parsed);
    if (item) break;
  }

  const extracted = extractVideoData(item || {}, html, finalUrl);
  if (!extracted.videoId && !extracted.mediaUrl && !extracted.duration) {
    throw Object.assign(
      new Error("TikTok did not expose video metadata. The post may be private, deleted or region-restricted."),
      { code: "TIKTOK_METADATA_NOT_FOUND" },
    );
  }

  return extracted;
}

async function getOEmbed(finalUrl) {
  try {
    const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(finalUrl)}`;
    const response = await fetchWithTimeout(
      endpoint,
      {
        headers: {
          ...BROWSER_HEADERS,
          Accept: "application/json",
        },
      },
      OEMBED_TIMEOUT_MS,
    );

    if (!response.ok) {
      await cancelBody(response);
      return null;
    }

    const data = await response.json();
    const embedHtml = String(data?.html || "");
    const videoId =
      finalUrl.match(/\/video\/(\d+)/)?.[1] ||
      embedHtml.match(/data-video-id=["'](\d+)["']/i)?.[1] ||
      embedHtml.match(/\/video\/(\d+)/)?.[1] ||
      "";

    return {
      videoId,
      title: String(data?.title || "").trim(),
      author: String(data?.author_name || "").trim(),
      authorUrl: String(data?.author_url || "").trim(),
      thumbnail: String(data?.thumbnail_url || "").trim(),
    };
  } catch {
    return null;
  }
}

function parseContentRangeTotal(value) {
  const match = String(value || "").match(/\/([0-9]+)$/);
  return match ? Number(match[1]) : null;
}

async function fetchMediaResponse(url, options, timeoutMs = MEDIA_TIMEOUT_MS) {
  let currentUrl = url;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const parsed = new URL(currentUrl);
    if (!isTikTokMediaHost(parsed.hostname)) {
      throw Object.assign(new Error("TikTok returned an unsupported media host."), {
        code: "UNSAFE_MEDIA_HOST",
      });
    }

    const response = await fetchWithTimeout(
      currentUrl,
      {
        ...options,
        redirect: "manual",
      },
      timeoutMs,
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await cancelBody(response);
      if (!location) return { response, finalUrl: currentUrl };

      const nextUrl = new URL(location, currentUrl);
      if (!isTikTokMediaHost(nextUrl.hostname)) {
        throw Object.assign(new Error("TikTok redirected the video to an unsupported host."), {
          code: "UNSAFE_MEDIA_REDIRECT",
        });
      }
      currentUrl = nextUrl.toString();
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  throw Object.assign(new Error("TikTok media redirected too many times."), {
    code: "TOO_MANY_MEDIA_REDIRECTS",
  });
}

async function getMediaSize(mediaUrl, referer) {
  if (!mediaUrl) return null;

  const headers = {
    ...BROWSER_HEADERS,
    Accept: "video/mp4,video/*;q=0.9,*/*;q=0.5",
    Referer: referer,
  };

  try {
    const { response } = await fetchMediaResponse(
      mediaUrl,
      { method: "HEAD", headers },
      MEDIA_TIMEOUT_MS,
    );

    const size = toFiniteNumber(
      parseContentRangeTotal(response.headers.get("content-range")),
      response.headers.get("content-length"),
    );
    await cancelBody(response);
    if (size) return size;
  } catch {
    // Some TikTok CDNs reject HEAD. Range GET is attempted below.
  }

  try {
    const { response } = await fetchMediaResponse(
      mediaUrl,
      {
        method: "GET",
        headers: {
          ...headers,
          Range: "bytes=0-0",
        },
      },
      MEDIA_TIMEOUT_MS,
    );

    const size = toFiniteNumber(
      parseContentRangeTotal(response.headers.get("content-range")),
      response.status === 200 ? response.headers.get("content-length") : null,
    );
    await cancelBody(response);
    return size;
  } catch {
    return null;
  }
}

async function readLimitedBytes(response, maximumBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > maximumBytes ? buffer.slice(0, maximumBytes) : buffer;
  }

  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maximumBytes - total;
      if (remaining <= 0) {
        await reader.cancel();
        break;
      }
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= maximumBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures.
    }
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchRange(mediaUrl, referer, start, end, maximumBytes) {
  const { response } = await fetchMediaResponse(
    mediaUrl,
    {
      method: "GET",
      headers: {
        ...BROWSER_HEADERS,
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.5",
        Referer: referer,
        Range: `bytes=${start}-${end}`,
      },
    },
    MEDIA_TIMEOUT_MS,
  );

  if (!response.ok && response.status !== 206) {
    await cancelBody(response);
    throw Object.assign(new Error(`TikTok media returned HTTP ${response.status}.`), {
      code: "TIKTOK_MEDIA_UNAVAILABLE",
    });
  }

  const totalSize = toFiniteNumber(
    parseContentRangeTotal(response.headers.get("content-range")),
    response.status === 200 ? response.headers.get("content-length") : null,
  );
  const bytes = await readLimitedBytes(response, maximumBytes);
  return { bytes, totalSize };
}

function readUint32(view, offset) {
  if (offset < 0 || offset + 4 > view.byteLength) return null;
  return view.getUint32(offset, false);
}

function readUint64(view, offset) {
  if (offset < 0 || offset + 8 > view.byteLength) return null;
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  const value = high * 2 ** 32 + low;
  return Number.isSafeInteger(value) ? value : null;
}

function readType(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return "";
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function listBoxes(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let position = start;

  while (position + 8 <= end) {
    let size = readUint32(view, position);
    const type = readType(bytes, position + 4);
    let headerSize = 8;

    if (size === 1) {
      size = readUint64(view, position + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - position;
    }

    if (!size || size < headerSize || position + size > end || !/^[\x20-\x7E]{4}$/.test(type)) {
      break;
    }

    boxes.push({
      type,
      start: position,
      end: position + size,
      size,
      headerSize,
      contentStart: position + headerSize,
    });
    position += size;
  }

  return boxes;
}

function childBox(bytes, parent, type) {
  return listBoxes(bytes, parent.contentStart, parent.end).find((box) => box.type === type) || null;
}

function findMoovCandidate(bytes, absoluteChunkStart) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let typeOffset = 4; typeOffset + 4 <= bytes.length; typeOffset += 1) {
    if (readType(bytes, typeOffset) !== "moov") continue;

    const boxStart = typeOffset - 4;
    let size = readUint32(view, boxStart);
    let headerSize = 8;
    if (size === 1) {
      size = readUint64(view, boxStart + 8);
      headerSize = 16;
    }

    if (!size || size < headerSize || size > MAX_MOOV_BYTES) continue;

    return {
      absoluteStart: absoluteChunkStart + boxStart,
      relativeStart: boxStart,
      size,
      complete: boxStart + size <= bytes.length,
    };
  }

  return null;
}

function parseFullBoxTiming(bytes, box) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[box.contentStart];
  if (version === 1) {
    return {
      timescale: readUint32(view, box.contentStart + 20),
      duration: readUint64(view, box.contentStart + 24),
    };
  }
  return {
    timescale: readUint32(view, box.contentStart + 12),
    duration: readUint32(view, box.contentStart + 16),
  };
}

function parseMp4Moov(moovBytes) {
  const rootBoxes = listBoxes(moovBytes, 0, moovBytes.length);
  const moov = rootBoxes.find((box) => box.type === "moov");
  if (!moov) return null;

  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const mvhd = childBox(moovBytes, moov, "mvhd");
  const movieTiming = mvhd ? parseFullBoxTiming(moovBytes, mvhd) : null;
  const tracks = listBoxes(moovBytes, moov.contentStart, moov.end).filter(
    (box) => box.type === "trak",
  );

  for (const trak of tracks) {
    const tkhd = childBox(moovBytes, trak, "tkhd");
    const mdia = childBox(moovBytes, trak, "mdia");
    if (!mdia) continue;

    const hdlr = childBox(moovBytes, mdia, "hdlr");
    const handlerType = hdlr ? readType(moovBytes, hdlr.contentStart + 8) : "";
    if (handlerType !== "vide") continue;

    const mdhd = childBox(moovBytes, mdia, "mdhd");
    const mediaTiming = mdhd ? parseFullBoxTiming(moovBytes, mdhd) : null;
    const minf = childBox(moovBytes, mdia, "minf");
    const stbl = minf ? childBox(moovBytes, minf, "stbl") : null;
    const stts = stbl ? childBox(moovBytes, stbl, "stts") : null;
    const stsz = stbl ? childBox(moovBytes, stbl, "stsz") : null;
    const stz2 = stbl ? childBox(moovBytes, stbl, "stz2") : null;
    const stsd = stbl ? childBox(moovBytes, stbl, "stsd") : null;

    let sampleCount = 0;
    let sampleDuration = 0;
    if (stts) {
      const entryCount = readUint32(view, stts.contentStart + 4) || 0;
      let offset = stts.contentStart + 8;
      for (let index = 0; index < entryCount && offset + 8 <= stts.end; index += 1) {
        const count = readUint32(view, offset) || 0;
        const delta = readUint32(view, offset + 4) || 0;
        sampleCount += count;
        sampleDuration += count * delta;
        offset += 8;
      }
    }

    const tableSampleCount =
      (stsz ? readUint32(view, stsz.contentStart + 8) : 0) ||
      (stz2 ? readUint32(view, stz2.contentStart + 8) : 0) ||
      0;
    if (!sampleCount && tableSampleCount) sampleCount = tableSampleCount;

    const timescale = mediaTiming?.timescale || movieTiming?.timescale || 0;
    const durationTicks = mediaTiming?.duration || sampleDuration || movieTiming?.duration || 0;
    const duration = timescale && durationTicks ? durationTicks / timescale : null;
    const fpsFromTiming = timescale && sampleCount && sampleDuration
      ? (sampleCount * timescale) / sampleDuration
      : null;
    const fpsFromCount = sampleCount && duration ? sampleCount / duration : null;
    const fps = normalizeFpsValue(fpsFromTiming, fpsFromCount);

    let width = null;
    let height = null;
    if (tkhd && tkhd.end >= 8) {
      width = readUint32(view, tkhd.end - 8);
      height = readUint32(view, tkhd.end - 4);
      width = width === null ? null : width / 65536;
      height = height === null ? null : height / 65536;
    }

    let codec = "";
    if (stsd && stsd.contentStart + 16 <= stsd.end) {
      codec = readType(moovBytes, stsd.contentStart + 12);
    }

    return {
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      fps,
      codec,
    };
  }

  return null;
}

async function getMoovBytes(mediaUrl, referer, knownSize) {
  const firstEnd = INITIAL_PROBE_BYTES - 1;
  const first = await fetchRange(
    mediaUrl,
    referer,
    0,
    firstEnd,
    INITIAL_PROBE_BYTES,
  );
  const totalSize = knownSize || first.totalSize;
  let candidate = findMoovCandidate(first.bytes, 0);

  if (candidate?.complete) {
    return {
      moovBytes: first.bytes.slice(candidate.relativeStart, candidate.relativeStart + candidate.size),
      totalSize,
    };
  }

  if (candidate && totalSize && candidate.absoluteStart + candidate.size <= totalSize) {
    const exact = await fetchRange(
      mediaUrl,
      referer,
      candidate.absoluteStart,
      candidate.absoluteStart + candidate.size - 1,
      candidate.size,
    );
    return { moovBytes: exact.bytes, totalSize: totalSize || exact.totalSize };
  }

  if (!totalSize || totalSize <= INITIAL_PROBE_BYTES) {
    return { moovBytes: null, totalSize };
  }

  const endStart = Math.max(0, totalSize - END_PROBE_BYTES);
  const endChunk = await fetchRange(
    mediaUrl,
    referer,
    endStart,
    totalSize - 1,
    Math.min(END_PROBE_BYTES, totalSize),
  );
  candidate = findMoovCandidate(endChunk.bytes, endStart);

  if (!candidate) return { moovBytes: null, totalSize };

  if (candidate.complete) {
    return {
      moovBytes: endChunk.bytes.slice(candidate.relativeStart, candidate.relativeStart + candidate.size),
      totalSize,
    };
  }

  if (candidate.absoluteStart + candidate.size > totalSize) {
    return { moovBytes: null, totalSize };
  }

  const exact = await fetchRange(
    mediaUrl,
    referer,
    candidate.absoluteStart,
    candidate.absoluteStart + candidate.size - 1,
    candidate.size,
  );
  return { moovBytes: exact.bytes, totalSize: totalSize || exact.totalSize };
}

async function probeMp4(mediaUrl, referer, knownSize) {
  if (!mediaUrl) return { metadata: null, fileSize: knownSize || null };

  try {
    const { moovBytes, totalSize } = await getMoovBytes(mediaUrl, referer, knownSize);
    return {
      metadata: moovBytes ? parseMp4Moov(moovBytes) : null,
      fileSize: totalSize || knownSize || null,
    };
  } catch {
    return { metadata: null, fileSize: knownSize || null };
  }
}

function normalizeBitrate(value) {
  const bitrate = Number(value);
  if (!Number.isFinite(bitrate) || bitrate <= 0) return null;
  // TikTok JSON normally uses bits/second. Very small values are generally kbps.
  return bitrate < 10000 ? bitrate * 1000 : bitrate;
}

function readRequestBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const session = getSession(req);
    if (!session?.userId) {
      return res.status(401).json({
        ok: false,
        error: "Please log in with Telegram first.",
        code: "TELEGRAM_LOGIN_REQUIRED",
      });
    }

    const body = readRequestBody(req);
    const requestedUrl = normalizeTikTokUrl(body.url);

    if (pythonTikTokCheckerEnabled()) {
      const oEmbedPromise = getOEmbed(requestedUrl);
      try {
        const report = await runPythonTikTokChecker(requestedUrl);
        const oEmbed = await oEmbedPromise;
        const bitrate = Number(report.video_bitrate_kbps) > 0
          ? Math.round(Number(report.video_bitrate_kbps) * 1000)
          : null;
        const fileSize = Number(report.file_size_mb) > 0
          ? Math.round(Number(report.file_size_mb) * 1024 * 1024)
          : null;
        const duration = Number(report.duration_seconds) > 0
          ? Number(report.duration_seconds)
          : null;
        const fps = Number(report.fps) > 0 ? Number(report.fps) : null;
        const width = Number(report.width) > 0 ? Number(report.width) : null;
        const height = Number(report.height) > 0 ? Number(report.height) : null;

        return res.status(200).json({
          ok: true,
          engine: "python",
          video: {
            id: oEmbed?.videoId || null,
            url: requestedUrl,
            title: oEmbed?.title || report.file_name || "TikTok video",
            author: oEmbed?.author || null,
            authorUrl: oEmbed?.authorUrl || null,
            thumbnail: oEmbed?.thumbnail || null,
            resolution: { width, height },
            resolutionLabel: report.resolution_label || null,
            bitrate,
            overallBitrate: Number(report.overall_bitrate_kbps) > 0
              ? Math.round(Number(report.overall_bitrate_kbps) * 1000)
              : null,
            fps,
            fpsSource: fps ? "ffprobe" : null,
            fpsExact: Boolean(fps),
            duration,
            fileSize,
            codec: report.video_codec || null,
            audioCodec: report.audio_codec || null,
            pixelFormat: report.pixel_format || null,
            qualityScore: report.quality_score || null,
          },
          availability: {
            resolution: Boolean(width && height),
            bitrate: Boolean(bitrate),
            fps: Boolean(fps),
            duration: Boolean(duration),
            fileSize: Boolean(fileSize),
            codec: Boolean(report.video_codec),
            audioCodec: Boolean(report.audio_codec),
            pixelFormat: Boolean(report.pixel_format),
            qualityScore: Boolean(report.quality_score),
          },
          note: "Video was downloaded temporarily and analyzed with yt-dlp + ffprobe. Temporary files are removed automatically.",
        });
      } catch (pythonError) {
        const strict = String(process.env.TIKTOK_CHECKER_PYTHON_STRICT || "false").toLowerCase() === "true";
        console.warn("Python TikTok checker failed; using built-in web checker fallback:", {
          message: pythonError?.message,
          code: pythonError?.code,
        });
        if (strict) throw pythonError;
      }
    }

    const oEmbedPromise = getOEmbed(requestedUrl);

    let finalUrl = requestedUrl;
    let pageData = null;
    let pageFailure = null;

    try {
      const page = await fetchTikTokPage(requestedUrl);
      finalUrl = page.finalUrl;
      pageData = extractTikTokDataFromHtml(page.html, finalUrl);
    } catch (error) {
      pageFailure = error;
    }

    const oEmbed = await oEmbedPromise;

    // The normal public page can return an anti-bot challenge to a serverless
    // function. TikTok's official player page is a useful second source.
    if (!pageData && oEmbed?.videoId) {
      try {
        const playerUrl = `https://www.tiktok.com/player/v1/${oEmbed.videoId}?music_info=1&description=1`;
        const playerPage = await fetchTikTokPage(playerUrl);
        pageData = extractTikTokDataFromHtml(playerPage.html, finalUrl);
      } catch (error) {
        pageFailure = pageFailure || error;
      }
    }

    if (!pageData) {
      if (!oEmbed) throw pageFailure || Object.assign(
        new Error("TikTok did not return information for this video."),
        { code: "TIKTOK_METADATA_NOT_FOUND" },
      );

      pageData = {
        videoId: oEmbed.videoId || finalUrl.match(/\/video\/(\d+)/)?.[1] || "",
        title: oEmbed.title || "TikTok video",
        author: oEmbed.author || "",
        width: null,
        height: null,
        duration: null,
        fps: null,
        fpsSource: null,
        frameCount: null,
        bitrate: null,
        fileSize: null,
        codec: "",
        mediaUrl: "",
        thumbnail: oEmbed.thumbnail || "",
      };
    }

    let fileSize = pageData.fileSize;
    const probe = await probeMp4(pageData.mediaUrl, finalUrl, fileSize);
    fileSize = probe.fileSize || fileSize;
    if (!fileSize && pageData.mediaUrl) {
      fileSize = await getMediaSize(pageData.mediaUrl, finalUrl);
    }

    const duration = probe.metadata?.duration || pageData.duration;
    const bitrate =
      normalizeBitrate(pageData.bitrate) ||
      (fileSize && duration ? (fileSize * 8) / duration : null);

    const fpsFromFrameCount = pageData.frameCount && duration
      ? Number(pageData.frameCount) / Number(duration)
      : null;
    const detectedFps = normalizeFpsValue(
      probe.metadata?.fps,
      pageData.fps,
      fpsFromFrameCount,
    );

    // Fallback requested by the product owner: estimate FPS from bitrate only
    // when TikTok does not expose an actual frame rate. This is deliberately
    // labelled as an estimate because bitrate alone cannot prove real FPS.
    const estimatedFpsFromBitrate = !detectedFps && bitrate
      ? (bitrate < 2_000_000 ? 30 : bitrate >= 16_000_000 ? 600 : 60)
      : null;

    const fps = detectedFps || estimatedFpsFromBitrate;
    const fpsSource = detectedFps
      ? (probe.metadata?.fps ? "mp4" : pageData.fpsSource || "tiktok_metadata")
      : estimatedFpsFromBitrate
        ? "bitrate_estimate"
        : null;

    const fpsNote = detectedFps
      ? "FPS was read from the TikTok video stream or TikTok's technical metadata. Captions and hashtags are never used."
      : estimatedFpsFromBitrate
        ? "TikTok did not expose real FPS metadata, so FPS was estimated from bitrate: under 2 Mbps = 30 FPS, 2 to under 16 Mbps = 60 FPS, and 16 Mbps or higher = 600 FPS."
        : "TikTok did not expose verifiable FPS or bitrate metadata for this video.";

    return res.status(200).json({
      ok: true,
      video: {
        id: pageData.videoId || null,
        url: finalUrl,
        title: pageData.title || oEmbed?.title || "TikTok video",
        author: pageData.author || oEmbed?.author || null,
        authorUrl: oEmbed?.authorUrl || null,
        thumbnail: pageData.thumbnail || oEmbed?.thumbnail || null,
        resolution: {
          width: probe.metadata?.width || pageData.width || null,
          height: probe.metadata?.height || pageData.height || null,
        },
        bitrate: bitrate ? Math.round(bitrate) : null,
        fps: fps || null,
        fpsSource,
        fpsExact: Boolean(detectedFps),
        duration: duration || null,
        fileSize: fileSize ? Math.round(fileSize) : null,
        codec: probe.metadata?.codec || pageData.codec || null,
      },
      availability: {
        resolution: Boolean(probe.metadata?.width || pageData.width),
        bitrate: Boolean(bitrate),
        fps: Boolean(fps),
        duration: Boolean(duration),
        fileSize: Boolean(fileSize),
      },
      note: fpsNote,
    });
  } catch (error) {
    console.error("TikTok video check failed:", {
      message: error?.message,
      code: error?.code,
      status: error?.status,
    });

    const status =
      error?.code === "MISSING_TIKTOK_URL" ||
      error?.code === "INVALID_TIKTOK_URL" ||
      error?.code === "UNSUPPORTED_TIKTOK_HOST"
        ? 400
        : error?.code === "TIKTOK_METADATA_NOT_FOUND" ||
            error?.code === "TIKTOK_PAGE_UNAVAILABLE"
          ? 422
          : 502;

    return res.status(status).json({
      ok: false,
      error: error?.message || "Unable to check this TikTok video right now.",
      code: error?.code || "TIKTOK_CHECK_FAILED",
    });
  }
}
