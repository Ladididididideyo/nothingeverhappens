const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing ?url=' });

  try {
    const response = await fetch(targetUrl);
    const body = await response.text();
    res.send(body);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch target URL', detail: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Proxy server running on port ${port}`));
