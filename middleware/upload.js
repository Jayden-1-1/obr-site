const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { UPLOAD_DIR } = require('../db');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    try {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch (_) {}
    const safeBase = path.basename(file.originalname || 'file');
    const ext = path.extname(safeBase).slice(0, 12).toLowerCase();
    cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
});

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.zip': 'application/zip',
};

const AVATAR_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/**
 * Sets Content-Disposition header with RFC 5987 compliant UTF-8 encoding
 * to prevent Node.js ERR_INVALID_CHAR crashes with Cyrillic/Russian file names.
 */
function setContentDisposition(res, dispositionType, filename) {
  const cleanName = path.basename(filename || 'file').replace(/[\r\n\0]/g, '');
  const asciiFallback = cleanName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const encodedName = encodeURIComponent(cleanName);
  res.setHeader(
    'Content-Disposition',
    `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`
  );
}

module.exports = {
  upload,
  IMAGE_MIME,
  AVATAR_MIME,
  setContentDisposition,
  UPLOAD_DIR,
};
