// billing-routes.js - Rotas de billing/pagamento para ClipMind

const express = require('express');
const { 
  createCheckoutPreference, 
  handleMercadoPagoWebhook,
  getUserSubscriptionStatus,
  cancelSubscription 
} = require('./mercado-pago');

const router = express.Router();

// Middleware de autenticação
const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Aqui você validaria o token (usar supabase auth ou JWT)
    // Por enquanto, apenas extrair user_id
    req.user_id = req.body.user_id || token.split(':')[0];
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================
// POST /api/billing/checkout
// ============================================
// Criar preferência de pagamento (redirecionar user pro MP)

router.post('/checkout', authenticateUser, async (req, res) => {
  try {
    const { plan_id, user_email } = req.body;
    const user_id = req.user_id;

    if (!plan_id || !user_email) {
      return res.status(400).json({ error: 'Missing plan_id or user_email' });
    }

    const result = await createCheckoutPreference(user_id, plan_id, user_email);

    if (result.redirect_url) {
      // Free plan
      return res.json(result);
    }

    // Paid plan - retornar link do Mercado Pago
    res.json({
      success: true,
      preference_id: result.preference_id,
      checkout_url: result.init_point,
    });
  } catch (error) {
    console.error(`[BILLING] Checkout error: ${error.message}`);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

// ============================================
// POST /api/webhooks/mercado-pago
// ============================================
// Webhook do Mercado Pago (notificação de pagamento)

router.post('/mercado-pago', async (req, res) => {
  try {
    // Validar webhook secret (opcional mas recomendado)
    const signature = req.headers['x-signature'];
    const requestId = req.headers['x-request-id'];

    // Processar webhook
    const result = await handleMercadoPagoWebhook(req.body);

    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error(`[WEBHOOK] Error: ${error.message}`);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================
// GET /api/billing/status
// ============================================
// Verificar status da subscription do user

router.get('/status', authenticateUser, async (req, res) => {
  try {
    const user_id = req.user_id;
    const status = await getUserSubscriptionStatus(user_id);

    res.json(status);
  } catch (error) {
    console.error(`[BILLING] Status error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// ============================================
// POST /api/billing/cancel
// ============================================
// Cancelar subscription

router.post('/cancel', authenticateUser, async (req, res) => {
  try {
    const user_id = req.user_id;

    const result = await cancelSubscription(user_id);

    res.json(result);
  } catch (error) {
    console.error(`[BILLING] Cancel error: ${error.message}`);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
