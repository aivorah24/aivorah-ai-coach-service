const express = require('express');
const router = express.Router();
const { generateAnswer, generateAnswerStream } = require('../services/llm');
const { gatherAnswerContext } = require('../services/ai-coach/context');
const { getLessonGrounding } = require('../services/ai-coach/lessonGrounding');
const { logEvent } = require('../services/analytics');
const { normalizeCurriculum } = require('../utils/curriculum');
const { checkInputSafety } = require('../services/contentSafety');
const supabase = require('../services/supabase');

// POST /ask
// Body: { question, curriculum?, grade?, subject?, topic? }
router.post('/', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { question, curriculum = 'IB_PYP', grade, subject, topic, history = [], userEmail, role } = req.body;
    const normalizedCurriculum = normalizeCurriculum(curriculum);

    if (!question || question.trim().length === 0) {
      return res.status(400).json({ error: 'question is required' });
    }

    // ── Content safety pre-flight ──────────────────────────────────
    const safety = checkInputSafety(question);
    if (!safety.safe) {
      console.warn('[Safety] Blocked input:', safety.category, '| email:', userEmail);
      return res.json({ answer: safety.response, sources: [], images: [] });
    }

    const { context, sources, images: gatheredImages, ragMeta, webMeta } = await gatherAnswerContext({
      question, curriculum: normalizedCurriculum, grade, subject, topic, history,
    });
    let images = gatheredImages;

    // Generate the answer. Prepend the topic's authoritative lesson (verified
    // method + answers) so the Coach can't drift to a wrong method/calculation.
    const lessonGrounding = await getLessonGrounding(topic);
    const groundedContext = lessonGrounding ? lessonGrounding + (context || '') : context;
    const answer = await generateAnswer({ question, context: groundedContext, grade, subject, topic, history, _meta: { route: '/ask', studentEmail: userEmail } });

    // Never show images alongside an off-topic redirect or no-context fallback
    const isRedirectAnswer = /I'm your school AI Coach|Let's finish|Great curiosity!/i.test(answer);
    if (isRedirectAnswer) images = [];

    logEvent('ai_ask', {
      userEmail,
      role,
      source: 'topic_ai_coach',
      status: 'success',
      latencyMs: Date.now() - startedAt,
      topic,
      subject,
      grade,
      meta: {
        hasRagContext: Boolean(context),
        sourceCount: sources.length,
        ragStrategy: ragMeta.strategy,
        strictCandidates: ragMeta.strictCandidates,
        broadCandidates: ragMeta.broadCandidates,
        usedFollowUpExpansion: Boolean(ragMeta.usedFollowUpExpansion),
        subjectUsed: ragMeta.subjectUsed || '',
        subjectInferred: Boolean(ragMeta.subjectInferred),
        hasWebContext: Boolean(webMeta.count),
        webSourceCount: webMeta.count || 0,
        webQuery: webMeta.query || '',
      },
    }).catch(() => {});

    res.json({ answer, sources, images });
  } catch (err) {
    console.error('Error in /ask:', err.message);
    logEvent('ai_ask', {
      userEmail: req.body?.userEmail,
      role: req.body?.role,
      source: 'topic_ai_coach',
      status: 'error',
      latencyMs: Date.now() - startedAt,
      topic: req.body?.topic,
      subject: req.body?.subject,
      grade: req.body?.grade,
      meta: { error: err.message },
    }).catch(() => {});
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /ask/teacher — Teacher AI assistant, no student guardrails, uses real class data
// Supports: text questions, image attachments (base64), PDF text extraction (text + scanned)
router.post('/teacher', async (req, res) => {
  try {
    const { question, classSummary = '', teacherEmail = '', imageBase64, imageType, pdfText, pdfBase64, pdfName } = req.body;
    if (!question?.trim() && !imageBase64 && !pdfText && !pdfBase64) return res.status(400).json({ error: 'question or attachment required' });

    // Server-side PDF text extraction for scanned/image PDFs
    let resolvedPdfText = pdfText || '';
    if (pdfBase64 && !resolvedPdfText) {
      try {
        const pdfParse = require('pdf-parse');
        const buffer = Buffer.from(pdfBase64, 'base64');
        const data = await pdfParse(buffer);
        resolvedPdfText = data.text?.trim() || '';
        if (!resolvedPdfText) {
          resolvedPdfText = `[This PDF (${pdfName || 'uploaded'}) appears to be a scanned/image-based document with no extractable text. Please upload the individual pages as images for analysis.]`;
        }
      } catch (pdfErr) {
        resolvedPdfText = `[PDF parse error: ${pdfErr.message}. Try uploading pages as images instead.]`;
      }
    }

    const Groq = require('groq-sdk');
    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const systemPrompt = `You are an expert AI teaching assistant for the Aivorah platform, helping a professional school teacher make data-driven decisions.

RULES — follow these strictly:
1. ONLY use the data provided below. Never invent scores, topics, or student behaviour.
2. Students with 0% progress AND 0 topics AND "not started yet" status are INACTIVE accounts — do NOT flag them as needing attention. Simply note them as "not yet active" if asked.
3. A student who has high completion (e.g. 50+ topics, 80%+ progress) is doing WELL — never flag them as needing attention.
4. "Needs attention" means: the student HAS been active but is STRUGGLING — low practice test scores (<60%), declining trends, or repeated failures on specific topics.
5. TOPICS TO RETEACH IN CLASS: Look at practice test data across ALL students. If MULTIPLE students score below 60% on the SAME topic, that topic likely needs reteaching. A topic that one student passed with 80%+ does NOT need reteaching.
6. Do NOT recommend "revisiting" topics a student has already passed (scored 60%+). That wastes class time.
7. When listing students who need help, explain WHY with specific data: "Sai Mohan scored 40% on Currency Conversion after 1 attempt — needs practice."
8. Keep responses concise with clear headers and bullet points. No fluff, no generic advice.
9. If given an image of an assignment or worksheet, analyse it, grade it if possible, identify mistakes, and give teacher feedback.
10. If given PDF text (assignment/worksheet), extract questions, grade answers, and provide per-student feedback.

HOW TO READ THE DATA:
- "Practice tests: N topics attempted, M passed" = quiz performance data
- "STRUGGLING in: TopicName (score%, attempts)" = topics where student is failing
- "status: excellent/good progress/on track/early stage/not started yet" = computed from real progress data
- Students without practice test data simply haven't taken quizzes yet — that's not the same as struggling.

CLASS DATA:
${classSummary || 'No class data provided.'}`;

    let answer;

    // Image attachment — use Groq vision model
    if (imageBase64) {
      const userContent = [
        {
          type: 'image_url',
          image_url: { url: `data:${imageType || 'image/jpeg'};base64,${imageBase64}` },
        },
        {
          type: 'text',
          text: question || 'Analyse this assignment/document. Grade it, identify mistakes, and provide teacher feedback.',
        },
      ];
      // llama-4-scout was shut down by Groq on 2026-07-17. gpt-oss-120b (used
      // elsewhere in this file) is text-only, so it can't replace this
      // specific call — this one sends image_url content. Llama 4 Maverick
      // is Groq's still-active, production vision model (not the
      // preview-only Qwen3.6 Groq also suggests) — same native-multimodal
      // family as Scout, so it's the closest faithful replacement.
      const completion = await client.chat.completions.create({
        model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });
      answer = completion.choices?.[0]?.message?.content || 'Could not analyse image.';

    } else {
      // Text question (possibly with PDF text appended)
      const userContent = resolvedPdfText
        ? `${question || 'Analyse this document:'}\n\n[PDF CONTENT]:\n${resolvedPdfText.slice(0, 6000)}`
        : question;

      const completion = await client.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.4,
        max_tokens: 800,
      });
      answer = completion.choices?.[0]?.message?.content || 'Unable to generate response.';
    }

    res.json({ answer });
  } catch (err) {
    console.error('Teacher AI error:', err.message);
    res.status(500).json({ error: 'AI error: ' + err.message });
  }
});

// POST /ask/parent — Parent AI assistant
// Warm, jargon-free, focused on single child. No teacher-level data access.
router.post('/parent', async (req, res) => {
  try {
    const { question, childSummary = '', childName = '', parentEmail = '' } = req.body;
    if (!question?.trim()) return res.status(400).json({ error: 'question is required' });

    const Groq = require('groq-sdk');
    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const systemPrompt = `You are a warm, supportive AI assistant helping a parent understand and support their child's learning journey on the Aivorah platform.

Your role:
- Explain their child's progress in simple, jargon-free language
- Suggest specific, practical activities they can do at home (5–10 minutes max)
- Help them understand what topics their child is working on
- Decode report data into plain English
- Help draft messages to the teacher if asked
- Be encouraging and non-judgmental — never make the parent feel bad
- Keep answers short, warm, and actionable

Rules:
- Only talk about the child whose data is provided
- Never make up data — only use what's in CHILD DATA below
- If data is missing, say so kindly and suggest what to look for
- No technical jargon — speak like a friendly school counsellor

CHILD DATA:
${childSummary || 'No child data available yet.'}`;

    const completion = await client.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      temperature: 0.5,
      max_tokens: 600,
    });

    const answer = completion.choices?.[0]?.message?.content || 'Unable to generate response.';
    res.json({ answer });
  } catch (err) {
    console.error('Parent AI error:', err.message);
    res.status(500).json({ error: 'AI error: ' + err.message });
  }
});

// POST /ask/stream - SSE streaming version
router.post('/stream', async (req, res) => {
  const startedAt = Date.now();
  const { question, curriculum = 'IB_PYP', grade, subject, topic, history = [], userEmail, role } = req.body;
  const normalizedCurriculum = normalizeCurriculum(curriculum);

  if (!question || question.trim().length === 0) {
    return res.status(400).json({ error: 'question is required' });
  }

  // ── Content safety pre-flight (stream) ────────────────────────
  const streamSafety = checkInputSafety(question);
  if (!streamSafety.safe) {
    console.warn('[Safety] Blocked stream input:', streamSafety.category, '| email:', userEmail);
    return res.json({ answer: streamSafety.response, sources: [], images: [] });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const { context, sources, images, ragMeta, webMeta } = await gatherAnswerContext({
      question, curriculum: normalizedCurriculum, grade, subject, topic, history,
    });

    // Send sources + images first
    res.write(`data: ${JSON.stringify({ type: 'sources', sources, images })}\n\n`);

    // Prepend the topic's authoritative lesson so the streamed Coach answer uses
    // the same verified method + correct answers as the lesson.
    const lessonGroundingS = await getLessonGrounding(topic);
    const groundedContextS = lessonGroundingS ? lessonGroundingS + (context || '') : context;

    // 2. Stream answer tokens
    await generateAnswerStream({
      question,
      context: groundedContextS,
      grade,
      subject,
      topic,
      history,
      _meta: { route: '/ask/stream', studentEmail: userEmail },
      onToken: (token) => {
        res.write(`data: ${JSON.stringify({ type: 'token', token })}\n\n`);
      },
    });

    // 3. Done signal
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

    logEvent('ai_ask', {
      userEmail,
      role,
      source: 'topic_ai_coach',
      status: 'success',
      latencyMs: Date.now() - startedAt,
      topic,
      subject,
      grade,
      meta: {
        hasRagContext: Boolean(context),
        sourceCount: sources.length,
        streamed: true,
        ragStrategy: ragMeta.strategy,
        strictCandidates: ragMeta.strictCandidates,
        broadCandidates: ragMeta.broadCandidates,
        usedFollowUpExpansion: Boolean(ragMeta.usedFollowUpExpansion),
        subjectUsed: ragMeta.subjectUsed || '',
        subjectInferred: Boolean(ragMeta.subjectInferred),
        hasWebContext: Boolean(webMeta.count),
        webSourceCount: webMeta.count || 0,
        webQuery: webMeta.query || '',
      },
    }).catch(() => {});
  } catch (err) {
    console.error('Error in /ask/stream:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Something went wrong. Please try again.' })}\n\n`);
    res.end();
  }
});

// POST /ask/feedback — session rating (1/2/3) from AI Coach
router.post('/feedback', async (req, res) => {
  try {
    const { studentEmail, rating, grade, messageCount } = req.body;
    if (!rating || ![1, 2, 3].includes(Number(rating))) {
      return res.status(400).json({ error: 'rating must be 1, 2, or 3' });
    }
    await supabase.from('llm_logs').insert({
      provider: 'session',
      model: 'session_feedback',
      route: '/session/feedback',
      student_email: studentEmail || null,
      grade: grade || null,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: messageCount || 0,
      estimated_cost_usd: 0,
      response_time_ms: 0,
      feedback: Number(rating),
      streamed: false,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
