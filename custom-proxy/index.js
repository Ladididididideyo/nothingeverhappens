const express = require('express');
const {
  JSDOM
} = require('jsdom');
const cors = require('cors');

const fetch = (...args) =>
  import('node-fetch').then(({
    default: fetch
  }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_BASE_URL = 'https://nothingeverhappens.onrender.com';

app.use(cors());

// Proxy route
app.get('/go', async (req, res) => {
  const encoded = req.query.url;
  let targetUrl;

  try {
    targetUrl = decodeURIComponent(Buffer.from(encoded, 'base64').toString('utf-8'));
    console.log(`🔍 Decoded target URL: ${targetUrl}`);
    if (!targetUrl.startsWith('http')) return res.status(400).send('Invalid target URL');
  } catch (err) {
    return res.status(400).send('Malformed Base64 URL:  ' + targetUrl);
  }
  console.log(`${targetUrl}`);
  try {
    const response = await fetch(targetUrl);
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      let html = await response.text();
      const dom = new JSDOM(html);
      const {
        document
      } = dom.window;

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
        const tag = sel.match(/^[^\[]+/)[0]; // e.g. 'img'
        const attr = sel.match(/\[([^\]]+)\]/)[1]; // e.g. 'src' or 'href' or 'action'
        rewriteAttr(tag, attr);
      });


      document.querySelectorAll('script[src]').forEach(el => {
        const src = el.getAttribute('src');
        if (src && !src.startsWith('data:')) {
          try {
            const abs = new URL(src, targetUrl).href;
            const encodedUrl = encodeURIComponent(Buffer.from(abs).toString('base64'));
            const script = document.createElement('script');
            script.textContent = `
        fetch('${PROXY_BASE_URL}/go?url=${encodedUrl}')
          .then(r => r.text())
          .then(js => {
            try {
              // Evaluate the fetched JS safely inside a function scope
              (new Function(js))();
            } catch (e) {
              console.error("Script execution error:", e);
            }
          })
          .catch(e => console.error("Script load error:", e));
      `;
            el.replaceWith(script);
          } catch (e) {
            console.error("Error rewriting script src:", e);
          }
        }
      });


      const clientPatch = document.createElement('script');
      clientPatch.textContent = `
(() => {
  const encode = (url) => btoa(new URL(url, document.baseURI).href);

  const proxy = (url) => '/go?url=' + encode(url);

  // Intercept anchor clicks
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (a && a.href) {
      e.preventDefault();
      const proxied = proxy(a.href);
      window.location.href = proxied;
    }
  });

  // Intercept form GET submissions
  document.addEventListener('submit', e => {
    const form = e.target;
    const method = (form.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') return;
    e.preventDefault();
    const action = form.getAttribute('action') || location.href;
    const params = new URLSearchParams(new FormData(form)).toString();
    const full = action.includes('?') ? action + '&' + params : action + '?' + params;
    window.location.href = proxy(full);
  });

  // Monkeypatch window.open
  const origOpen = window.open;
  window.open = function(url, ...args) {
    try {
      return origOpen.call(window, proxy(url), ...args);
    } catch {
      return origOpen.call(window, url, ...args);
    }
  };

  // Monkeypatch assignment to location.href
  const origAssign = window.location.assign;
  window.location.assign = function(url) {
    origAssign.call(window.location, proxy(url));
  };

  // Monkeypatch location.replace
  const origReplace = window.location.replace;
  window.location.replace = function(url) {
    origReplace.call(window.location, proxy(url));
  };

  // Patch fetch (optional)
  const origFetch = window.fetch;
  window.fetch = function(url, ...args) {
    return origFetch.call(window, proxy(url), ...args);
  };

  // Patch XHR (optional)
  const origXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new origXHR();
    const origOpen = xhr.open;
    xhr.open = function (method, url, ...args) {
      try {
        url = proxy(url);
      } catch {}
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