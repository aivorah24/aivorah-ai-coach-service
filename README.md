# Aivorah AI Coach Service

Standalone microservice for the Aivorah AI Coach — RAG-grounded student Q&A,
streaming (SSE) and non-streaming, extracted from `ai-mentor/server`.

## Structure

```
routes/
  ask.js                 — POST /, POST /stream, GET /usage, POST /feedback,
                            POST /teacher, POST /parent
services/
  ai-coach/
    context.js            — gatherAnswerContext: RAG + web-search fallback,
                             shared by both /ask and /ask/stream
    usage.js               — free-tier daily usage tracking (Supabase)
    lessonGrounding.js     — pulls a topic's verified lesson content so the
                              Coach can't drift to a wrong method/answer
  llm.js                  — Groq (with key rotation across rate limits) +
                             NVIDIA NIM last-resort fallback
  rag.js                  — Qdrant curriculum-context retrieval
  qdrant.js / embeddings.js / cloudinaryUrls.js  — RAG infra
  webSearch.js            — curriculum-aware web-search fallback
  contentSafety.js        — input safety pre-flight
  analytics.js / tokenLogger.js / supabase.js    — logging + Supabase client
utils/
  curriculum.js           — curriculum-name normalization
data/
  cloudinary_urls.json    — local-path -> Cloudinary CDN URL map for images
```

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev             # nodemon, or `npm start` for a plain run
```

Runs on `PORT` (default `3007`).

## Endpoints

- `POST /ask` — non-streaming student Q&A
- `POST /ask/stream` — SSE streaming version
- `GET /ask/usage?email=` — daily free-tier usage
- `POST /ask/feedback` — session rating (1/2/3)
- `POST /ask/teacher` — teacher AI assistant (separate persona, no RAG)
- `POST /ask/parent` — parent AI assistant (separate persona, no RAG)
- `GET /health`

## Branching

`main` is protected — no direct pushes. Work on a feature branch and open a PR.
