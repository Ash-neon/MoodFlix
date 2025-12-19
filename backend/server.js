// Load environment variables from .env
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

// ==================== MQ START ====================
const amqplib = require('amqplib');

let mqCh = null;
(async function mqInit() {
  try {
    const host  = process.env.MQ_HOST || 'localhost';
    const port  = process.env.MQ_PORT || '5672';
    const user  = process.env.MQ_USER || 'guest';
    const pass  = process.env.MQ_PASS || 'guest';
    const vhost = encodeURIComponent(process.env.MQ_VHOST || '/');
    const url   = `amqp://${user}:${pass}@${host}:${port}/${vhost}`;

    const conn = await amqplib.connect(url);
    mqCh = await conn.createChannel();

    const queue = process.env.MQ_QUEUE || 'moodflix.queue';
    await mqCh.assertQueue(queue, { durable: true });

    console.log(`[MQ] connected to ${host}:${port}/${decodeURIComponent(vhost)} queue=${queue}`);
  } catch (err) {
    console.error('[MQ] init failed:', err.message);
  }
})();

app.post('/debug/mq', async (req, res) => {
  try {
    if (!mqCh) return res.status(503).json({ ok:false, error:'MQ not ready' });
    const queue = process.env.MQ_QUEUE || 'moodflix.queue';
    const payload = {
      type: 'mood.test',
      body: req.body?.mood ? req.body : { mood: 'Happy', at: new Date().toISOString() }
    };
    await mqCh.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), { persistent: true });
    return res.json({ ok:true, queued: payload });
  } catch (e) {
    console.error('MQ publish error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});
// ==================== MQ END ====================

// health/version
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/version', (_req, res) =>
  res.json({ name: 'moodflix-backend', env: process.env.INSTANCE_NAME || 'dev' })
);

// Explicit CORS configuration to allow both 8080 (old) and 5500 (Live Server)
const corsOptions = {
  origin: [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.use(express.json());

// Optional sanity check — remove later
console.log('TMDB key present?', !!process.env.TMDB_API_KEY);

// Import routes
const moviesRouter = require('./routes/movies');
const moodRoutes = require('./routes/mood');
const managerRoutes = require('./routes/manager');
const genresRoutes = require('./routes/genres');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const availabilityRoutes = require('./routes/availability');
const reviewsRoutes = require('./routes/reviews');
const userRoutes = require('./routes/user');        
const favoritesRoutes = require('./routes/favorites');
const moderationRoutes = require('./routes/moderation');
const movieDetailsRouter = require('./routes/movieDetails');

// Register routes
app.use('/api/movies', moviesRouter);
app.use('/api/mood', moodRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/genres', genresRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/user', userRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/api/movies', movieDetailsRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
