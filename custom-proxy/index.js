const express = require('express');
const { JSDOM } = require('jsdom');
const cors = require('cors');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_BASE_URL = 'https://nothingeverhappens.onrender.com';

app.use(cors());

// Proxy route
app.get('/go', async (req, res) => {
  const encoded = req.query.target;
  let targetUrl;

  try {
    targetUrl = decodeURIComponent(Buffer.from(encoded, 'base64').toString('utf-8'));
    console.log(`🔍 Decoded target URL: ${targetUrl}`);
    if (!targetUrl.startsWith('http')) return res.status(400).send('Invalid target URL');
  } catch (err) {
    return res.status(400).send('Malformed Base64 URL:  ' + targetUrl);
  }

  try {
    const response = await fetch(targetUrl);
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      let html = await response.text();
      const dom = new JSDOM(html);
      const { document } = dom.window;

      document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(el => el.remove());

      const base = document.createElement('base');
      base.href = targetUrl;
      document.head.prepend(base);

      const rewriteAttr = (selector, attr) => {
        document.querySelectorAll(selector).forEach(el => {
          const val = el.getAttribute(attr);
          if (val && !val.startsWith('data:')) {
            try {
              const abs = new URL(val, targetUrl).href;
              el.setAttribute(attr, `${PROXY_BASE_URL}/go?url=${Buffer.from(abs).toString('base64')}`);
            } catch {}
          }
        });
      };

      ['img[src]', 'script[src]', 'link[rel=stylesheet][href]', 'video[src]', 'audio[src]', 'source[src]', 'form[action]']
        .forEach(sel => {
          const [tag, attr] = sel.split(/\[|\]/)[0].split(/(?=\[)/);
          rewriteAttr(tag, attr.slice(0, -1));
        });

      document.querySelectorAll('script[src]').forEach(el => {
        const src = el.getAttribute('src');
        if (src && !src.startsWith('data:')) {
          try {
            const abs = new URL(src, targetUrl).href;
            const script = document.createElement('script');
            script.textContent = `
              fetch('${PROXY_BASE_URL}/go?url=${Buffer.from(abs).toString('base64')}')
                .then(r => r.text())
                .then(js => Function(js)())
                .catch(e => console.error("Script load error:", e));`;
            el.replaceWith(script);
          } catch {}
        }
      });

      const clientPatch = document.createElement('script');
      clientPatch.textContent = `
        (() => {
          const postToParent = (type, url) => {
            try {
              const abs = new URL(url, document.baseURI).href;
              window.parent.postMessage({ type, url: abs }, '*');
            } catch (e) { console.error(e); }
          };

          document.querySelectorAll('a[href]').forEach(a => a.addEventListener('click', e => {
            e.preventDefault();
            postToParent('link-click', a.getAttribute('href'));
          }));

          document.querySelectorAll('form').forEach(form => form.addEventListener('submit', e => {
            e.preventDefault();
            const action = form.getAttribute('action') || location.href;
            const method = (form.getAttribute('method') || 'get').toLowerCase();
            if (method !== 'get') return alert('Only GET forms supported');
            const params = new URLSearchParams(new FormData(form)).toString();
            const fullUrl = action.includes('?') ? action + '&' + params : action + '?' + params;
            postToParent('navigate', fullUrl);
          }));

          const rewriteUrl = (url) => '/go?url=' + btoa(url);
          const origFetch = window.fetch;
          window.fetch = (url, opts) => origFetch(rewriteUrl(url), opts);

          const origXHR = window.XMLHttpRequest;
          window.XMLHttpRequest = function() {
            const xhr = new origXHR();
            const origOpen = xhr.open;
            xhr.open = function(method, url, ...args) {
              try { url = rewriteUrl(url); } catch {}
              return origOpen.call(this, method, url, ...args);
            };
            return xhr;
          };
        })();
      `;
      document.body.append(clientPatch);
      return res.send(dom.serialize());

    } else {
      res.set('Content-Type', contentType);
      response.body.pipe(res);
    }
  } catch (err) {
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
