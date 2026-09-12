require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-ai-coach-service' }));

app.use('/ask', require('./routes/ask'));
app.use('/curriculum-context', require('./routes/curriculumContext'));

const PORT = process.env.PORT || 3007;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah AI Coach service running on http://localhost:${PORT}`);
  });
}

module.exports = app;
