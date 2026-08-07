import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function readPositiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function pythonTikTokCheckerEnabled() {
  return String(process.env.TIKTOK_CHECKER_ENGINE || "")
    .trim()
    .toLowerCase() === "python";
}

export async function runPythonTikTokChecker(url) {
  const python = process.env.TIKTOK_CHECKER_PYTHON_BIN?.trim() || "python3";
  const script = path.join(process.cwd(), "server", "python", "tiktok_checker_bridge.py");
  const timeout = readPositiveInt("TIKTOK_CHECKER_TIMEOUT_MS", 420000);
  const maxBuffer = readPositiveInt("TIKTOK_CHECKER_MAX_BUFFER", 2 * 1024 * 1024);

  try {
    const { stdout, stderr } = await execFileAsync(python, [script, url], {
      timeout,
      maxBuffer,
      env: process.env,
    });

    let payload;
    try {
      payload = JSON.parse(String(stdout || "{}").trim());
    } catch {
      const error = new Error("The Python TikTok checker returned invalid JSON.");
      error.code = "PYTHON_CHECKER_BAD_JSON";
      error.detail = String(stderr || "").slice(-1600);
      throw error;
    }

    if (!payload?.ok || !payload?.report) {
      const error = new Error(payload?.error || "Python TikTok checker failed.");
      error.code = payload?.code || "PYTHON_CHECKER_FAILED";
      error.detail = String(stderr || "").slice(-1600);
      throw error;
    }

    return payload.report;
  } catch (cause) {
    if (cause?.killed || cause?.signal === "SIGTERM") {
      const error = new Error("TikTok checker timed out while downloading or analyzing the video.");
      error.code = "PYTHON_CHECKER_TIMEOUT";
      throw error;
    }

    if (cause?.code === "ENOENT") {
      const error = new Error(
        "Python TikTok checker is enabled, but python3/yt-dlp/ffprobe is not installed on this server.",
      );
      error.code = "PYTHON_CHECKER_RUNTIME_MISSING";
      throw error;
    }

    throw cause;
  }
}
