# Social Video Downloader Backend

Esta pasta e a ponte completa usada pelo app iOS para baixar videos de YouTube, Shorts, Instagram e X/Twitter.

O app iOS envia o link para esta API. A API usa `yt-dlp` e `ffmpeg`, gera o arquivo final e devolve uma URL para o iPhone baixar.

Use apenas com conteudo que voce tem direito de baixar.

## Arquivos importantes

- `server.js`: API HTTP da ponte.
- `package.json`: scripts para rodar em servidor Node ou via Docker.
- `Dockerfile`: ambiente pronto para servidor, instalando Node.js, `yt-dlp` e `ffmpeg`.
- `downloads/`: pasta onde os videos e audios baixados ficam por padrao.

## URL em producao

Configure o app iOS para usar:

```text
https://social-video-downloader-api.onrender.com
```

## Rodar em servidor Node

O servidor precisa ter `node`, `yt-dlp`, `ffmpeg` e `ffprobe` instalados no `PATH`.

```sh
npm start
```

## Rodar em servidor com Docker

Dentro desta pasta:

```sh
docker build -t social-video-downloader-api .
docker run --rm -p 8765:8765 social-video-downloader-api
```

Com pasta persistente:

```sh
docker run --rm \
  -p 8765:8765 \
  -v "$PWD/downloads:/app/downloads" \
  social-video-downloader-api
```

## Variaveis de ambiente

- `HOST`: host de escuta. Padrao: `0.0.0.0`.
- `PORT`: porta HTTP. Padrao: `8765`.
- `DOWNLOADS_DIR`: pasta onde os arquivos finais sao salvos. Padrao local: `backend/downloads`; no Docker: `/app/downloads`.
- `QUALITIES_TIMEOUT_MS`: tempo maximo para listar qualidades com `yt-dlp`. Padrao: `60000`.
- `MAX_VIDEO_HEIGHT`: altura maxima do video baixado. Padrao: `1080`, evitando downloads em 4K.
- `YTDLP_PATH`: caminho customizado para `yt-dlp`.
- `FFMPEG_PATH`: caminho customizado para `ffmpeg`.
- `YTDLP_COOKIES_BASE64`: cookies exportados do navegador em formato Netscape, codificados em base64. Use quando YouTube retornar "Sign in to confirm you're not a bot".
- `YTDLP_COOKIES`: mesma coisa, mas em texto puro. Prefira `YTDLP_COOKIES_BASE64` no Render.
- `YTDLP_COOKIES_FILE`: caminho de um arquivo de cookies ja existente no servidor.

## Endpoints

- `GET /health`
- `POST /qualities`
- `POST /downloads`
- `GET /downloads/:id`
- `GET /files/:fileName`

Exemplo:

```sh
curl https://social-video-downloader-api.onrender.com/health
```
