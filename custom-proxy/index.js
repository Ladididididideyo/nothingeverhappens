const express = require('express');
const { JSDOM } = require('jsdom');
const cors = require('cors');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Proxy route
app.get('/rendered', async (req, res) => {
  const base64 = req.query.target;
  let targetUrl;

  try {
    targetUrl = decodeURIComponent(Buffer.from(base64, 'base64').toString('utf-8'));
    console.log(`🚀 Proxy server decoded ${targetUrl}`);
    if (!targetUrl.startsWith('http')) {
      return res.status(400).send('Invalid decoded URL');
    }
  } catch (e) {
    return res.status(400).send('Invalid Base64 target');
  }

  try {
    const response = await fetch(targetUrl);
    let html = await response.text();

    const dom = new JSDOM(html);
    const { document } = dom.window;

    // Remove CSP
    document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(el => el.remove());

    // Inject <base>
    const base = document.createElement('base');
    base.href = targetUrl;
    document.head.prepend(base);

    const rewriteAttr = (selector, attr) => {
      document.querySelectorAll(selector).forEach(el => {
        const val = el.getAttribute(attr);
        if (val) {
          try {
            const absUrl = new URL(val, targetUrl).href;
            el.setAttribute(attr, `/proxy?url=${encodeURIComponent(absUrl)}`);
          } catch (e) {
            console.warn('Invalid resource URL:', val);
          }
        }
      });
    };

    rewriteAttr('img', 'src');
    rewriteAttr('link[rel=stylesheet]', 'href');
    rewriteAttr('video', 'src');
    rewriteAttr('audio', 'src');
    rewriteAttr('source', 'src');
    rewriteAttr('form', 'action');

    // Inline scripts via fetch
    document.querySelectorAll('script[src]').forEach(el => {
      const src = el.getAttribute('src');
      if (src) {
        try {
          const absUrl = new URL(src, targetUrl).href;
          const newScript = document.createElement('script');
          newScript.textContent = `
            fetch('/proxy?url=${encodeURIComponent(absUrl)}')
              .then(res => res.text())
              .then(js => Function(js)())
              .catch(err => console.error("Script load error:", err));
          `;
          el.replaceWith(newScript);
        } catch (e) {
          console.warn('⚠️ Invalid script URL skipped:', src);
        }
      }
    });

    res.send(dom.serialize());
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});



// Basic proxy for assets
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target || !target.startsWith('http')) {
    return res.status(400).send('Invalid target URL');
  }

  try {
    const proxied = await fetch(target);
    const contentType = proxied.headers.get('content-type');
    res.set('Content-Type', contentType);
    proxied.body.pipe(res);
  } catch (err) {
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
