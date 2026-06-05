const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments.production,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// Simple in-memory store (resets on server restart)
// For multiple users, replace with a database like Supabase
const userStore = {};

// Create a link token so the Plaid popup can open
app.post("/api/create-link-token", async (req, res) => {
  try {
    const userId = req.body.userId || "default-user";
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: "Petal Finance",
      products: ["transactions"],
      country_codes: ["CA"],
      language: "en",
      webhook: `${process.env.WEBHOOK_URL || "https://petal-finance-backend.onrender.com"}/webhook`,
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

// Exchange public token for access token
app.post("/api/exchange-token", async (req, res) => {
  try {
    const { public_token, userId = "default-user" } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    // Store access token for this user
    userStore[userId] = { access_token, status: "pending", transactions: [] };
    res.json({ access_token, status: "pending" });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

// Webhook endpoint — Plaid calls this when transactions are ready
app.post("/webhook", async (req, res) => {
  const { webhook_type, webhook_code, item_id } = req.body;
  console.log(`Webhook received: ${webhook_type} / ${webhook_code}`);

  if (
    webhook_type === "TRANSACTIONS" &&
    (webhook_code === "INITIAL_UPDATE" || webhook_code === "HISTORICAL_UPDATE" || webhook_code === "DEFAULT_UPDATE")
  ) {
    // Find the user with this item
    const userId = Object.keys(userStore).find(async (uid) => {
      try {
        const itemRes = await plaidClient.itemGet({ access_token: userStore[uid].access_token });
        return itemRes.data.item.item_id === item_id;
      } catch { return false; }
    });

    if (userId && userStore[userId]) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const response = await plaidClient.transactionsGet({
          access_token: userStore[userId].access_token,
          start_date: ninetyDaysAgo,
          end_date: today,
        });
        userStore[userId].transactions = response.data.transactions;
        userStore[userId].status = "ready";
        console.log(`Transactions ready for user ${userId}`);
      } catch (err) {
        console.error("Error fetching transactions on webhook:", err.response?.data || err.message);
      }
    }
  }
  res.json({ received: true });
});

// Check transaction status — app polls this after connecting
app.post("/api/transaction-status", async (req, res) => {
  try {
    const { access_token, userId = "default-user" } = req.body;

    // Check if webhook already delivered transactions
    if (userStore[userId]?.status === "ready" && userStore[userId].transactions.length > 0) {
      return res.json({ status: "ready", transactions: userStore[userId].transactions });
    }

    // Try fetching directly (works if transactions are ready)
    const today = new Date().toISOString().slice(0, 10);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await plaidClient.transactionsGet({
      access_token,
      start_date: ninetyDaysAgo,
      end_date: today,
    });

    const transactions = response.data.transactions;
    if (transactions.length > 0) {
      if (userStore[userId]) {
        userStore[userId].transactions = transactions;
        userStore[userId].status = "ready";
      }
      return res.json({ status: "ready", transactions });
    }

    res.json({ status: "pending", transactions: [] });
  } catch (err) {
    const errData = err.response?.data;
    if (errData?.error_code === "PRODUCT_NOT_READY") {
      return res.json({ status: "pending", transactions: [] });
    }
    console.error(errData || err.message);
    res.status(500).json({ error: "Failed to check transaction status" });
  }
});

// Fetch account balances
app.post("/api/balances", async (req, res) => {
  try {
    const { access_token } = req.body;
    const response = await plaidClient.accountsBalanceGet({ access_token });
    res.json({ accounts: response.data.accounts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch balances" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
