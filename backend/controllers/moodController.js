// backend/controllers/moodController.js
const db = require('../config/db');
const {
  discoverByGenres,
  namesToIdsCSV,
  fetchTrailerUrl,
  shapeTmdbMovie,
} = require('../services/tmdb');

/* ---------- keyword → mood helpers ---------- */
const MOOD_SYNONYMS = {
  happy:  ['happy','joy','joyful','glad','great','excited','amazing','awesome','love','ecstatic','thrilled'],
  sad:    ['sad','down','depressed','unhappy','blue','cry','tears','heartbroken','lonely'],
  anxious:['anxious','nervous','worried','stressed','stress','overwhelmed','tense','panic'],
  angry:  ['angry','mad','furious','irritated','annoyed','pissed','rage','frustrated'],
  relaxed:['relaxed','calm','chill','peaceful','serene','unwind','unwinding','cozy','laid back','nonchalant'],
  bored:  ['bored','meh','tired','dull','nothing to do','uninspired','lazy'],
};

const DEFAULT_GENRES = {
  happy:   ['Comedy','Romance','Family','Animation'],
  sad:     ['Drama','Comedy'],
  anxious: ['Animation','Family','Comedy','Adventure'],
  angry:   ['Action','Thriller','Crime'],
  relaxed: ['Romance','Comedy','Drama'],
  bored:   ['Adventure','Action','Fantasy','Sci-Fi'],
};

function detectMood(raw) {
  const text = String(raw || '').toLowerCase().trim();
  if (!text) return null;
  // single-word direct match
  if (MOOD_SYNONYMS[text]) return text;
  // keyword search
  for (const [mood, words] of Object.entries(MOOD_SYNONYMS)) {
    if (words.some(w => text.includes(w))) return mood;
  }
  return null;
}

function dedupeByKey(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const key = m?.id ? `id:${m.id}` : `${m.title}-${m.year}`;
    if (!seen.has(key)) { seen.add(key); out.push(m); }
  }
  return out;
}

/* ---------- DB opt-in helpers ---------- */
function dbEnabled() {
  // If any DB env is set, we try DB; otherwise short-circuit to TMDB-only.
  return !!(process.env.DB_HOST || process.env.DB_NAME || process.env.DB_USER);
}

async function safeQuery(sql, params = []) {
  if (!dbEnabled()) return [];
  try {
    const [rows] = await db.query(sql, params);
    return rows || [];
  } catch (e) {
    console.warn('[DB] query failed:', e.message);
    return [];
  }
}

/* ---------- small concurrency helper for trailers ---------- */
async function withConcurrency(items, limit, worker) {
  const out = [];
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(runners);
  return out;
}

/* ---------- routes ---------- */

// GET /api/mood/moods
async function getMoods(_req, res) {
  try {
    const rows = await safeQuery('SELECT id, mood_label FROM moods');
    return res.json(rows);
  } catch (err) {
    console.error('[moodController.getMoods] unexpected:', err);
    return res.status(500).json({ error: 'Failed to fetch moods' });
  }
}

// POST /api/mood/analyzeMood
async function analyzeMood(req, res) {
  const { moodText, limit = 30, page = 1 } = req.body || {};
  if (!moodText) return res.status(400).json({ error: 'Mood input is required' });

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const safePage  = Math.max(parseInt(page, 10) || 1, 1);
  const offset    = (safePage - 1) * safeLimit;

  try {
    const normalizedMood = detectMood(moodText) || String(moodText).toLowerCase();

    // 1) Genres from DB mapping table (if available), else defaults
    const mapRows = await safeQuery(
      'SELECT genre FROM mood_genre_map WHERE mood = ?',
      [normalizedMood]
    );
    let genres = mapRows.map(r => r.genre);
    if (!genres.length && DEFAULT_GENRES[normalizedMood]) {
      genres = DEFAULT_GENRES[normalizedMood];
    }

    let results = [];

    // 2) Pull from local DB first (if DB enabled)
    if (dbEnabled() && genres.length) {
      const likes = genres.map(() => 'genre LIKE ?').join(' OR ');
      const likeParams = genres.map(g => `%${g}%`);
      const rows = await safeQuery(
        `SELECT * FROM movies
         WHERE (${likes})
         ORDER BY (poster_url IS NULL OR poster_url = ''), date_added DESC
         LIMIT ? OFFSET ?`,
        [...likeParams, safeLimit, offset]
      );

      results = rows
        .filter(m => (m.poster_url || '').trim() !== '')
        .map(m => ({
          id: m.id ?? null,
          title: m.title ?? 'Untitled',
          year: m.year ?? 'Unknown',
          genres: m.genre ? m.genre.split(',').map(g => g.trim()) : [],
          poster: m.poster_url ?? '',
          trailerLink: m.trailer_url ?? '',
          reviews: m.review ? [m.review] : [],
          _source: 'db',
        }));
    }

    // 3) Fill with TMDB (IDs by genre names) and enrich with trailers
    if (genres.length && results.length < safeLimit) {
      const withGenresCSV = await namesToIdsCSV(genres);
      if (withGenresCSV) {
        const tmdb = await discoverByGenres({ withGenresCSV, page: safePage });
        let shaped = await Promise.all((tmdb || []).map(shapeTmdbMovie));

        // fetch trailers for the first N to avoid many requests
        const N = Math.min(20, shaped.length);
        const enriched = await withConcurrency(
          shaped.slice(0, N),
          5,
          async (m) => ({ ...m, trailerLink: await fetchTrailerUrl(m.id) })
        );
        shaped = [...enriched, ...shaped.slice(N)];

        results = dedupeByKey([...results, ...shaped]);
      }
    }

    // 4) Broad DB fallback if still empty (only if DB enabled)
    if (!results.length && dbEnabled()) {
      const fallbackRows = await safeQuery(
        `SELECT * FROM movies
         ORDER BY (poster_url IS NULL OR poster_url = ''), date_added DESC
         LIMIT ? OFFSET ?`,
        [safeLimit, offset]
      );
      results = fallbackRows.map(m => ({
        id: m.id ?? null,
        title: m.title ?? 'Untitled',
        year: m.year ?? 'Unknown',
        genres: m.genre ? m.genre.split(',').map(g => g.trim()) : [],
        poster: m.poster_url ?? '',
        trailerLink: m.trailer_url ?? '',
        reviews: m.review ? [m.review] : [],
        _source: 'db',
      }));
    }

    return res.json({ movies: results.slice(0, safeLimit) });
  } catch (err) {
    console.error('[moodController.analyzeMood] error:', err?.response?.data || err);
    return res.status(500).json({ error: 'Failed to analyze mood' });
  }
}

module.exports = { getMoods, analyzeMood };

