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
const maxVideoHeight = Number(process.env.MAX_VIDEO_HEIGHT || 1080);
const bundledToolsDirectory = path.join(__dirname, "tools");
const jobsDirectory = path.join(downloadsDirectory, ".jobs");
const serverVersion = "2026-06-28-debug-formats";
const jobs = new Map();
const cookieFilePath = prepareCookieFile();
const tools = resolveTools();

fs.mkdirSync(downloadsDirectory, { recursive: true });
fs.mkdirSync(jobsDirectory, { recursive: true });

const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestURL = request.url || "/";
    response.on("finish", () => {
        console.log(`${request.method} ${requestURL} -> ${response.statusCode} ${Date.now() - startedAt}ms`);
    });

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
                cookiesConfigured: Boolean(cookieFilePath),
                version: serverVersion,
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

        if (request.method === "POST" && url.pathname === "/debug/formats") {
            const body = await readJSON(request);
            return handleDebugFormats(body, response);
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
        logError("request", error);
        sendJSON(response, 500, { error: error.message || "Internal server error" });
    }
});

server.listen(port, host, () => {
    console.log(`Social Video Downloader API running at http://${host}:${port}`);
    console.log(`yt-dlp: ${tools.ytDLP}`);
    console.log(`ffmpeg: ${tools.ffmpeg}`);
    console.log(`ffprobe: ${tools.ffprobe}`);
    console.log(`SERVER VERSION: ${serverVersion}`);
    console.log(`cookies configured: ${Boolean(cookieFilePath)}`);
});

async function handleQualities(body, response) {
    let sourceURL = "";

    try {
        sourceURL = validateSourceURL(sourceURLFromBody(body));
        console.log(`qualities: using automatic quality for ${safeURLForLog(sourceURL)}`);
        sendJSON(response, 200, {
            qualities: [{ id: "auto", title: "Melhor qualidade" }]
        });
    } catch (error) {
        logError(`qualities ${safeURLForLog(sourceURL)}`, error);
        sendJSON(response, 500, {
            error: error.message || "Nao foi possivel carregar as qualidades."
        });
    }
}

async function handleDebugFormats(body, response) {
    let sourceURL = "";

    try {
        sourceURL = validateSourceURL(sourceURLFromBody(body));
        const useCookies = shouldUseCookiesForRequest(body);
        const args = [
            "--ignore-config",
            "--no-playlist",
            ...ytDLPCookieArgs(useCookies),
            "-F",
            sourceURL
        ];

        console.log(`debug formats: ${safeURLForLog(sourceURL)}`);
        const result = await runCommand(tools.ytDLP, args, { timeoutMs: 30_000 });
        sendJSON(response, 200, {
            ok: true,
            command: tools.ytDLP,
            args,
            stdout: result.stdout,
            stderr: result.stderr
        });
    } catch (error) {
        logError(`debug formats ${safeURLForLog(sourceURL)}`, error);
        sendJSON(response, 500, {
            ok: false,
            error: error.message || "Nao foi possivel listar os formatos."
        });
    }
}

function handleCreateDownload(body, request, response) {
    const sourceURL = validateSourceURL(sourceURLFromBody(body));
    const type = body.type === "audio" ? "audio" : "video";
    const useCookies = shouldUseCookiesForRequest(body);
    const makeCompatible = body.makeCompatible === true;
    const qualitySelector = typeof body.qualityId === "string" && body.qualityId.length > 0
        ? normalizeQualitySelector(body.qualityId)
        : null;
    const id = randomUUID();
    const outputTemplate = path.join(downloadsDirectory, `${id}-%(title).180B.%(ext)s`);
    console.log(`download ${id}: ${type} ${safeURLForLog(sourceURL)} quality=${qualitySelector || "auto"}`);

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
    persistJob(job);

    const baseArgs = [
        "--ignore-config",
        "--no-playlist",
        "--newline",
        "--restrict-filenames",
        ...ytDLPCookieArgs(useCookies),
        "--ffmpeg-location",
        path.dirname(tools.ffmpeg),
        "-o",
        outputTemplate
    ];

    const attempts = [];
    if (type === "audio") {
        attempts.push(["-x", "--audio-format", "mp3", "--audio-quality", "0"]);
        attempts.push([
            "--extractor-args", "youtube:player_client=android",
            "-x", "--audio-format", "mp3", "--audio-quality", "0"
        ]);
    } else {
        if (qualitySelector) {
            attempts.push(["-f", qualitySelector, "--merge-output-format", "mp4"]);
        } else {
            attempts.push(["--extractor-args", "youtube:player_client=android"]);
            attempts.push(["--extractor-args", "youtube:player_client=android", "-S", `res:${maxVideoHeight}`]);
            attempts.push(["-f", "bestvideo+bestaudio/best"]);
            attempts.push([]);
        }
        attempts.push(["-f", videoFormatSelector(1080), "--merge-output-format", "mp4"]);
        attempts.push(["-f", videoFormatSelector(720), "--merge-output-format", "mp4"]);
        attempts.push(["-f", nativeVideoFormatSelector(1080), "--merge-output-format", "mp4"]);
        attempts.push(["-f", nativeVideoFormatSelector(720), "--merge-output-format", "mp4"]);
        attempts.push(["-f", nativeVideoFormatSelector(1080)]);
        attempts.push(["-f", nativeVideoFormatSelector(720)]);
        attempts.push(["--extractor-args", "youtube:player_client=android"]);
        attempts.push(["--extractor-args", "youtube:player_client=android", "-S", `res:${maxVideoHeight}`]);
        attempts.push(["--extractor-args", "youtube:player_client=android", "-f", videoFormatSelector(1080), "--merge-output-format", "mp4"]);
        attempts.push(["--extractor-args", "youtube:player_client=android", "-f", videoFormatSelector(720), "--merge-output-format", "mp4"]);
        attempts.push(["--extractor-args", "youtube:player_client=android", "-f", nativeVideoFormatSelector(1080), "--merge-output-format", "mp4"]);
        attempts.push(["--extractor-args", "youtube:player_client=android", "-f", nativeVideoFormatSelector(720), "--merge-output-format", "mp4"]);
        attempts.push(["--extractor-args", "youtube:player_client=android", "-f", nativeVideoFormatSelector(1080)]);
        attempts.push(["--extractor-args", "youtube:player_client=android", "-f", nativeVideoFormatSelector(720)]);
        attempts.push(["--extractor-args", "youtube:player_client=web_creator"]);
        attempts.push(["--extractor-args", "youtube:player_client=web_creator", "-S", `res:${maxVideoHeight}`]);
        attempts.push(["--extractor-args", "youtube:player_client=web_creator", "-f", videoFormatSelector(1080), "--merge-output-format", "mp4"]);
        attempts.push(["--extractor-args", "youtube:player_client=web_creator", "-f", videoFormatSelector(720), "--merge-output-format", "mp4"]);
        attempts.push(["--extractor-args", "youtube:player_client=web_creator", "-f", nativeVideoFormatSelector(1080), "--merge-output-format", "mp4"]);
        attempts.push(["--extractor-args", "youtube:player_client=web_creator", "-f", nativeVideoFormatSelector(720), "--merge-output-format", "mp4"]);
        attempts.push(["--extractor-args", "youtube:player_client=web_creator", "-f", nativeVideoFormatSelector(1080)]);
        attempts.push(["--extractor-args", "youtube:player_client=web_creator", "-f", nativeVideoFormatSelector(720)]);
    }

    job.state = "downloading";
    job.message = "Baixando...";
    persistJob(job);

    startDownloadAttempt({
        id,
        attemptIndex: 0,
        attempts,
        baseArgs,
        sourceURL,
        type,
        makeCompatible,
        job,
        request
    });

    sendJSON(response, 200, { id });
}

function startDownloadAttempt({ id, attemptIndex, attempts, baseArgs, sourceURL, type, makeCompatible, job, request }) {
    const attemptArgs = attempts[Math.min(attemptIndex, attempts.length - 1)] || [];
    const args = [...baseArgs, ...attemptArgs, sourceURL];
    console.log(`download ${id}: yt-dlp attempt ${attemptIndex + 1}/${attempts.length}`);

    if (attemptIndex > 0) {
        job.message = attemptArgs.includes("--extractor-args")
            ? `Tentando client alternativo ${attemptIndex + 1}...`
            : `Tentando formato alternativo ${attemptIndex + 1}...`;
        persistJob(job);
    }

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
            console.log(`download ${id}: yt-dlp completed with file ${path.basename(filePath)}`);
            if (type === "video" && makeCompatible) {
                convertVideoForCompatibility(filePath, job, request);
            } else {
                completeJobWithFile(job, filePath, request);
            }
            return;
        }

        if (code !== 0 && shouldRetryFormat(output) && attemptIndex + 1 < attempts.length) {
            console.warn(`download ${id}: retrying after format failure\n${tailForLog(output)}`);
            startDownloadAttempt({ id, attemptIndex: attemptIndex + 1, attempts, baseArgs, sourceURL, type, makeCompatible, job, request });
            return;
        }

        if (code !== 0) {
            job.state = "failed";
            job.percent = 100;
            job.message = lastUsefulLine(output) || `yt-dlp saiu com codigo ${code}.`;
            persistJob(job);
            console.error(`download ${id}: yt-dlp failed with code ${code}\n${tailForLog(output)}`);
            return;
        }

        job.state = "failed";
        job.percent = 100;
        job.message = "Arquivo final nao encontrado.";
        persistJob(job);
        console.error(`download ${id}: final file not found\n${tailForLog(output)}`);
    });
}

function completeJobWithFile(job, filePath, request) {
    const fileName = path.basename(filePath);
    console.log(`download ${job.id}: completed ${fileName}`);
    job.state = "completed";
    job.percent = 100;
    job.message = "Download concluido.";
    job.fileName = fileName;
    job.title = readableTitle(fileName, job.id);
    job.fileURL = absoluteURL(request, `/files/${encodeURIComponent(fileName)}`);
    persistJob(job);
}

function convertVideoForCompatibility(inputFile, job, request) {
    const parsed = path.parse(inputFile);
    const outputFile = path.join(parsed.dir, `${parsed.name}-compatible.mp4`);
    const duration = mediaDuration(inputFile);
    console.log(`download ${job.id}: converting ${path.basename(inputFile)}`);

    job.state = "converting";
    job.percent = 0;
    job.message = "Convertendo video para maior compatibilidade, aguarde!";
    persistJob(job);

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
            persistJob(job);
            console.error(`download ${job.id}: ffmpeg failed with code ${code}, sending original\n${tailForLog(output)}`);
            completeJobWithFile(job, inputFile, request);
            return;
        }

        job.state = "failed";
        job.percent = 100;
        job.message = lastUsefulLine(output) || `ffmpeg saiu com codigo ${code}.`;
        persistJob(job);
        console.error(`download ${job.id}: ffmpeg failed with code ${code}\n${tailForLog(output)}`);
    });
}

function handleStatus(id, response) {
    const job = jobs.get(id) || loadJob(id);
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

function buildQualitiesFromMetadata(output) {
    const metadata = JSON.parse(jsonPayload(output));
    const formats = collectFormats(metadata)
        .filter(format => format && format.format_id);
    const audioFormat = bestAudioFormat(formats);
    const formatsByHeight = new Map();

    for (const format of formats) {
        const height = Number(format.height || 0);
        if (!Number.isFinite(height) || height <= 0 || height > maxVideoHeight) continue;
        if (format.vcodec === "none") continue;
        if (!format.url && !format.manifest_url) continue;

        const existing = formatsByHeight.get(height);
        if (!existing || formatScore(format) > formatScore(existing)) {
            formatsByHeight.set(height, format);
        }
    }

    return Array.from(formatsByHeight.entries())
        .sort((a, b) => b[0] - a[0])
        .slice(0, 8)
        .map(([height, format]) => ({
            id: formatSelectorFor(format, audioFormat),
            title: `${height}p`
        }));
}

function jsonPayload(output) {
    const trimmed = output.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end >= start) {
        return trimmed.slice(start, end + 1);
    }

    return trimmed;
}

function collectFormats(metadata) {
    const formats = Array.isArray(metadata.formats) ? [...metadata.formats] : [];
    if (Array.isArray(metadata.entries)) {
        for (const entry of metadata.entries) {
            if (Array.isArray(entry.formats)) {
                formats.push(...entry.formats);
            }
        }
    }

    return formats;
}

function bestAudioFormat(formats) {
    return formats
        .filter(format => format.acodec && format.acodec !== "none" && format.vcodec === "none")
        .sort((a, b) => formatScore(b) - formatScore(a))[0] || null;
}

function formatSelectorFor(videoFormat, audioFormat) {
    if (videoFormat.acodec && videoFormat.acodec !== "none") {
        return videoFormat.format_id;
    }

    return audioFormat
        ? `${videoFormat.format_id}+${audioFormat.format_id}`
        : videoFormat.format_id;
}

function formatScore(format) {
    let score = Number(format.tbr || format.vbr || format.abr || 0);
    if (format.ext === "mp4" || format.ext === "m4a") score += 10_000;
    if (typeof format.vcodec === "string" && format.vcodec.startsWith("avc1")) score += 5_000;
    if (format.protocol === "https") score += 1_000;
    return score;
}

function videoFormatSelector(height) {
    const cappedHeight = Math.min(height, maxVideoHeight);
    return [
        `bestvideo[height<=${cappedHeight}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${cappedHeight}][ext=mp4]+bestaudio[ext=m4a]`,
        `best[height<=${cappedHeight}][ext=mp4]`,
        `bestvideo[height<=${cappedHeight}]+bestaudio`,
        `best[height<=${cappedHeight}]`,
        "best"
    ].join("/");
}

function nativeVideoFormatSelector(height) {
    const cappedHeight = Math.min(height, maxVideoHeight);
    return [
        `bestvideo[height<=${cappedHeight}]+bestaudio`,
        `best[height<=${cappedHeight}]`,
        "bestvideo+bestaudio",
        "best"
    ].join("/");
}

function clampQualitySelector(selector) {
    return selector.replace(/height<=\d+/g, `height<=${maxVideoHeight}`);
}

function normalizeQualitySelector(selector) {
    const trimmedSelector = selector.trim();
    if (!trimmedSelector || trimmedSelector === "best" || trimmedSelector === "auto") {
        return null;
    }

    return clampQualitySelector(trimmedSelector);
}

function shouldRetryFormat(output) {
    const lowercased = output.toLowerCase();
    return lowercased.includes("requested format is not available")
        || lowercased.includes("requested format not available")
        || lowercased.includes("no video formats found");
}

function updateProgress(job, text) {
    const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
        job.percent = Math.max(job.percent, Number(match[1]));
        job.message = `Baixando... ${job.percent.toFixed(1)}%`;
        persistJob(job);
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
            tryRemove(jobFilePath(id));
        }
    }
}

function safeURLForLog(value) {
    if (!value) return "<empty>";

    try {
        const url = new URL(value);
        url.search = url.search ? "?..." : "";
        return url.toString();
    } catch {
        return "<invalid>";
    }
}

function logError(context, error) {
    console.error(`${context}: ${error && error.stack ? error.stack : error}`);
}

function tailForLog(value, maxLines = 25) {
    return value
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(-maxLines)
        .join("\n");
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
        return writableCookieFileFrom(explicitPath) || explicitPath;
    }

    const secretFileCandidates = [
        "/etc/secrets/youtube-cookies.txt",
        "/etc/secrets/yt-dlp-cookies.txt",
        "/etc/secrets/cookies.txt"
    ];
    for (const candidate of secretFileCandidates) {
        if (fs.existsSync(candidate)) {
            return writableCookieFileFrom(candidate);
        }
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

function writableCookieFileFrom(sourcePath) {
    try {
        const content = fs.readFileSync(sourcePath);
        const outputPath = path.join(process.env.RUNNER_TEMP || "/tmp", "yt-dlp-cookies.txt");
        fs.writeFileSync(outputPath, content, { mode: 0o600 });
        return outputPath;
    } catch (error) {
        console.warn(`could not copy cookies from ${sourcePath}: ${error.message}`);
        return null;
    }
}

function shouldUseCookiesForRequest(body) {
    return body && body.useBrowserCookies === true;
}

function ytDLPCookieArgs(useCookies) {
    return useCookies && cookieFilePath ? ["--cookies", cookieFilePath] : [];
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
    persistJob(job);
}

function jobFilePath(id) {
    return path.join(jobsDirectory, `${path.basename(id)}.json`);
}

function persistJob(job) {
    try {
        fs.writeFileSync(jobFilePath(job.id), JSON.stringify(job), { mode: 0o600 });
    } catch (error) {
        console.warn(`could not persist job ${job.id}: ${error.message}`);
    }
}

function loadJob(id) {
    try {
        const data = fs.readFileSync(jobFilePath(id), "utf8");
        const job = JSON.parse(data);
        if (job && job.id === id) {
            jobs.set(id, job);
            return job;
        }
    } catch {
        // Missing or invalid persisted job.
    }

    return null;
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
