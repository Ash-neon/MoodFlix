// backend/routes/movies.js
const express = require('express');
const https = require('https');
const router = express.Router();

let sendRPC = null;
try {
  ({ sendRPC } = require('../mq/mqClient'));
} catch (e) {
  console.warn('[movies] mqClient not found; will always use TMDB fallback.');
}

/**
 * GET /api/movies?genreId=28 or ?genre=Action
 * Always use TMDB for discover (list). MQ is for /:id only.
 */
router.get('/', async (req, res) => {
  const q = req.query || {};
  const genreId = q.genreId;
  const genreName = q.genre;

  const NAME_TO_ID = {
    Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80,
    Documentary: 99, Drama: 18, Family: 10751, Fantasy: 14, History: 36,
    Horror: 27, Music: 10402, Mystery: 9648, Romance: 10749, 'Sci-Fi': 878,
    'TV Movie': 10770, Thriller: 53, War: 10752, Western: 37
  };

  const withGenres = genreId || (genreName ? NAME_TO_ID[genreName] : null);
  if (!withGenres) return res.status(400).json({ error: 'Missing genreId or unknown genre name' });

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'TMDB_API_KEY missing' });

  const url =
    'https://api.themoviedb.org/3/discover/movie' +
    '?include_adult=false&language=en-US&sort_by=popularity.desc' +
    '&with_genres=' + encodeURIComponent(withGenres) +
    '&api_key=' + encodeURIComponent(apiKey);

  https.get(url, (r) => {
    let body = '';
    r.on('data', (c) => (body += c));
    r.on('end', () => {
      try {
        if (r.statusCode !== 200) {
          return res.status(502).json({ error: 'Upstream TMDB error', status: r.statusCode });
        }
        const raw = JSON.parse(body);
        const movies = (raw.results || []).map((m) => ({
          id: m.id,
          title: m.title,
          rating: m.vote_average,
          poster: m.poster_path ? ('https://image.tmdb.org/t/p/w500' + m.poster_path) : null
        }));
        res.json(movies);
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse TMDB response' });
      }
    });
  }).on('error', (e) => res.status(500).json({ error: 'Failed to fetch movies' }));
});

/**
 * GET /api/movies/:id
 * Keep MQ here (IMDb ids) with TMDB fallback for numeric ids.
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const looksLikeImdb = /^tt\d+$/i.test(id);

  if (looksLikeImdb && typeof sendRPC === 'function') {
    try {
      const response = await sendRPC('get_movies_queue', {
        type: 'fetch_movie_by_id',
        movieId: id,
      });
      if (response && response.movie) return res.json(response.movie);
    } catch (e) {
      console.warn('[movieDetails] MQ error; falling back if possible:', e && e.message);
    }
  }

  // TMDB fallback for numeric ids
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'Unsupported id format' });

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'TMDB_API_KEY missing' });

  const axios = require('axios');
  try {
    const { data: movie } = await axios.get(
      `https://api.themoviedb.org/3/movie/${encodeURIComponent(id)}`,
      { params: { api_key: apiKey, language: 'en-US' } }
    );
    const { data: vids } = await axios.get(
      `https://api.themoviedb.org/3/movie/${encodeURIComponent(id)}/videos`,
      { params: { api_key: apiKey, language: 'en-US' } }
    );
    const trailer = (vids.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer');
    return res.json({
      id: movie.id,
      title: movie.title || movie.original_title,
      year: (movie.release_date || '').slice(0,4) || '',
      genres: (movie.genres || []).map(g => g.name),
      poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : '',
      overview: movie.overview || '',
      rating: movie.vote_average,
      trailerLink: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : '',
      _source: 'tmdb',
    });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch from TMDB' });
  }
});

module.exports = router;

