const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { logAdminAudit, clientIp, clientUa } = require('../services/audits');
const { authenticate, isAdmin } = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const router = express.Router();

// User KYC submit — mounted at /api/kyc
router.post(
  '/',
  authenticate,
  upload.fields([
    { name: 'id_card', maxCount: 1 },
    { name: 'id_card_attachment', maxCount: 1 },
    { name: 'address_verification', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const b = req.body || {};
      const files = req.files || {};
      const idFile =
        (files.id_card && files.id_card[0]) ||
        (files.id_card_attachment && files.id_card_attachment[0]) ||
        null;
      const addrFile =
        (files.address_verification && files.address_verification[0]) || null;

      const toDataUrl = (file) => {
        if (!file || !file.buffer) return null;
        const mime = file.mimetype || 'image/jpeg';
        return `data:${mime};base64,${file.buffer.toString('base64')}`;
      };

      const idCardImage = toDataUrl(idFile);
      const addressImage = toDataUrl(addrFile);

      if (!b.full_name || String(b.full_name).trim() === '') {
        return res.status(400).json({ error: 'Full name is required' });
      }

      const result = await pool.query(
        `INSERT INTO kyc_submissions (
          user_id, full_name, gender, marital_status, date_of_birth,
          mode_of_verification, address, city, state, country, zip_code,
          proof_of_address, id_card_image, address_image, status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',NOW())
        RETURNING id, status, created_at`,
        [
          req.userId,
          b.full_name || null,
          b.gender || null,
          b.marital_status || null,
          b.date_of_birth || null,
          b.mode_of_verification || null,
          b.address || null,
          b.city || null,
          b.state || null,
          b.country || null,
          b.zip_code || null,
          b.proof_of_address || null,
          idCardImage,
          addressImage
        ]
      );

      await logAdminAudit({
        adminId: req.userId,
        action: 'kyc_submit',
        targetUserId: req.userId,
        details: { kyc_id: result.rows[0].id },
        ip: clientIp(req),
        userAgent: clientUa(req)
      });

      res.json({
        success: true,
        message: 'your Information was successful please wait while your identity is being verified',
        id: result.rows[0].id,
        has_id_card: !!idCardImage,
        has_address_image: !!addressImage
      });
    } catch (err) {
      console.error('KYC error:', err);
      res.status(500).json({ error: err.message || 'Failed to submit KYC. Please try again.' });
    }
  }
);

// Admin KYC routes — mounted under /api/admin/kyc via separate export or same file
const adminRouter = express.Router();

adminRouter.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT k.id, k.user_id, k.full_name, k.gender, k.marital_status, k.date_of_birth,
              k.mode_of_verification, k.address, k.city, k.state, k.country, k.zip_code,
              k.proof_of_address, k.status, k.created_at,
              u.email as user_email,
              CASE WHEN k.id_card_image IS NOT NULL THEN true ELSE false END as has_id_card,
              CASE WHEN k.address_image IS NOT NULL THEN true ELSE false END as has_address_image
       FROM kyc_submissions k
       LEFT JOIN users u ON u.id = k.user_id
       ORDER BY k.created_at DESC
       LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch KYC list' });
  }
});

adminRouter.get('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT k.*, u.email as user_email, u.full_name as user_full_name
       FROM kyc_submissions k
       LEFT JOIN users u ON u.id = k.user_id
       WHERE k.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch KYC' });
  }
});

adminRouter.post('/:id/status', authenticate, isAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const result = await pool.query(
      `UPDATE kyc_submissions SET status = $1 WHERE id = $2
       RETURNING id, user_id, status`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    if (status === 'approved' && result.rows[0].user_id) {
      await pool.query(
        'UPDATE users SET is_verified = true WHERE id = $1',
        [result.rows[0].user_id]
      );
    }

    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

module.exports = router;
module.exports.adminRouter = adminRouter;
