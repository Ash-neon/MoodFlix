// backend/routes/movieDetails.js
const express = require('express');
const router = express.Router();
const axios = require('axios');

let sendRPC = null;

try { ({ sendRPC } = require('../mq/mqClient')); }
catch { console.warn('[movieDetails] mqClient not found; MQ will be skipped.'); }

// Fallback: fetch details directly from TMDB for numeric IDs
async function fetchTmdbDetails(tmdbId) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error('TMDB_API_KEY missing');

  const { data: movie } = await axios.get(
    `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}`,
    { params: { api_key: apiKey, language: 'en-US' } }
  );

  // Optional: trailer lookup
  const { data: vids } = await axios.get(
    `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}/videos`,
    { params: { api_key: apiKey, language: 'en-US' } }
  );
  const trailer = (vids.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer');
  const trailerLink = trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : '';

  return {
    id: movie.id,
    title: movie.title || movie.original_title,
    year: (movie.release_date || '').slice(0, 4) || '',
    genres: (movie.genres || []).map(g => g.name),
    poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : '',
    overview: movie.overview || '',
    rating: movie.vote_average,
    trailerLink,
    _source: 'tmdb',
  };
}

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  // If the id looks like an IMDb id (ttXXXX), try MQ first
  const looksLikeImdb = /^tt\d+$/i.test(id);

  if (looksLikeImdb && typeof sendRPC === 'function') {
    try {
      const response = await sendRPC('get_movies_queue', {
        type: 'fetch_movie_by_id',
        movieId: id,
      });
      if (response && response.movie) return res.json(response.movie);
      console.warn('[movieDetails] MQ returned no movie; falling back if possible.');
    } catch (e) {
      console.warn('[movieDetails] MQ error; falling back if possible:', e && e.message);
    }
  }

  // Fallback to TMDB if id is numeric
  if (/^\d+$/.test(id)) {
    try {
      const detail = await fetchTmdbDetails(id);
      return res.json(detail);
    } catch (e) {
      console.error('[movieDetails] TMDB fallback failed:', e && e.message);
      return res.status(502).json({ error: 'Failed to fetch from TMDB' });
    }
  }

  // If we got here, we couldn’t serve the id
  return res.status(404).json({ error: 'Movie not found (unsupported id format or provider down)' });
});

module.exports = router;

