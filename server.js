const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8765);
const downloadsDirectory = process.env.DOWNLOADS_DIR
    || path.join(__dirname, "downloads");
const qualitiesTimeoutMs = Number(process.env.QUALITIES_TIMEOUT_MS || 60_000);
const bundledToolsDirectory = path.join(__dirname, "tools");
const jobs = new Map();
const cookieFilePath = prepareCookieFile();
const tools = resolveTools();

fs.mkdirSync(downloadsDirectory, { recursive: true });

const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, `http://${request.headers.host}`);

        if (request.method === "OPTIONS") {
            return sendEmpty(response, 204);
        }

        if (request.method === "GET" && url.pathname === "/health") {
            return sendJSON(response, 200, {
                ok: true,
                ytDLP: tools.ytDLP,
                ffmpeg: tools.ffmpeg,
                ffprobe: tools.ffprobe,
                port
            });
        }

        if (request.method === "POST" && url.pathname === "/qualities") {
            const body = await readJSON(request);
            return handleQualities(body, response);
        }

        if (request.method === "POST" && url.pathname === "/downloads") {
            const body = await readJSON(request);
            return handleCreateDownload(body, request, response);
        }

        if (request.method === "GET" && url.pathname.startsWith("/downloads/")) {
            const id = decodeURIComponent(url.pathname.split("/").pop());
            return handleStatus(id, response);
        }

        if (request.method === "GET" && url.pathname.startsWith("/files/")) {
            const fileName = decodeURIComponent(url.pathname.replace("/files/", ""));
            return handleFile(fileName, response);
        }

        sendJSON(response, 404, { error: "Not found" });
    } catch (error) {
        sendJSON(response, 500, { error: error.message || "Internal server error" });
    }
});

server.listen(port, host, () => {
    console.log(`Social Video Downloader API running at http://${host}:${port}`);
    console.log(`yt-dlp: ${tools.ytDLP}`);
    console.log(`ffmpeg: ${tools.ffmpeg}`);
    console.log(`ffprobe: ${tools.ffprobe}`);
});

async function handleQualities(body, response) {
    try {
        const sourceURL = validateSourceURL(sourceURLFromBody(body));
        const formats = await runCommand(
            tools.ytDLP,
            [
                "--no-warnings",
                ...ytDLPCookieArgs(),
                "-F",
                "--no-playlist",
                sourceURL
            ],
            { timeoutMs: qualitiesTimeoutMs }
        );
        const qualities = buildQualitiesFromFormatList(formats.stdout);

        sendJSON(response, 200, {
            qualities: qualities.length > 0 ? qualities : [{ id: "best", title: "Melhor qualidade" }]
        });
    } catch (error) {
        sendJSON(response, 500, {
            error: error.message || "Nao foi possivel carregar as qualidades."
        });
    }
}

function handleCreateDownload(body, request, response) {
    const sourceURL = validateSourceURL(sourceURLFromBody(body));
    const type = body.type === "audio" ? "audio" : "video";
    const qualityId = typeof body.qualityId === "string" && body.qualityId.length > 0
        ? body.qualityId
        : "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[ext=mp4]/best";
    const id = randomUUID();
    const outputTemplate = path.join(downloadsDirectory, `${id}-%(title).180B.%(ext)s`);

    const job = {
        id,
        state: "queued",
        percent: 0,
        message: "Na fila...",
        title: null,
        fileName: null,
        fileURL: null
    };
    jobs.set(id, job);

    const args = [
        "--no-playlist",
        "--newline",
        "--restrict-filenames",
        ...ytDLPCookieArgs(),
        "--ffmpeg-location",
        path.dirname(tools.ffmpeg),
        "-o",
        outputTemplate
    ];

    if (type === "audio") {
        args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    } else {
        args.push(
            "-f",
            qualityId,
            "--merge-output-format",
            "mp4"
        );
    }

    args.push(sourceURL);

    job.state = "downloading";
    job.message = "Baixando...";

    const process = spawn(tools.ytDLP, args, {
        cwd: downloadsDirectory,
        env: processEnvironment()
    });
    let output = "";

    process.stdout.on("data", chunk => {
        const text = chunk.toString();
        output += text;
        updateProgress(job, text);
    });

    process.stderr.on("data", chunk => {
        const text = chunk.toString();
        output += text;
        updateProgress(job, text);
    });

    process.on("close", code => {
        const filePath = findDownloadedFile(id);
        if (filePath) {
            if (type === "video") {
                convertVideoForCompatibility(filePath, job, request);
            } else {
                completeJobWithFile(job, filePath, request);
            }
            return;
        }

        if (code !== 0) {
            job.state = "failed";
            job.percent = 100;
            job.message = lastUsefulLine(output) || `yt-dlp saiu com codigo ${code}.`;
            return;
        }

        job.state = "failed";
        job.percent = 100;
        job.message = "Arquivo final nao encontrado.";
    });

    sendJSON(response, 200, { id });
}

function completeJobWithFile(job, filePath, request) {
    const fileName = path.basename(filePath);
    job.state = "completed";
    job.percent = 100;
    job.message = "Download concluido.";
    job.fileName = fileName;
    job.title = readableTitle(fileName, job.id);
    job.fileURL = absoluteURL(request, `/files/${encodeURIComponent(fileName)}`);
}

function convertVideoForCompatibility(inputFile, job, request) {
    const parsed = path.parse(inputFile);
    const outputFile = path.join(parsed.dir, `${parsed.name}-compatible.mp4`);
    const duration = mediaDuration(inputFile);

    job.state = "converting";
    job.percent = 0;
    job.message = "Convertendo video para maior compatibilidade, aguarde!";

    const args = [
        "-y",
        "-i", inputFile,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        outputFile
    ];

    const ffmpeg = spawn(tools.ffmpeg, args, {
        cwd: downloadsDirectory,
        env: processEnvironment()
    });

    let output = "";
    ffmpeg.stdout.on("data", chunk => {
        const text = chunk.toString();
        output += text;
        updateConversionProgress(job, text, duration);
    });
    ffmpeg.stderr.on("data", chunk => {
        output += chunk.toString();
    });
    ffmpeg.on("close", code => {
        if (code === 0 && fs.existsSync(outputFile)) {
            tryRemove(inputFile);
            completeJobWithFile(job, outputFile, request);
            return;
        }

        if (fs.existsSync(inputFile)) {
            job.message = "Nao foi possivel converter. Enviando o MP4 original.";
            completeJobWithFile(job, inputFile, request);
            return;
        }

        job.state = "failed";
        job.percent = 100;
        job.message = lastUsefulLine(output) || `ffmpeg saiu com codigo ${code}.`;
    });
}

function handleStatus(id, response) {
    const job = jobs.get(id);
    if (!job) {
        return sendJSON(response, 404, { error: "Download not found" });
    }

    sendJSON(response, 200, {
        state: job.state,
        percent: job.percent,
        message: job.message,
        fileURL: job.fileURL,
        fileName: job.fileName,
        title: job.title
    });
}

function handleFile(fileName, response) {
    const safeName = path.basename(fileName);
    const filePath = path.join(downloadsDirectory, safeName);

    if (!fs.existsSync(filePath)) {
        return sendJSON(response, 404, { error: "File not found" });
    }

    response.writeHead(200, {
        ...commonHeaders(contentTypeFor(filePath)),
        "Content-Disposition": `attachment; filename="${safeName.replaceAll("\"", "")}"`
    });

    const stream = fs.createReadStream(filePath);
    response.on("finish", () => {
        tryRemove(filePath);
        removeCompletedJobForFile(safeName);
    });
    stream.pipe(response);
}

function buildQualitiesFromFormatList(output) {
    const heights = new Set();

    for (const line of output.split(/\r?\n/)) {
        if (!line.includes("video")) continue;

        const heightMatch = line.match(/(\d{3,4})p/);
        if (!heightMatch) continue;

        const height = Number(heightMatch[1]);
        if (Number.isFinite(height) && height > 0) {
            heights.add(height);
        }
    }

    return Array.from(heights)
        .sort((a, b) => b - a)
        .slice(0, 8)
        .map(height => ({
            id: videoFormatSelector(height),
            title: `${height}p`
        }));
}

function videoFormatSelector(height) {
    return [
        `bestvideo[height<=${height}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
        `best[height<=${height}][ext=mp4]`,
        `bestvideo[height<=${height}]+bestaudio`,
        `best[height<=${height}]`,
        "best"
    ].join("/");
}

function updateProgress(job, text) {
    const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
        job.percent = Math.max(job.percent, Number(match[1]));
        job.message = `Baixando... ${job.percent.toFixed(1)}%`;
    }
}

function findDownloadedFile(id) {
    const files = fs.readdirSync(downloadsDirectory)
        .filter(file => file.startsWith(`${id}-`) && !file.endsWith(".part") && !file.endsWith(".ytdl"))
        .map(file => path.join(downloadsDirectory, file))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    return files[0] || null;
}

function readableTitle(fileName, id) {
    return path.basename(fileName, path.extname(fileName)).replace(`${id}-`, "").replaceAll("_", " ");
}

function tryRemove(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch {
        // Keep the original file if cleanup fails.
    }
}

function removeCompletedJobForFile(fileName) {
    for (const [id, job] of jobs.entries()) {
        if (job.fileName === fileName) {
            jobs.delete(id);
        }
    }
}

function validateSourceURL(value) {
    if (typeof value !== "string") {
        throw new Error("URL invalida.");
    }

    const parsed = new URL(value);
    const hostName = parsed.hostname.toLowerCase();
    const valid = isHost(hostName, "youtube.com")
        || isHost(hostName, "youtu.be")
        || isHost(hostName, "instagram.com")
        || isHost(hostName, "x.com")
        || isHost(hostName, "twitter.com");

    if (!valid) {
        throw new Error("Somente links do YouTube, Instagram e X/Twitter sao aceitos.");
    }

    return parsed.toString();
}

function sourceURLFromBody(body) {
    return body.url || body.link;
}

function prepareCookieFile() {
    const explicitPath = process.env.YTDLP_COOKIES_FILE || process.env.YTDLP_COOKIES_PATH;
    if (explicitPath) {
        return explicitPath;
    }

    const encodedCookies = process.env.YTDLP_COOKIES_BASE64;
    const plainCookies = process.env.YTDLP_COOKIES;
    if (!encodedCookies && !plainCookies) {
        return null;
    }

    const content = encodedCookies
        ? Buffer.from(encodedCookies, "base64").toString("utf8")
        : plainCookies;
    const outputPath = path.join(process.env.RUNNER_TEMP || "/tmp", "yt-dlp-cookies.txt");
    fs.writeFileSync(outputPath, content, { mode: 0o600 });
    return outputPath;
}

function ytDLPCookieArgs() {
    return cookieFilePath ? ["--cookies", cookieFilePath] : [];
}

function resolveTools() {
    const ffmpeg = resolveTool("FFMPEG_PATH", "ffmpeg");
    return {
        ytDLP: resolveTool("YTDLP_PATH", "yt-dlp"),
        ffmpeg,
        ffprobe: resolveTool("FFPROBE_PATH", "ffprobe", path.dirname(ffmpeg))
    };
}

function resolveTool(environmentName, fileName, preferredDirectory) {
    const candidates = [
        process.env[environmentName],
        preferredDirectory ? path.join(preferredDirectory, fileName) : null,
        path.join(bundledToolsDirectory, fileName),
        path.join("/opt/homebrew/bin", fileName),
        path.join("/usr/local/bin", fileName),
        fileName
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate === fileName || fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return fileName;
}

function mediaDuration(filePath) {
    const result = spawnSync(tools.ffprobe, [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath
    ], {
        encoding: "utf8",
        env: processEnvironment()
    });

    const duration = Number((result.stdout || "").trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function updateConversionProgress(job, text, duration) {
    if (!duration) {
        job.message = "Convertendo video para maior compatibilidade, aguarde!";
        return;
    }

    const match = text.match(/out_time_ms=(\d+)/);
    if (!match) return;

    const seconds = Number(match[1]) / 1_000_000;
    if (!Number.isFinite(seconds)) return;

    const percent = Math.min(Math.max((seconds / duration) * 100, 0), 99.9);
    job.percent = percent;
    job.message = "Convertendo video para maior compatibilidade, aguarde!";
}

function processEnvironment() {
    const toolDirectories = [
        path.dirname(tools.ytDLP),
        path.dirname(tools.ffmpeg)
    ].filter(directory => directory && directory !== ".");

    return {
        ...process.env,
        PATH: [...toolDirectories, process.env.PATH || ""].join(path.delimiter)
    };
}

function isHost(hostName, domain) {
    return hostName === domain || hostName.endsWith(`.${domain}`);
}

function absoluteURL(request, pathname) {
    const protocol = request.headers["x-forwarded-proto"] || "http";
    return `${protocol}://${request.headers.host}${pathname}`;
}

function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".mp3") return "audio/mpeg";
    if (ext === ".m4a") return "audio/mp4";
    if (ext === ".webm") return "video/webm";
    if (ext === ".mov") return "video/quicktime";
    return "video/mp4";
}

function lastUsefulLine(value) {
    return value
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !line.includes("failed to destroy sync semaphore"))
        .slice(-1)[0];
}

function commonHeaders(contentType) {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": contentType
    };
}

function sendEmpty(response, statusCode) {
    response.writeHead(statusCode, commonHeaders("text/plain"));
    response.end();
}

function sendJSON(response, statusCode, payload) {
    response.writeHead(statusCode, commonHeaders("application/json"));
    response.end(JSON.stringify(payload));
}

function readJSON(request) {
    return new Promise((resolve, reject) => {
        let body = "";

        request.on("data", chunk => {
            body += chunk;
            if (body.length > 1_000_000) {
                request.destroy();
                reject(new Error("Request muito grande."));
            }
        });

        request.on("end", () => {
            try {
                resolve(body.length > 0 ? JSON.parse(body) : {});
            } catch (error) {
                reject(new Error("JSON invalido."));
            }
        });

        request.on("error", reject);
    });
}

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env: processEnvironment() });
        let stdout = "";
        let stderr = "";
        let didTimeout = false;
        const timeoutMs = options.timeoutMs || 0;
        const timeout = timeoutMs > 0
            ? setTimeout(() => {
                didTimeout = true;
                child.kill("SIGKILL");
            }, timeoutMs)
            : null;

        child.stdout.on("data", chunk => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", chunk => {
            stderr += chunk.toString();
        });

        child.on("error", error => {
            if (timeout) clearTimeout(timeout);
            reject(error);
        });
        child.on("close", code => {
            if (timeout) clearTimeout(timeout);
            if (didTimeout) {
                reject(new Error(`${command} excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s.`));
                return;
            }

            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(lastUsefulLine(stderr) || `${command} saiu com codigo ${code}.`));
            }
        });
    });
}
