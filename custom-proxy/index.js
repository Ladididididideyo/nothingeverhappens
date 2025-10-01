const express = require('express');
const { JSDOM } = require('jsdom');
const cors = require('cors');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'https://nothingeverhappens.onrender.com';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Simple memory cache with size limit for free tier
const cache = new Map();
const MAX_CACHE_SIZE = 50;
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes TTL

// Utility functions
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function encodeUrl(url) {
  try {
    return Buffer.from(url).toString('base64');
  } catch (e) {
    console.error('Error encoding URL:', e);
    throw new Error('Invalid URL encoding');
  }
}

function decodeUrl(encoded) {
  try {
    return decodeURIComponent(Buffer.from(encoded, 'base64').toString('utf-8'));
  } catch (e) {
    console.error('Error decoding URL:', e);
    throw new Error('Invalid URL encoding');
  }
}

// Manage cache size
function manageCacheSize() {
  if (cache.size > MAX_CACHE_SIZE) {
    // Delete the oldest entry
    const oldestKey = Array.from(cache.keys())[0];
    cache.delete(oldestKey);
  }
}

// Fetch with timeout and retry for free tier limitations
async function fetchWithRetry(url, options = {}, retries = 2, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...options.headers,
      }
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (retries > 0) {
      console.log(`Retrying ${url}, ${retries} attempts left`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return fetchWithRetry(url, options, retries - 1, timeout);
    }
    
    throw error;
  }
}

// Enhanced URL rewriting function with better resource handling
function rewriteResourceUrls(document, targetUrl, proxyBaseUrl) {
  // List of attributes that may contain URLs
  const urlAttributes = [
    'href', 'src', 'srcset', 'data-src', 'data-href', 'action', 
    'poster', 'background', 'cite', 'formaction', 'icon', 'manifest',
    'archive', 'code', 'codebase', 'usemap'
  ];

  // Elements that might contain URL attributes
  const elementsWithUrls = document.querySelectorAll('*');
  
  elementsWithUrls.forEach(element => {
    urlAttributes.forEach(attr => {
      if (element.hasAttribute(attr)) {
        const value = element.getAttribute(attr);
        
        // Skip data URLs, javascript URLs, etc.
        if (value && 
            !value.startsWith('data:') && 
            !value.startsWith('javascript:') && 
            !value.startsWith('mailto:') && 
            !value.startsWith('blob:') &&
            !value.startsWith('#')) {
          
          try {
            let absoluteUrl;
            if (value.startsWith('//')) {
              absoluteUrl = new URL(targetUrl).protocol + value;
            } else {
              absoluteUrl = new URL(value, targetUrl).href;
            }
            
            // Only proxy HTTP/HTTPS resources
            if (absoluteUrl.startsWith('http')) {
              const encodedUrl = encodeUrl(absoluteUrl);
              element.setAttribute(attr, `${proxyBaseUrl}/go?url=${encodedUrl}`);
            }
          } catch (e) {
            console.error('Error rewriting URL:', e);
          }
        }
      }
    });
  });

  // Handle srcset attribute specially (can contain multiple URLs)
  document.querySelectorAll('[srcset]').forEach(element => {
    const srcset = element.getAttribute('srcset');
    if (srcset) {
      const newSrcset = srcset.split(',').map(part => {
        const [url, descriptor] = part.trim().split(/\s+/);
        if (url && !url.startsWith('data:') && !url.startsWith('javascript:')) {
          try {
            let absoluteUrl;
            if (url.startsWith('//')) {
              absoluteUrl = new URL(targetUrl).protocol + url;
            } else {
              absoluteUrl = new URL(url, targetUrl).href;
            }
            
            if (absoluteUrl.startsWith('http')) {
              const encodedUrl = encodeUrl(absoluteUrl);
              return `${proxyBaseUrl}/go?url=${encodedUrl} ${descriptor || ''}`.trim();
            }
          } catch (e) {
            console.error('Error rewriting srcset URL:', e);
          }
        }
        return part;
      }).join(', ');
      
      element.setAttribute('srcset', newSrcset);
    }
  });

  // Handle inline styles with URLs (background images, etc.)
  document.querySelectorAll('*[style]').forEach(element => {
    const style = element.getAttribute('style');
    const newStyle = style.replace(/url\(['"]?(.*?)['"]?\)/gi, (match, url) => {
      if (url && !url.startsWith('data:') && !url.startsWith('javascript:')) {
        try {
          let absoluteUrl;
          if (url.startsWith('//')) {
            absoluteUrl = new URL(targetUrl).protocol + url;
          } else {
            absoluteUrl = new URL(url, targetUrl).href;
          }
          
          if (absoluteUrl.startsWith('http')) {
            const encodedUrl = encodeUrl(absoluteUrl);
            return `url('${proxyBaseUrl}/go?url=${encodedUrl}')`;
          }
        } catch (e) {
          console.error('Error rewriting style URL:', e);
        }
      }
      return match;
    });
    element.setAttribute('style', newStyle);
  });

  // Handle meta tags with URLs
  document.querySelectorAll('meta[content]').forEach(meta => {
    const content = meta.getAttribute('content');
    if (content && (content.startsWith('http://') || content.startsWith('https://'))) {
      try {
        let absoluteUrl;
        if (content.startsWith('//')) {
          absoluteUrl = new URL(targetUrl).protocol + content;
        } else {
          absoluteUrl = new URL(content, targetUrl).href;
        }
        
        if (absoluteUrl.startsWith('http')) {
          const encodedUrl = encodeUrl(absoluteUrl);
          meta.setAttribute('content', `${proxyBaseUrl}/go?url=${encodedUrl}`);
        }
      } catch (e) {
        console.error('Error rewriting meta content URL:', e);
      }
    }
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    cacheSize: cache.size
  });
});

// Proxy route - main functionality
app.get('/go', async (req, res) => {
  const encoded = req.query.url;
  let targetUrl;

  try {
    if (!encoded) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    targetUrl = decodeUrl(encoded);
    console.log(`🔍 Decoded target URL: ${targetUrl}`);
    
    if (!isValidUrl(targetUrl)) {
      return res.status(400).json({ error: 'Invalid target URL' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Malformed URL', details: err.message });
  }

  // Define cacheKey here, after we have the encoded value
  const cacheKey = `get:${encoded}`;
  
  // Check cache first
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`💾 Serving from cache: ${cached.targetUrl}`);
      res.set(cached.headers);
      return res.send(cached.body);
    }
    cache.delete(cacheKey);
  }

  console.log(`🌐 Fetching: ${targetUrl}`);
  
  try {
    const response = await fetchWithRetry(targetUrl, {}, 2, 10000);
    
    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Upstream error: ${response.status} ${response.statusText}` 
      });
    }
    
    const contentType = response.headers.get('content-type') || '';
    const contentLength = response.headers.get('content-length');
    
    // Handle non-HTML content (images, videos, etc.)
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      console.log(`📦 Serving non-HTML content: ${contentType}`);
      
      // Set appropriate headers
      res.set('Content-Type', contentType);
      
      // Set caching headers for media
      if (contentType.startsWith('image/') || 
          contentType.startsWith('video/') || 
          contentType.startsWith('audio/') ||
          contentType.startsWith('font/')) {
        res.set('Cache-Control', 'public, max-age=3600');
      }
      
      // Handle content length if available
      if (contentLength) {
        res.set('Content-Length', contentLength);
      }
      
      // Stream the response directly to the client
      response.body.pipe(res);
      return;
    }

    // Handle HTML content
    let html = await response.text();
    const dom = new JSDOM(html);
    const { document } = dom.window;

    // Remove CSP headers that might block resources
    document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(el => el.remove());

    // Add base tag for proper relative URL resolution
    const base = document.createElement('base');
    base.href = targetUrl;
    document.head.prepend(base);

    // Enhanced URL rewriting for all resources
    rewriteResourceUrls(document, targetUrl, PROXY_BASE_URL);

    // Enhanced script handling
    document.querySelectorAll('script[src]').forEach(el => {
      const src = el.getAttribute('src');
      if (src && !src.startsWith('data:')) {
        try {
          let absoluteUrl;
          if (src.startsWith('//')) {
            absoluteUrl = new URL(targetUrl).protocol + src;
          } else {
            absoluteUrl = new URL(src, targetUrl).href;
          }
          
          if (absoluteUrl.startsWith('http')) {
            const encodedUrl = encodeUrl(absoluteUrl);
            const script = document.createElement('script');
            script.textContent = `
              (function() {
                var script = document.createElement('script');
                script.src = '${PROXY_BASE_URL}/go?url=${encodedUrl}';
                document.head.appendChild(script);
              })();
            `;
            el.replaceWith(script);
          }
        } catch (e) {
          console.error('Error rewriting script src:', e);
        }
      }
    });

    // Enhanced client-side JavaScript for navigation
    const clientPatch = document.createElement('script');
    clientPatch.textContent = `
(function() {
  const encode = (url) => {
    try {
      return btoa(new URL(url, document.baseURI).href);
    } catch (e) {
      console.error('Error encoding URL:', e);
      return '';
    }
  };

  const proxy = (url) => '${PROXY_BASE_URL}/go?url=' + encode(url);

  // Intercept anchor clicks
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (a && a.href) {
      e.preventDefault();
      const proxied = proxy(a.href);
      window.location.href = proxied;
    }
  });

  // Intercept form submissions
  document.addEventListener('submit', e => {
    const form = e.target;
    const method = (form.getAttribute('method') || 'get').toLowerCase();
    
    if (method === 'get') {
      e.preventDefault();
      const action = form.getAttribute('action') || location.href;
      const params = new URLSearchParams(new FormData(form)).toString();
      const fullUrl = action.includes('?') ? action + '&' + params : action + '?' + params;
      window.location.href = proxy(fullUrl);
    }
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
  Object.defineProperty(window.location, 'href', {
    set: function(url) {
      window.location.assign(url);
    },
    configurable: true
  });

  const origAssign = window.location.assign;
  window.location.assign = function(url) {
    origAssign.call(window.location, proxy(url));
  };

  // Monkeypatch location.replace
  const origReplace = window.location.replace;
  window.location.replace = function(url) {
    origReplace.call(window.location, proxy(url));
  };

  const messageHandler = (event) => {
    // Optional: check origin for security
    // if (event.origin !== "https://your-allowed-domain.com") return;
  
    if (event.data && event.data.type === "EXEC_SCRIPT") {
      try {
        // Safely evaluate the script string sent from parent
        // Note: using new Function is safer than eval for isolation
        new Function(event.data.code)();
      } catch (err) {
        console.error("Script execution error:", err);
      }
    }
  };
  
  window.addEventListener("message", messageHandler, false);
})();
    `;
    document.body.appendChild(clientPatch);

    // Cache the response
    const responseHtml = dom.serialize();
    manageCacheSize();
    cache.set(cacheKey, {
      targetUrl,
      headers: { 'Content-Type': 'text/html' },
      body: responseHtml,
      timestamp: Date.now()
    });

    // Return the modified HTML
    res.set('Content-Type', 'text/html');
    res.send(responseHtml);

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ 
      error: 'Proxy error', 
      message: err.message,
      details: 'Failed to fetch or process the requested URL'
    });
  }
});

// Additional endpoint for POST requests
app.post('/go', async (req, res) => {
  const encoded = req.query.url;
  let targetUrl;

  try {
    if (!encoded) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    targetUrl = decodeUrl(encoded);
    
    if (!isValidUrl(targetUrl)) {
      return res.status(400).json({ error: 'Invalid target URL' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Malformed URL', details: err.message });
  }

  try {
    const response = await fetchWithRetry(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...req.headers
      },
      body: new URLSearchParams(req.body).toString()
    }, 2, 10000);

    // Handle the response
    const contentType = response.headers.get('content-type') || '';
    
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      res.set('Content-Type', contentType);
      response.body.pipe(res);
      return;
    }

    let html = await response.text();
    const dom = new JSDOM(html);
    const { document } = dom.window;

    // Apply the same transformations as in the GET endpoint
    document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(el => el.remove());

    const base = document.createElement('base');
    base.href = targetUrl;
    document.head.prepend(base);

    // Enhanced URL rewriting for all resources
    rewriteResourceUrls(document, targetUrl, PROXY_BASE_URL);

    // Add the client patch script
    const clientPatch = document.createElement('script');
    clientPatch.textContent = `
      // Client patch code
      (function() {
        const encode = (url) => {
          try {
            return btoa(new URL(url, document.baseURI).href);
          } catch (e) {
            console.error('Error encoding URL:', e);
            return '';
          }
        };
        const proxy = (url) => '${PROXY_BASE_URL}/go?url=' + encode(url);
        // ... rest of the client code
      })();
    `;
    document.body.appendChild(clientPatch);

    res.set('Content-Type', 'text/html');
    res.send(dom.serialize());

  } catch (err) {
    console.error('POST Proxy error:', err);
    res.status(500).json({ 
      error: 'Proxy error', 
      message: err.message 
    });
  }
});

// Simple stats endpoint
app.get('/stats', (req, res) => {
  res.json({
    cacheSize: cache.size,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Clear cache endpoint
app.post('/clear-cache', (req, res) => {
  const previousSize = cache.size;
  cache.clear();
  res.json({
    message: 'Cache cleared',
    previousSize,
    currentSize: cache.size
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Enhanced proxy server running on port ${PORT}`);
  console.log(`📊 Health check available at http://localhost:${PORT}/health`);
  console.log(`🌐 Proxy base URL: ${PROXY_BASE_URL}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down proxy server gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully');
  process.exit(0);
});
