const supabase = require('../supabase');

// Authoritative lesson grounding: when a topic has a published Aivorah lesson,
// return ITS verified content (worked examples + body) so the AI Coach teaches
// the same correct method and answers — never inventing a wrong method or a
// wrong calculation (the bug QA caught: "45 - 3 = 32"). Best-effort; '' on miss.
async function getLessonGrounding(topic) {
  try {
    if (!topic) return '';
    const { data: tp } = await supabase.from('syllabus_topics').select('id').eq('name', topic).limit(1).maybeSingle();
    if (!tp?.id) return '';
    const { data: rr } = await supabase.from('topic_resources').select('static_payload')
      .eq('topic_id', tp.id).eq('resource_type', 'AI_EXPLANATION').maybeSingle();
    const L = rr?.static_payload;
    if (!L) return '';
    const parts = [];
    if (Array.isArray(L.body) && L.body.length) parts.push(L.body.join(' '));
    if (Array.isArray(L.workedExamples) && L.workedExamples.length) {
      parts.push('Worked examples (use THIS exact method and these correct answers — do not invent another method or miscalculate):');
      L.workedExamples.forEach(e => parts.push(`${e.problem} → ${(e.steps || []).join(' ')} Answer: ${e.answer}.`));
    }
    if (!parts.length) return '';
    return `AUTHORITATIVE LESSON CONTENT for "${topic}" — teach strictly from this, using the same method and matching answers:\n${parts.join('\n')}\n\n`;
  } catch { return ''; }
}

module.exports = { getLessonGrounding };
