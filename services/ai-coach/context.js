const { retrieveCurriculumContext, retrieveNcertImages } = require('../rag');
const { retrieveWebContext } = require('../webSearch');

// Shared by /ask and /ask/stream: pulls curriculum context from Qdrant RAG,
// falls back to NCERT images for IB PYP (which has none ingested), then
// falls back to a curriculum-aware web search when RAG found no context.
// NO Wikipedia web-image fallback — those pull off-topic/stock pictures
// (a penny-farthing, a branded tyre for "bicycle") that don't belong in
// Aivorah. Only real curriculum images from RAG are shown; otherwise none.
async function gatherAnswerContext({ question, curriculum, grade, subject, topic, history }) {
  let context = '';
  let sources = [];
  let images = [];
  let ragMeta = { strategy: 'none', strictCandidates: 0, broadCandidates: 0, selected: 0 };
  let webMeta = { enabled: false, query: '', count: 0 };

  // 1. Retrieve RAG context from Qdrant
  try {
    const rag = await retrieveCurriculumContext({
      question,
      curriculum,
      grade: grade || undefined,
      subject: subject || undefined,
      topic: topic || undefined,
      history,
      maxSources: 5,
    });
    context = rag.context;
    sources = rag.sources;
    images = rag.images || [];
    ragMeta = rag.meta;

    // IB PYP has no images ingested — fall back to NCERT images for the same topic.
    // Uses dedicated image-only search to avoid text chunks crowding out images.
    if (images.length === 0 && curriculum === 'IB PYP') {
      try {
        const ncertImages = await retrieveNcertImages({ question, subject, topic, grade });
        if (ncertImages.length > 0) images = ncertImages;
      } catch (_) { /* silent — images are supplementary */ }
    }
  } catch (qdrantErr) {
    // Continue with no context if retrieval is unavailable
    console.warn('Qdrant unavailable, using no-context mode:', qdrantErr.message);
  }

  // IB PYP image fallback — runs even if IB_PYP RAG failed above
  if (images.length === 0 && curriculum === 'IB PYP') {
    try {
      const ncertImages = await retrieveNcertImages({ question, subject, topic, grade });
      if (ncertImages.length > 0) images = ncertImages;
    } catch (_) { /* silent — images are supplementary */ }
  }

  // Curriculum-aware web search fallback when RAG has no context
  if (!context) {
    try {
      const web = await retrieveWebContext({
        question,
        curriculum,
        grade: grade || undefined,
        subject: subject || undefined,
        topic: topic || undefined,
      });
      if (web.context) {
        context = web.context;
        sources = web.sources;
      }
      webMeta = web.meta;
    } catch (webErr) {
      console.warn('Web search fallback unavailable:', webErr.message);
    }
  }

  return { context, sources, images, ragMeta, webMeta };
}

module.exports = { gatherAnswerContext };
