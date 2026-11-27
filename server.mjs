import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Never expose repo internals.
const BLOCKED = /^\/(\.git|node_modules|supabase|tests|tools|edge\/wrangler\.toml$|package(-lock)?\.json$|server\.mjs$)/;
app.use((req, res, next) => (BLOCKED.test(req.path) ? res.status(404).end() : next()));

// Rights headers on every response (same signals the edge worker adds).
app.use((_req, res, next) => {
  res.set({
    'X-Robots-Tag': 'noai, noimageai',
    'tdm-reservation': '1',
    'tdm-policy': '/ai.txt',
    Link: '</ai.txt>; rel="license"',
  });
  next();
});

// Static app files: shield.js, app/*.js, robots.txt, ai.txt, llms.txt, .well-known/tdmrep.json, sw.js
app.use(express.static(__dirname, { dotfiles: 'allow', index: 'index.html', extensions: false }));

// SPA fallback: hash routes live in index.html; unknown files 404.
app.get('*', (req, res) => {
  if (req.path.includes('.')) return res.status(404).end();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
