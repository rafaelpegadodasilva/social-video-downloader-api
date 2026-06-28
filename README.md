# Social Video Downloader Backend

Esta pasta e a ponte completa usada pelo app iOS para baixar videos de YouTube, Shorts, Instagram e X/Twitter.

O app iOS envia o link para esta API. A API usa `yt-dlp` e `ffmpeg`, gera o arquivo final e devolve uma URL para o iPhone baixar.

Use apenas com conteudo que voce tem direito de baixar.

## Arquivos importantes

- `server.js`: API HTTP da ponte.
- `package.json`: scripts para rodar localmente ou via Docker.
- `Dockerfile`: ambiente pronto para servidor, instalando Node.js, `yt-dlp` e `ffmpeg`.
- `downloads/`: pasta onde os videos e audios baixados ficam por padrao.

## Rodar no Mac local

Instale as ferramentas:

```sh
brew install node yt-dlp ffmpeg
```

Rode a ponte:

```sh
cd "/Volumes/SSDExterno/projetos/AppYOUTUBE/IOS VERSION/Social Video Downloader iOS/backend"
npm run start:local
```

No simulador iOS, configure:

```text
http://127.0.0.1:8765
```

No iPhone fisico, use o IP do Mac na mesma rede:

```text
http://192.168.100.3:8765
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
- `YTDLP_PATH`: caminho customizado para `yt-dlp`.
- `FFMPEG_PATH`: caminho customizado para `ffmpeg`.

## Endpoints

- `GET /health`
- `POST /qualities`
- `POST /downloads`
- `GET /downloads/:id`
- `GET /files/:fileName`

Exemplo:

```sh
curl http://127.0.0.1:8765/health
```
