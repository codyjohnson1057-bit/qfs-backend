require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/user');
const walletsRoutes = require('./src/routes/wallets');
const transactionsRoutes = require('./src/routes/transactions');
const notificationsRoutes = require('./src/routes/notifications');
const kycRoutes = require('./src/routes/kyc');
const adminRoutes = require('./src/routes/admin');
const cardsRoutes = require('./src/routes/cards');
const { getFiatRates, FALLBACK_FIAT } = require('./src/services/rates');
const paymentsRoutes = require('./src/routes/payments');
const vaultsRoutes = require('./src/routes/vaults');
const swapRoutes = require('./src/routes/swap');

const app = express();

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://localhost:5501',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501',
    'https://qfsqfsqfs.web.app',
    'https://web-production-8f747.up.railway.app',

  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

const PORT = process.env.PORT || 5000;

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.use('/api', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/wallets', walletsRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/cards', cardsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/vaults', vaultsRoutes);
app.use('/api/swap', swapRoutes);

app.get('/api/rates/fx', async (req, res) => {
  try {
    const force = String(req.query.refresh || '') === '1';
    const data = await getFiatRates(force);
    res.json({
      base: 'USD',
      rates: data.rates || FALLBACK_FIAT,
      source: data.source,
      fetched_at: data.fetchedAt ? new Date(data.fetchedAt).toISOString() : null,
      cached: !!data.cached
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch FX rates', rates: FALLBACK_FIAT, source: 'fallback' });
  }
});


// Nested admin features (mount before /api/admin catch-all for clarity)
app.use('/api/admin/kyc', kycRoutes.adminRouter);
app.use('/api/admin/payments', paymentsRoutes.adminRouter);
app.use('/api/admin/swaps', swapRoutes.adminRouter);
app.use('/api/admin/users/:id/vaults', vaultsRoutes.adminUserVaultsRouter);
app.use('/api/admin/users/:id/cards/activate', cardsRoutes.adminActivateRouter);
app.use('/api/admin/users/:id/cards/reject', cardsRoutes.adminRejectRouter);
app.use('/api/admin/users/:id/cards', cardsRoutes.adminCardsRouter);

app.use('/api/admin', adminRoutes);

module.exports = app;

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}
