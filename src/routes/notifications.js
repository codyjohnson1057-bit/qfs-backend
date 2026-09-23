const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, message, is_read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.post('/:id/read', authenticate, async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT id FROM notifications WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

module.exports = router;
