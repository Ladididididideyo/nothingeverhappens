// service-worker.js

const allowedHost = self.location.hostname; // e.g. "subdomain.example.com"

self.addEventListener('install', event => {
  // Activate immediately
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  // Claim clients immediately
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Allow if request is to the same origin (your subdomain)
  const isAllowed = url.hostname === allowedHost;

  if (isAllowed) {
    // Allow normal fetch for same origin
    event.respondWith(fetch(event.request));
  } else {
    // Block requests to external domains by returning 403 response
    event.respondWith(
      new Response('Blocked by Service Worker: External requests disallowed.', {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Content-Type': 'text/plain' },
      })
    );
  }
});
