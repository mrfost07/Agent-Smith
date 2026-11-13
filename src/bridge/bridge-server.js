/**
 * Standalone Antigravity Local Bridge Server
 * Runs a local HTTP bridge on port 51121 for browser extensions.
 * Provides:
 *  - Multimodal Gemini 3.8 / 2.5 Flash agent planning
 *  - Automated Resume Tailoring & PDF Generation via Headless Chrome
 *  - Direct file access to Desktop/Resume
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { timingSafeEqual } = require('crypto');
const runFile = promisify(execFile);

const PORT = Number(process.env.PORT ?? 51121);
const token = process.env.SMITH_BRIDGE_TOKEN;
if (!token || token.length < 32) {
  console.error('Set SMITH_BRIDGE_TOKEN to a random token of at least 32 characters.');
  process.exit(1);
}
const expectedAuthorization = Buffer.from('Bearer ' + token);

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, character => entities[character]);
}
const localConfigPath = path.resolve(__dirname, '../../.smith.local.json');
const resumeConfig = fs.existsSync(localConfigPath)
  ? JSON.parse(fs.readFileSync(localConfigPath, 'utf8')).resume ?? {}
  : {};
const BASE_RESUME_PATH = resumeConfig.source ?? path.resolve('resume.txt');
const TAILORED_DIR = resumeConfig.output ?? path.resolve('tailored');
const CHROME_PATH = process.env.SMITH_CHROME_PATH ?? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');

const server = http.createServer(async (req, res) => {
  // 0. Google OAuth Loopback Callback Handler
  if (req.url && req.url.startsWith('/oauth-callback') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Connected to Antigravity</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .box { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 32px; text-align: center; max-width: 400px; }
    h2 { margin: 0 0 10px 0; font-size: 18px; color: #47cd89; }
    p { color: #a1a1aa; font-size: 14px; margin: 0 0 20px 0; }
    button { background: #fafafa; color: #0a0a0b; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; }
  </style>
</head>
<body>
  <div class="box">
    <h2>✓ Connected to Google Antigravity</h2>
    <p>Sign-in complete. You can close this tab and return to the extension.</p>
    <button onclick="window.close()">Close tab</button>
  </div>
</body>
</html>`);
    return;
  }

  const provided = Buffer.from(req.headers.authorization || '');
  if (provided.length !== expectedAuthorization.length || !timingSafeEqual(provided, expectedAuthorization)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'A valid bridge token is required.' }));
    return;
  }

  // 1. Health Status
  if (req.url === '/v1/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      provider: 'antigravity-bridge',
      supportedModels: ['gemini-3.8-flash-tiered', 'gemini-2.5-flash', 'gemini-pro-agent'],
      resumeBaseLoaded: fs.existsSync(BASE_RESUME_PATH),
    }));
    return;
  }

  // 2. Base Resume Content
  if (req.url === '/v1/resume/base' && req.method === 'GET') {
    if (fs.existsSync(BASE_RESUME_PATH)) {
      const text = fs.readFileSync(BASE_RESUME_PATH, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, text }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Base resume file not found.' }));
    }
    return;
  }

  // 3. Multimodal Agent Planning Endpoint
  if (req.url === '/v1/agent/plan' && req.method === 'POST') {
    try {
      const payload = await readBody(req);
      const { systemPrompt, userPrompt, screenshotBase64, model } = payload;

      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        const geminiModel = model && model.includes('2.5') ? 'gemini-2.5-flash' : 'gemini-2.5-flash';
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

        const parts = [{ text: `${systemPrompt}\n\n${userPrompt}` }];
        if (screenshotBase64) {
          const cleanBase64 = screenshotBase64.replace(/^data:image\/[a-z]+;base64,/, '');
          parts.unshift({
            inlineData: {
              mimeType: 'image/jpeg',
              data: cleanBase64,
            },
          });
        }

        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: 0.15,
              maxOutputTokens: 1024,
            },
          }),
        });

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
        return;
      }

      const agyPath = process.env.SMITH_AGY_PATH ?? (process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'));
      if (agyPath && fs.existsSync(agyPath)) {
        const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
        try {
          const { stdout } = await runFile(agyPath, ['-p', fullPrompt], {
            encoding: 'utf-8',
            maxBuffer: 20 * 1024 * 1024,
            timeout: 60000,
            windowsHide: true,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: stdout.trim() }));
          return;
        } catch (e) {
          console.error('[Bridge] agy CLI execution error:', e.message);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'No active Antigravity session or GEMINI_API_KEY found.',
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 4. Resume Tailoring & PDF Generation Endpoint
  if (req.url === '/v1/resume/tailor' && req.method === 'POST') {
    try {
      const payload = await readBody(req);
      const jobTitle = String(payload.jobTitle || 'Developer').slice(0, 120);
      const company = String(payload.company || 'Client').slice(0, 160);
      const requirements = String(payload.requirements || '').slice(0, 100);
      console.log(`[Bridge] Tailoring resume for role: "${jobTitle}" at "${company || 'Company'}"...`);

      const safeJobTitle = (jobTitle || 'Developer').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
      const timestamp = Date.now();
      const htmlFileName = `resume_${safeJobTitle}_${timestamp}.html`;
      const pdfFileName = `Mark_Renier_Fostanes_${safeJobTitle}_${timestamp}.pdf`;
      const htmlFilePath = path.join(TAILORED_DIR, htmlFileName);
      const pdfFilePath = path.join(TAILORED_DIR, pdfFileName);

      // Generate customized HTML resume
      const htmlContent = generateResumeHTML({
        jobTitle: jobTitle || 'Full-Stack Developer',
        company: company || 'Client',
        requirements: requirements || '',
      });

      await fs.promises.mkdir(TAILORED_DIR, { recursive: true });
      await fs.promises.writeFile(htmlFilePath, htmlContent, 'utf-8');

      // Compile to PDF using Headless Chrome
      try {
        await runFile(CHROME_PATH, [
          '--headless', '--disable-gpu', '--no-pdf-header-footer',
          '--print-to-pdf=' + pdfFilePath, htmlFilePath,
        ], { timeout: 20_000, windowsHide: true });
      } finally {
        await fs.promises.unlink(htmlFilePath).catch(() => {});
      }
      console.log(`[Bridge] Successfully compiled tailored PDF: ${pdfFilePath}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        filePath: pdfFilePath,
        fileName: pdfFileName,
      }));
    } catch (err) {
      console.error('[Bridge] Failed to tailor resume:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

/**
 * Builds an ATS-compliant, executive-styled HTML resume for Mark Renier Fostanes.
 */
function generateResumeHTML(params) {
  const jobTitle = escapeHtml(params.jobTitle);
  const company = escapeHtml(params.company);
  const requirements = escapeHtml(params.requirements);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Mark Renier Fostanes - Resume</title>
  <style>
    @page { size: A4; margin: 15mm; }
    body {
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      margin: 0;
      padding: 0;
      line-height: 1.5;
      font-size: 13px;
    }
    .header {
      border-bottom: 2px solid #2563eb;
      padding-bottom: 12px;
      margin-bottom: 14px;
    }
    .name {
      font-size: 24px;
      font-weight: 800;
      color: #0f172a;
      letter-spacing: -0.5px;
      margin: 0;
      text-transform: uppercase;
    }
    .role-title {
      font-size: 14px;
      font-weight: 600;
      color: #2563eb;
      margin-top: 2px;
    }
    .contact-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 11.5px;
      color: #475569;
      margin-top: 6px;
    }
    .contact-item { display: inline-flex; align-items: center; }
    .section { margin-bottom: 14px; }
    .section-title {
      font-size: 12.5px;
      font-weight: 700;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 3px;
      margin-bottom: 8px;
    }
    .summary-text { color: #334155; font-size: 12.5px; line-height: 1.55; }
    .item { margin-bottom: 10px; }
    .item-header {
      display: flex;
      justify-content: space-between;
      font-weight: 700;
      color: #0f172a;
      font-size: 13px;
    }
    .item-sub {
      display: flex;
      justify-content: space-between;
      color: #2563eb;
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 4px;
    }
    ul { margin: 4px 0 0 16px; padding: 0; }
    li { margin-bottom: 3px; color: #334155; font-size: 12px; }
    .skills-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
      font-size: 12px;
    }
    .skill-cat { font-weight: 600; color: #0f172a; }
  </style>
</head>
<body>
  <div class="header">
    <div class="name">Mark Renier Fostanes</div>
    <div class="role-title">Software Engineer | ${jobTitle}</div>
    <div class="contact-bar">
      ${resumeConfig.email ? `<span class="contact-item">${escapeHtml(resumeConfig.email)}</span>` : ''}
      ${resumeConfig.phone ? `<span class="contact-item">${escapeHtml(resumeConfig.phone)}</span>` : ''}
      <span class="contact-item">🌐 https://fostanes.me/</span>
      <span class="contact-item">📍 Surigao del Norte, Philippines</span>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Professional Summary</div>
    <div class="summary-text">
      Results-driven Software Engineer and Full-Stack Developer with hands-on experience architecting scalable backend APIs, high-performance web applications, and AI-driven automation workflows. Proven track record delivering robust platforms including the Aidhub AI impact platform, Kurvada POS, and production e-commerce applications. Dedicated to building reliable, secure, and user-centric systems tailored specifically to the requirements of <b>${company}</b> for the <b>${jobTitle}</b> role.
    </div>
  </div>

  <div class="section">
    <div class="section-title">Key Projects & Achievements</div>

    <div class="item">
      <div class="item-header">
        <span>Aidhub Platform & Optimization Engine</span>
        <span>AppCon National Competition</span>
      </div>
      <div class="item-sub">
        <span>Backend Architecture & AI/ML Engineer</span>
        <span>2024</span>
      </div>
      <ul>
        <li>Architected backend APIs using Django REST Framework and Python AI/ML algorithms for optimal donor-recipient matching and automated fraud detection.</li>
        <li>Implemented high-concurrency database queries with PostgreSQL and real-time event notifications.</li>
        <li>Designed modular, secure endpoints following OWASP standards and RESTful architectural principles.</li>
      </ul>
    </div>

    <div class="item">
      <div class="item-header">
        <span>Kurvada Restaurant POS System</span>
        <span>Freelance Project</span>
      </div>
      <div class="item-sub">
        <span>Full-Stack Engineer</span>
        <span>2025</span>
      </div>
      <ul>
        <li>Engineered a cloud-synced point-of-sale platform featuring real-time order processing, customizable menus, receipt generation, and offline sync using React, TypeScript, Vite, and Zustand.</li>
        <li>Built resilient client-side state management ensuring 100% operational uptime during connectivity dips.</li>
      </ul>
    </div>

    <div class="item">
      <div class="item-header">
        <span>Restaurant E-Commerce & Motor Shop Platforms</span>
        <span>Production Client Deployments</span>
      </div>
      <div class="item-sub">
        <span>Full-Stack Web Developer</span>
        <span>2025</span>
      </div>
      <ul>
        <li>Delivered React/Django e-commerce application handling 50+ daily transactions with automated Stripe checkout, achieving 60% faster order processing.</li>
        <li>Deployed production web services across AWS and Netlify with automated CI/CD and SSL/TLS hardening.</li>
      </ul>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Technical Proficiencies</div>
    <div class="skills-grid">
      <div><span class="skill-cat">Languages & Frameworks:</span> Python (Django, FastAPI), TypeScript, JavaScript (ES6+), React.js, React Native, Node.js</div>
      <div><span class="skill-cat">Databases & State:</span> PostgreSQL, MongoDB, Redis, Zustand, Redux</div>
      <div><span class="skill-cat">Cloud & DevOps:</span> AWS (S3, EC2), Netlify, Docker, Git, RESTful APIs, JWT / RBAC</div>
      <div><span class="skill-cat">Role Focus:</span> ${requirements ? requirements.slice(0, 100) : 'Full-stack application development, API design, automation'}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Education</div>
    <div class="item">
      <div class="item-header">
        <span>Surigao del Norte State University</span>
        <span>Surigao, Philippines</span>
      </div>
      <div class="item-sub">
        <span>Bachelor of Science in Computer Science</span>
        <span>Class of 2027</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}

server.requestTimeout = 30_000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Antigravity Bridge] Listening on http://127.0.0.1:${server.address().port}`);
  console.log(`[Antigravity Bridge] Ready to generate tailored PDF resumes to: ${TAILORED_DIR}`);
});
