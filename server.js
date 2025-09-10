const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = 3000;

// Body parser with increased limit for large PNGs
app.use(express.json({ limit: '50mb', type: 'application/json' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

// Save image from data URL to disk
app.post('/api/save-image', (req, res) => {
  try {
    const { objectId, filename, dataUrl } = req.body || {};
    const hasObjectId = !(objectId === undefined || objectId === null);
    const hasFilename = typeof filename === 'string' && filename.length > 0;
    const hasDataUrl = typeof dataUrl === 'string' && dataUrl.length > 0;
    if (!hasObjectId || !hasFilename || !hasDataUrl) {
      return res.status(400).json({ ok: false, error: 'Missing objectId, filename, or dataUrl' });
    }
    const safeObjectId = String(objectId).replace(/[^0-9a-zA-Z_-]/g, '');
    let safeFilename = String(filename).replace(/[^0-9a-zA-Z_.-]/g, '');
    if (!safeFilename.endsWith('.png')) safeFilename += '.png';
    const dir = path.join(__dirname, 'public', 'images', safeObjectId);
    const filePath = path.join(dir, safeFilename);
    const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl);
    if (!m) return res.status(400).json({ ok: false, error: 'Invalid dataUrl' });
    const buffer = Buffer.from(m[2], 'base64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buffer);
    const publicPath = `/images/${safeObjectId}/${safeFilename}`;
    return res.json({ ok: true, path: publicPath });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Failed to save image' });
  }
});

// Generic error handler to ensure JSON responses
// Includes payload too large and JSON parse errors
app.use((err, req, res, next) => {
  console.error('Server error:', err && err.stack ? err.stack : err);
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ ok: false, error: 'Payload too large' });
  }
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }
  return res.status(500).json({ ok: false, error: 'Internal server error' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${port}`);
});
