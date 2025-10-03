const axios = require('axios');
const cheerio = require('cheerio');
const ytdl = require('ytdl-core');
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

  
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (a && a.href) {
      e.preventDefault();
      const proxied = proxy(a.href);
      window.location.href = proxied;
    }
  });

  
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

  
  const origOpen = window.open;
  window.open = function(url, ...args) {
    try {
      return origOpen.call(window, proxy(url), ...args);
    } catch {
      return origOpen.call(window, url, ...args);
    }
  };

  const origAssign = window.location.assign;
  window.location.assign = function(url) {
    origAssign.call(window.location, proxy(url));
  };

  
  const origReplace = window.location.replace;
  window.location.replace = function(url) {
    origReplace.call(window.location, proxy(url));
  };

  const messageHandler = (event) => {
    
  
    if (event.data && event.data.type === "EXEC_SCRIPT") {
      try {
        
        eval(event.data.code);
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
  
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (a && a.href) {
      e.preventDefault();
      const proxied = proxy(a.href);
      window.location.href = proxied;
    }
  });
  
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
  
  const origOpen = window.open;
  window.open = function(url, ...args) {
    try {
      return origOpen.call(window, proxy(url), ...args);
    } catch {
      return origOpen.call(window, url, ...args);
    }
  };

  const origAssign = window.location.assign;
  window.location.assign = function(url) {
    origAssign.call(window.location, proxy(url));
  };

  const origReplace = window.location.replace;
  window.location.replace = function(url) {
    origReplace.call(window.location, proxy(url));
  };

  const messageHandler = (event) => {
    if (event.data && event.data.type === "EXEC_SCRIPT") {
      try {
        eval(event.data.code);
      } catch (err) {
        console.error("Script execution error:", err);
      }
    }
  };
  
  window.addEventListener("message", messageHandler, false);
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

// YouTube downloader endpoint
app.get('/youtube/download', async (req, res) => {
  const videoUrl = req.query.url;
  const quality = req.query.quality || 'highest';
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  try {
    // Validate YouTube URL
    if (!ytdl.validateURL(videoUrl)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    console.log(`📥 YouTube download request: ${videoUrl}`);
    
    // Get video info
    const info = await ytdl.getInfo(videoUrl);
    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9 ]/g, '_');
    
    // Set headers for download
    res.header('Content-Disposition', `attachment; filename="${title}.mp4"`);
    res.header('Content-Type', 'video/mp4');
    
    // Stream the video
    ytdl(videoUrl, {
      quality: quality,
      filter: format => format.container === 'mp4'
    }).pipe(res);
    
  } catch (err) {
    console.error('YouTube download error:', err);
    res.status(500).json({ 
      error: 'Failed to download YouTube video',
      message: err.message 
    });
  }
});

// YouTube info endpoint
app.get('/youtube/info', async (req, res) => {
  const videoUrl = req.query.url;
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  try {
    if (!ytdl.validateURL(videoUrl)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(videoUrl);
    
    res.json({
      success: true,
      title: info.videoDetails.title,
      duration: info.videoDetails.lengthSeconds,
      thumbnail: info.videoDetails.thumbnails[0].url,
      formats: info.formats
        .filter(format => format.hasVideo && format.hasAudio)
        .map(format => ({
          quality: format.qualityLabel,
          container: format.container,
          url: `${PROXY_BASE_URL}/youtube/download?url=${encodeURIComponent(videoUrl)}&quality=${format.qualityLabel}`
        }))
    });
    
  } catch (err) {
    console.error('YouTube info error:', err);
    res.status(500).json({ 
      error: 'Failed to get YouTube video info',
      message: err.message 
    });
  }
});

// YouTube channel videos endpoint
app.get('/youtube/channel/videos', async (req, res) => {
  const channelUrl = req.query.url;
  
  if (!channelUrl) {
    return res.status(400).json({ error: 'YouTube channel URL is required' });
  }

  try {
    console.log(`📺 Fetching YouTube channel videos: ${channelUrl}`);
    
    // Normalize channel URL
    let fetchUrl = channelUrl;
    if (channelUrl.includes('@')) {
      // Handle @username format
      fetchUrl = `https://www.youtube.com/${channelUrl}/videos`;
    } else if (channelUrl.includes('/channel/')) {
      // Handle channel ID format
      fetchUrl = `${channelUrl}/videos`;
    } else if (!channelUrl.includes('/videos')) {
      // Assume it's a channel URL and append /videos
      fetchUrl = `${channelUrl}/videos`;
    }

    // Fetch the channel page
    const response = await axios.get(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Extract video data from the page
    const videos = [];
    
    // Method 1: Look for video links in the page
    $('a[href*="/watch?v="]').each((index, element) => {
      const href = $(element).attr('href');
      const title = $(element).attr('title') || $(element).text().trim();
      
      if (href && title && !href.includes('&list=') && title.length > 0) {
        const videoId = href.split('v=')[1]?.split('&')[0];
        if (videoId && videoId.length === 11) {
          const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
          
          // Avoid duplicates
          if (!videos.find(v => v.id === videoId)) {
            videos.push({
              id: videoId,
              title: title,
              url: videoUrl,
              proxyUrl: `${PROXY_BASE_URL}/go?url=${encodeUrl(videoUrl)}`
            });
          }
        }
      }
    });

    // Method 2: Look for video data in script tags (more reliable)
    const scriptContents = $('script').map((i, el) => $(el).html()).get();
    const ytInitialDataScript = scriptContents.find(script => 
      script.includes('ytInitialData') && script.includes('videoId')
    );

    if (ytInitialDataScript) {
      try {
        const jsonMatch = ytInitialDataScript.match(/ytInitialData\s*=\s*({.*?});/);
        if (jsonMatch) {
          const ytData = JSON.parse(jsonMatch[1]);
          
          // Extract videos from the complex YouTube data structure
          const extractVideosFromData = (data) => {
            const foundVideos = [];
            
            if (data && typeof data === 'object') {
              // Look for video objects in various possible locations
              if (data.videoId && data.title) {
                foundVideos.push({
                  id: data.videoId,
                  title: data.title.simpleText || data.title.runs?.[0]?.text || 'Unknown Title',
                  url: `https://www.youtube.com/watch?v=${data.videoId}`,
                  proxyUrl: `${PROXY_BASE_URL}/go?url=${encodeUrl(`https://www.youtube.com/watch?v=${data.videoId}`)}`
                });
              }
              
              // Recursively search through object properties
              for (const key in data) {
                if (data[key] && typeof data[key] === 'object') {
                  foundVideos.push(...extractVideosFromData(data[key]));
                }
              }
            }
            
            return foundVideos;
          };
          
          const extractedVideos = extractVideosFromData(ytData);
          extractedVideos.forEach(video => {
            if (!videos.find(v => v.id === video.id)) {
              videos.push(video);
            }
          });
        }
      } catch (parseError) {
        console.error('Error parsing YouTube data:', parseError);
      }
    }

    // Remove duplicates and limit results
    const uniqueVideos = [...new Map(videos.map(v => [v.id, v])).values()]
      .slice(0, 50); // Limit to 50 videos

    if (uniqueVideos.length === 0) {
      return res.status(404).send(`
        <html>
          <head><title>No Videos Found</title></head>
          <body>
            <h1>No videos found for this channel</h1>
            <p>The channel might be private, have no videos, or YouTube's structure has changed.</p>
          </body>
        </html>
      `);
    }

    // Generate HTML list
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>YouTube Channel Videos</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
            .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #ff0000; border-bottom: 2px solid #ff0000; padding-bottom: 10px; }
            .video-list { list-style: none; padding: 0; }
            .video-item { padding: 15px; border-bottom: 1px solid #eee; margin-bottom: 10px; }
            .video-item:hover { background: #f9f9f9; }
            .video-link { text-decoration: none; color: #0066cc; font-size: 16px; font-weight: bold; }
            .video-link:hover { color: #ff0000; text-decoration: underline; }
            .video-id { color: #666; font-size: 12px; margin-top: 5px; }
            .count { background: #ff0000; color: white; padding: 2px 8px; border-radius: 12px; font-size: 14px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>YouTube Channel Videos <span class="count">${uniqueVideos.length}</span></h1>
            <ul class="video-list">
                ${uniqueVideos.map(video => `
                    <li class="video-item">
                        <a href="${video.proxyUrl}" class="video-link" target="_blank">
                            ${video.title}
                        </a>
                        <div class="video-id">Video ID: ${video.id}</div>
                    </li>
                `).join('')}
            </ul>
        </div>
    </body>
    </html>
    `;

    res.set('Content-Type', 'text/html');
    res.send(html);

  } catch (err) {
    console.error('YouTube channel videos error:', err);
    
    const errorHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Error</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .error { color: #d32f2f; background: #ffebee; padding: 15px; border-radius: 4px; border-left: 4px solid #d32f2f; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Error Fetching Channel Videos</h1>
            <div class="error">
                <strong>Error:</strong> ${err.message}<br>
                <strong>Possible reasons:</strong>
                <ul>
                    <li>Channel is private or doesn't exist</li>
                    <li>YouTube changed their page structure</li>
                    <li>Network connection issue</li>
                </ul>
            </div>
        </div>
    </body>
    </html>
    `;
    
    res.status(500).send(errorHtml);
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
