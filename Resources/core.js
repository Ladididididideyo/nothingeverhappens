document.getElementById('cloneTabBtn').addEventListener('click', () => {
    const html = document.documentElement.outerHTML;
    const cloneWindow = window.open('about:blank', '_blank');

    if (!cloneWindow) {
        console.log("❌ Popup blocked or failed to open new tab.");
        return;
    }

    cloneWindow.document.open();
    cloneWindow.document.write(html);
    cloneWindow.document.close();

    console.log("🪞 Cloned frontend to new tab.");
});

// Logs messages inside the page console panel
function customLog(...args) {
    const consoleDiv = document.getElementById("console");
    const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    consoleDiv.textContent += message + '\n';
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
}

// Override console.log to output to our custom consoleDiv
if (!window.__consoleOverridden__) {
    window.__consoleOverridden__ = true;
    const originalConsoleLog = console.log;
    console.log = function (...args) {
        originalConsoleLog(...args);
        customLog(...args);
    };
}

console.log("🟢 Console initialized successfully.");

// Base64 encode URL for backend /rendered?target= param
function base64Encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
}

// Load a proxied page inside iframe
async function loadPage(directUrl) {
    const url = directUrl || document.getElementById('urlInput').value.trim();
    const iframe = document.getElementById('proxyFrame');
    const errorDiv = document.getElementById('error');
    errorDiv.textContent = "";
    document.getElementById("cssOutput").textContent = "/* CSS will appear here */";

    if (!url.startsWith("http")) {
        errorDiv.textContent = "Please enter a valid URL (starting with http or https)";
        return;
    }

    try {
        const encodedUrl = base64Encode(url);
        iframe.src = `https://nothingeverhappens.onrender.com/rendered?target=${encodedUrl}`;
        console.log(`✅ Page rendered in iframe for URL: ${url}`);
    } catch (err) {
        console.log("❌ Error loading page:", err.message);
        errorDiv.textContent = "Error loading page: " + err.message;
    }
}

// Optional: Intercept link clicks inside iframe and route them through your proxy
// Note: This requires the iframe and parent to be same-origin or use postMessage messaging.
// If your iframe content is proxied HTML (and you control backend),
// you can inject a script on backend to post messages on link clicks,
// or inject this listener on the client side if possible:
//
// This is tricky with cross-origin iframes, so better handle on backend.

// Listen for navigation messages from iframe (sent via postMessage by your backend-injected script)
window.addEventListener('message', (event) => {
    if (event.data ? .type === 'link-click' && event.data.url) {
        console.log(`🔗 Link clicked inside iframe: ${event.data.url}`);
        document.getElementById('urlInput').value = event.data.url;
        loadPage(event.data.url);
    } else if (event.data ? .type === 'navigate' && event.data.url) {
        console.log(`🧭 Script-triggered navigation: ${event.data.url}`);
        document.getElementById('urlInput').value = event.data.url;
        loadPage(event.data.url);
    }
});

// Run custom JS input by user (eval with caution!)
document.getElementById('runJsBtn').addEventListener('click', () => {
    const code = document.getElementById('jsInput').value;
    if (!code.trim()) {
        console.log("⚠️ No JavaScript code to execute.");
        return;
    }
    try {
        const result = eval(code);
        console.log("▶️ JS Result:", result);
    } catch (err) {
        console.log("❌ JS Error:", err.message);
    }
});

// Optional: Auto-load from URL input on pressing Enter
document.getElementById('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        loadPage();
    }
});

// === Aspect Ratio Switcher ===
const ratios = [{
        label: "16 : 9",
        w: 16,
        h: 9
    },
    {
        label: "4 : 3",
        w: 4,
        h: 3
    },
    {
        label: "1 : 1",
        w: 1,
        h: 1
    },
    {
        label: "21 : 9",
        w: 21,
        h: 9
    },
];
let ratioIdx = 0;

const iframe = document.getElementById("proxyFrame");
const ratioBtn = document.getElementById("ratioBtn");

function applyRatio() {
    const {
        w,
        h,
        label
    } = ratios[ratioIdx];
    const widthPx = iframe.clientWidth;
    iframe.style.height = (widthPx * h / w) + "px";
    ratioBtn.textContent = "Aspect ratio: " + label;
}

// Cycle ratio on click
ratioBtn.addEventListener("click", () => {
    ratioIdx = (ratioIdx + 1) % ratios.length;
    applyRatio();
});

// Reapply ratio when window resizes
window.addEventListener("resize", applyRatio);

// Initial ratio setup
applyRatio();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js')
            .then(reg => console.log('✅ Service Worker registered:', reg.scope))
            .catch(err => console.error('❌ Service Worker registration failed:', err));
    });
}