const express = require('express');
const router = express.Router();
const { retrieveCurriculumContext } = require('../services/rag');

// POST /curriculum-context
// Body: { question, curriculum, grade, subject, topic? }
// Thin passthrough to the same retrieval retrieveCurriculumContext() already
// uses for AI Tutor answers — lets other services (e.g. teacher curriculum
// generation) ground content in real NCERT/vector material without a second
// retrieval implementation.
router.post('/', async (req, res) => {
  const { question, curriculum, grade, subject, topic } = req.body;
  if (!question || !curriculum || !grade) {
    return res.status(400).json({ error: 'question, curriculum and grade are required' });
  }
  try {
    const result = await retrieveCurriculumContext({ question, curriculum, grade, subject, topic });
    res.json(result);
  } catch (err) {
    console.error('[curriculum-context] retrieval failed:', err.message);
    res.status(500).json({ error: 'Failed to retrieve curriculum context' });
  }
});

module.exports = router;
