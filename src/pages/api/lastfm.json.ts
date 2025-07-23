// src/pages/api/lastfm.json.ts
import type { APIRoute } from 'astro';

const apiKey = '01441b361114d9495f9788a6ce29d8b6'; // Consider moving to environment variables
const userName = 'boop_png';

export const GET: APIRoute = async () => {
  const url = `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${userName}&api_key=${apiKey}&format=json&limit=1`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return new Response(JSON.stringify({ error: `Error fetching from Last.fm API: ${response.status} ${response.statusText}` }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return new Response(JSON.stringify({ error: 'Error fetching or parsing Last.fm data', details: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
