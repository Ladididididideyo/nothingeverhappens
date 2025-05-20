const express = require('express');
const cors = require('cors');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return res.status(400).send('Invalid or missing URL.');
  }

  try {
    const response = await fetch(targetUrl);
    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch: ${response.statusText}`);
    }

    // Set the content-type from the original response
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.set('Content-Type', contentType);
    }

    // Pipe the response body directly to client
    response.body.pipe(res);

  } catch (err) {
    console.error('❌ Proxy fetch error:', err.message);
    res.status(500).send('Proxy server error: ' + err.message);
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
