const mongoose = require('mongoose');
const GridFSBucket = mongoose.mongo.GridFSBucket;
const path = require('path');
const mime = require('mime-types');
const crypto = require('crypto');

const BUCKET_NAME = 'uploads';

async function ensureMongoConnected(timeoutMs = 7000) {
  if (mongoose.connection?.db) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MongoDB not connected')), timeoutMs);
    mongoose.connection.once('open', () => { clearTimeout(timer); resolve(); });
  });
}

function getBucket(req) {
  const viaApp = req?.app?.get && req.app.get('gridfsBucket');
  if (viaApp) return viaApp;
  if (!mongoose.connection?.db) throw new Error('MongoDB connection is not ready');
  return new GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildFilename(originalName = '', prefix = 'file', mimetype = '', forceMimeExt = false) {
  const extFromMime = mime.extension(mimetype || '') ? `.${mime.extension(mimetype)}` : '';
  const extFromOriginal = path.extname(originalName || '');
  const ext = forceMimeExt ? (extFromMime || extFromOriginal || '.bin') : (extFromOriginal || extFromMime || '.bin');
  const stamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const prefixPart = prefix ? `${prefix}_` : '';
  return `${prefixPart}${stamp}_${random}${ext}`;
}

function baseUrlFromReq(req) {
  if (!req) return null;
  const xfProto = req.headers?.['x-forwarded-proto'];
  const xfHost  = req.headers?.['x-forwarded-host'];
  const xfPort  = req.headers?.['x-forwarded-port'];
  const host    = xfHost || (typeof req.get === 'function' ? req.get('host') : req.headers?.host);
  const proto   = xfProto || req.protocol || 'http';
  if (!host) return null;
  const needsPort = xfPort && !host.includes(':');
  const fullHost = needsPort ? `${host}:${xfPort}` : host;
  return `${proto}://${fullHost}`;
}

function buildFileUrl(source, filename) {
  if (!filename) return '';
  const encoded = encodeURIComponent(filename);
  if (!source) return `/file/${encoded}`;
  if (typeof source === 'string') {
    const trimmed = source.replace(/\/$/, '');
    return `${trimmed}/file/${encoded}`;
  }
  const base = baseUrlFromReq(source);
  return base ? `${base}/file/${encoded}` : `/file/${encoded}`;
}

async function uploadToGridFS(files, options = {}) {
  const arr = Array.isArray(files) ? files.filter(Boolean) : (files ? [files] : []);
  if (!arr.length) return [];

  await ensureMongoConnected();
  const bucket = getBucket(options.req);

  const results = [];
  for (const file of arr) {
    const filename = buildFilename(file.originalname, options.prefix, file.mimetype);
    const digest = sha256(file.buffer);
    const metadata = { originalName: file.originalname, sha256: digest, ...(options.metadata || {}) };
    const contentType = file.mimetype || options.defaultMimeType || 'application/octet-stream';

    const { id } = await new Promise((resolve, reject) => {
      const upload = bucket.openUploadStream(filename, { contentType, metadata });
      upload.once('finish', () => resolve({ id: upload.id }));
      upload.once('error', reject);
      upload.end(file.buffer);
    });

    results.push({
      id: String(id),
      filename,
      originalName: file.originalname,
      mimeType: contentType,
      size: typeof file.size === 'number' ? file.size : (file.buffer?.length || 0),
      url: buildFileUrl(options.req, filename),
    });
  }
  return results;
}

async function deleteGridFsFiles(ids = [], opts = {}) {
  const arr = Array.isArray(ids) ? ids : [ids];
  if (!arr.length) return;
  await ensureMongoConnected();
  const bucket = getBucket(opts.req);
  for (const id of arr) {
    if (!id) continue;
    try {
      const objectId = new mongoose.Types.ObjectId(String(id));
      await bucket.delete(objectId);
    } catch (err) {
      console.warn('Failed to delete GridFS file', id, err.message);
    }
  }
}

async function deleteByFilenames(filenames = [], opts = {}) {
  const arr = Array.isArray(filenames) ? filenames.filter(Boolean) : [filenames].filter(Boolean);
  if (!arr.length) return;
  await ensureMongoConnected();
  const bucket = getBucket(opts.req);
  const files = await bucket.find({ filename: { $in: arr } }).toArray();
  for (const f of files) {
    try { await bucket.delete(f._id); } catch (e) { /* noop */ }
  }
}

async function getFileMetaById(id, opts = {}) {
  await ensureMongoConnected();
  const bucket = getBucket(opts.req);
  const _id = new mongoose.Types.ObjectId(String(id));
  const [file] = await bucket.find({ _id }).toArray();
  return file || null;
}

module.exports = {
  uploadToGridFS,
  ensureMongoConnected,
  getBucket,
  buildFileUrl,
  deleteGridFsFiles,
  deleteByFilenames,
  getFileMetaById,
};